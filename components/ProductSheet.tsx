
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Product, DatasheetChange, ProductImage, WarehouseBin, EbayCategoryOption } from '../types';
import {
  saveProduct,
  syncToBaseLinker,
  openSkuLabelWindow,
  printSkuLabel,
  stockInProduct,
  stockOutProduct,
  fetchProductBins,
  generateProductImages,
  createQualityJobs,
  pollQualityJob,
  fetchProductById,
  setProductInventoryId,
  openInventoryLabelWindow,
  fetchEbayCategories,
  verifyEbayPublish,
  publishToEbay,
} from '../api/client';
import { EditIcon, SaveIcon, SyncIcon, PrintIcon, MagicIcon, RefreshIcon, BarcodeIcon } from './icons/Icons';
import { Spinner } from './Spinner';
import ImageGallery from './ImageGallery';
import AttributeTable from './AttributeTable';
import PricingInfo from './PricingInfo';
import AssistantChat from './GeminiChat';
import { useI18n } from '../i18n';
import { normalizeBarcode, summarizeBarcodes, isValidGtin } from '../utils/gtin';
import {
  getProductBaselinkerCategoryPath,
  getProductDisplayCategory,
  getProductEbayCategoryId,
  getProductEbayCategoryPath,
} from '../utils/product';
import { useInventoryContext } from '../context/InventoryContext';

interface ProductSheetProps {
  product: Product;
  onUpdate: (updatedProduct: Product) => void;
  onImprove?: (productId: string) => void;
  isImproving?: boolean;
}

const GENERATED_IMAGE_PATTERN = /(generated|gpt|gemini|ai[-\s]?image|ai[-\s]?render|ai[-\s]?derived)/i;

const isGeneratedImageMeta = (image?: ProductImage) => {
  if (!image) return false;
  const source = (image.source || '').toLowerCase();
  const notes = (image.notes || '').toLowerCase();
  return GENERATED_IMAGE_PATTERN.test(source) || GENERATED_IMAGE_PATTERN.test(notes);
};

// We allow "trusted" AI images produced by our own pipeline (Gemini/Vertex/ai-derived),
// but still block unknown placeholder-like AI images from being appended unintentionally.
const isTrustedAiImage = (image?: ProductImage) => {
  if (!image) return false;
  const source = (image.source || '').toLowerCase();
  const notes = (image.notes || '').toLowerCase();
  return (
    source.includes('ai-derived') ||
    source.includes('vertex') ||
    /gemini/.test(source) ||
    /gemini/.test(notes) ||
    /vertex/.test(notes)
  );
};

const filterReferenceCandidates = (images: ProductImage[] = []) =>
  images.filter((image) => !isGeneratedImageMeta(image));

const ProductSheet: React.FC<ProductSheetProps> = ({ product, onUpdate, onImprove, isImproving }) => {
  const { t } = useI18n();
  const {
    inventories,
    syncInventories: syncInventoryList,
    syncing: inventorySyncing,
    setActiveInventoryId,
    resolveInventory,
  } = useInventoryContext();
  const [isEditing, setIsEditing] = useState(false);
  const normalizeProduct = useCallback(
    (input: Product): Product => {
      // Normalize legacy GPSR attributes into structured details.gpsr (backend now stores GPSR there).
      // This prevents redundant attribute rows like "GPSR Manufacturer name" duplicating "Marke".
      const next: Product = JSON.parse(JSON.stringify(input));
      const attrs = next?.details?.attributes && typeof next.details.attributes === 'object' ? next.details.attributes : {};
      const gpsr = next?.details?.gpsr && typeof next.details.gpsr === 'object' ? { ...next.details.gpsr } : {};

      for (const [rawKey, rawVal] of Object.entries(attrs)) {
        const key = String(rawKey || '').trim();
        const keyLower = key.toLowerCase();
        if (!keyLower.startsWith('gpsr ')) continue;

        const value =
          rawVal === null || rawVal === undefined ? '' : typeof rawVal === 'string' ? rawVal.trim() : String(rawVal).trim();
        // Always remove from attributes to avoid duplicates in UI.
        delete (attrs as any)[rawKey];
        if (!value) continue;

        if (keyLower.includes('manufacturer') && keyLower.includes('name')) {
          if (!gpsr.manufacturer_name) gpsr.manufacturer_name = value;
          continue;
        }
        if (
          keyLower.includes('manufacturer') &&
          (keyLower.includes('address') || keyLower.includes('adresse'))
        ) {
          if (!gpsr.manufacturer_address) gpsr.manufacturer_address = value;
          continue;
        }
        if (keyLower.includes('email') || keyLower.includes('e-mail')) {
          if (!gpsr.email) gpsr.email = value;
          continue;
        }
        if (keyLower.includes('url') || keyLower.includes('website') || keyLower.includes('webseite')) {
          if (!gpsr.url) gpsr.url = value;
          continue;
        }
      }

      if (Object.keys(gpsr).length) {
        next.details = next.details || ({} as any);
        next.details.gpsr = gpsr;
      }
      if (next.details) {
        next.details.attributes = attrs as any;
      }
      return next;
    },
    []
  );
  const [localProduct, setLocalProduct] = useState<Product>(() => normalizeProduct(product));
  // Keep stable refs to avoid losing last-moment edits (e.g. blur updates) when clicking "Save".
  const latestProductRef = useRef<Product>(localProduct);
  latestProductRef.current = localProduct;
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isPublishingEbay, setIsPublishingEbay] = useState(false);
  const [ebayPublishStatus, setEbayPublishStatus] = useState<'idle' | 'verifying' | 'publishing' | 'done'>('idle');
  const [isDirty, setIsDirty] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [autoGenDone, setAutoGenDone] = useState(false);
  const [isPrintingLabel, setIsPrintingLabel] = useState(false);
  const [binCodeInput, setBinCodeInput] = useState(product.storage?.binCode || '');
  // For multi-BIN: this input is a delta (stock-in/out), not the total product quantity.
  const [binQuantity, setBinQuantity] = useState<number>(1);
  const [isAssigningBin, setIsAssigningBin] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [productBins, setProductBins] = useState<WarehouseBin[]>([]);
  const [binsLoading, setBinsLoading] = useState(false);

  const [binsError, setBinsError] = useState<string | null>(null);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [qualityMessage, setQualityMessage] = useState<string | null>(null);
  const [isGeneratingImages, setIsGeneratingImages] = useState(false);
  const [selectedReferenceIndex, setSelectedReferenceIndex] = useState<number>(-1);
  const [isUploadDragActive, setIsUploadDragActive] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState<string>(() => (product.identification?.barcodes || []).join('\n'));
  const latestBarcodeInputRef = useRef<string>(barcodeInput);
  latestBarcodeInputRef.current = barcodeInput;
  const [categoryQuery, setCategoryQuery] = useState('');
  const [categoryQueryDebounced, setCategoryQueryDebounced] = useState('');
  const [categoryOptions, setCategoryOptions] = useState<EbayCategoryOption[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const [assigningInventory, setAssigningInventory] = useState(false);
  const [inventoryMessage, setInventoryMessage] = useState<string | null>(null);
  const [syncInventoryId] = useState('78659');
  const prevProductIdRef = useRef(product.id);

  const updateGpsrField = useCallback((key: string, value: string) => {
    setLocalProduct((prev) => ({
      ...prev,
      details: {
        ...(prev.details || ({} as any)),
        gpsr: {
          ...(((prev.details || ({} as any)).gpsr || {}) as any),
          [key]: value,
        },
      },
    }));
    setIsDirty(true);
  }, []);

  const parseBarcodes = useCallback((input: string) => {
    const entries = input
      .split(/[\n,;]+/)
      .map((value) => normalizeBarcode(value.trim()))
      .filter(Boolean);
    return Array.from(new Set(entries));
  }, []);
  const currentBarcodeSummary = useMemo(
    () => summarizeBarcodes(localProduct.identification?.barcodes || []),
    [localProduct.identification?.barcodes]
  );
  const editingBarcodeSummary = useMemo(
    () => summarizeBarcodes(parseBarcodes(barcodeInput)),
    [barcodeInput, parseBarcodes]
  );

  const loadProductBins = useCallback(
    async (productId: string) => {
      setBinsLoading(true);
      setBinsError(null);
      try {
        const bins = await fetchProductBins(productId);
        setProductBins(bins);
      } catch (error: any) {
        setBinsError(error?.message || t('sheet.msg.binsLoadError'));
        setProductBins([]);
      } finally {
        setBinsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const isSameProduct = product.id === prevProductIdRef.current;
    // Wenn derselbe Datensatz während Bearbeitung/Generierung neu geliefert wird:
    // nicht hart zurücksetzen, sonst brechen Edit- und AI-Flows ab.
    if (isSameProduct && (isEditing || isDirty || isGeneratingImages)) {
      return;
    }

    prevProductIdRef.current = product.id;
    setLocalProduct(normalizeProduct(product));
    setIsEditing(false);
    // New products should be marked as dirty so they can be saved immediately
    setIsDirty(!product.ops?.last_saved_iso);
    setAutoGenDone(false);
    setBinCodeInput(product.storage?.binCode || '');
    // binQuantity is a delta for stockIn/stockOut (multi-BIN), so default to 1.
    setBinQuantity(1);
    setNewImageUrl('');
    loadProductBins(product.id);
    setBarcodeInput((product.identification?.barcodes || []).join('\n'));
  }, [product, loadProductBins, normalizeProduct, isDirty, isEditing, isGeneratingImages]);

  const gpsr = (localProduct?.details?.gpsr || {}) as any;
  const hasAnyGpsr = useMemo(() => {
    return Object.values(gpsr || {}).some((v) => typeof v === 'string' && v.trim().length > 0);
  }, [gpsr]);

  // Falls Storage leer, aber Bins vorhanden: erste Bin übernehmen, damit Remove-Button und Anzeige stimmen
  useEffect(() => {
    if (binsLoading) return;
    if (!productBins.length) return;
    const primary = productBins[0];
    if (!primary?.code) return;
    if (!localProduct.storage?.binCode) {
      const qty = primary.quantity ?? primary.productCount ?? localProduct.storage?.quantity ?? 1;
      setLocalProduct((prev) => ({
        ...prev,
        storage: {
          ...(prev.storage || {}),
          binCode: primary.code,
          quantity: qty,
          zone: primary.zone,
          etage: primary.etage,
          gang: primary.gang,
          regal: primary.regal,
          ebene: primary.ebene,
        },
      }));
      setBinCodeInput(primary.code);
      // delta input
      setBinQuantity(1);
    }
  }, [binsLoading, productBins, localProduct.storage?.binCode]);

  useEffect(() => {}, []);

  useEffect(() => {
    if (!isEditing) return;
    const current = getProductEbayCategoryPath(localProduct);
    setCategoryQuery((prev) => prev || String(current || ''));
  }, [
    isEditing,
    localProduct.details?.categoryId,
    localProduct.identification?.category,
  ]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setCategoryQueryDebounced(categoryQuery.trim());
    }, 200);
    return () => clearTimeout(handle);
  }, [categoryQuery]);

  useEffect(() => {
    if (!isEditing) return;
    const query = categoryQueryDebounced;
    const params: { query?: string; id?: string; limit?: number; leafOnly?: boolean } = {
      limit: 60,
      leafOnly: true,
    };
    if (query.length >= 2) params.query = query;
    if (localProduct.details?.categoryId) {
      params.id = String(localProduct.details.categoryId);
    }
    if (!params.query && !params.id) {
      setCategoryOptions([]);
      setCategoryError(null);
      setCategoryLoading(false);
      return;
    }
    let active = true;
    setCategoryLoading(true);
    setCategoryError(null);
    fetchEbayCategories(params)
      .then((items) => {
        if (!active) return;
        setCategoryOptions(items);
      })
      .catch((error: any) => {
        if (!active) return;
        setCategoryOptions([]);
        setCategoryError(error?.message || 'Kategorien konnten nicht geladen werden.');
      })
      .finally(() => {
        if (!active) return;
        setCategoryLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isEditing, categoryQueryDebounced, localProduct.details?.categoryId]);

  const referenceImages = useMemo(
    () => filterReferenceCandidates(localProduct.details?.images || []),
    [localProduct.details?.images]
  );

  useEffect(() => {
    if (referenceImages.length) {
      setSelectedReferenceIndex(0);
    } else {
      setSelectedReferenceIndex(-1);
    }
  }, [product.id, referenceImages.length]);

  const selectedReferenceImage =
    selectedReferenceIndex >= 0 ? referenceImages[selectedReferenceIndex] : null;

  const updateImages = useCallback((mutator: (images: ProductImage[]) => ProductImage[]) => {
    setLocalProduct(prev => {
      const currentImages = prev.details?.images || [];
      const nextImages = mutator([...currentImages]);
      return {
        ...prev,
        details: {
          ...prev.details,
          images: nextImages,
        },
      };
    });
    setIsDirty(true);
  }, []);

  const handleReorderImages = useCallback(
    (fromIndex: number, toIndex: number) => {
      updateImages((images) => {
        const boundedFrom = Math.max(0, Math.min(images.length - 1, fromIndex));
        const boundedTo = Math.max(0, Math.min(images.length - 1, toIndex));
        if (boundedFrom === boundedTo) return images;
        const [moved] = images.splice(boundedFrom, 1);
        images.splice(boundedTo, 0, moved);
        return images;
      });
    },
    [updateImages]
  );

  const handleDeleteImage = useCallback(
    (index: number) => {
      updateImages((images) => {
        images.splice(index, 1);
        return images;
      });
    },
    [updateImages]
  );

  const handleUpdateImage = useCallback(
    (index: number, next: ProductImage) => {
      updateImages((images) => {
        if (index < 0 || index >= images.length) return images;
        images[index] = next;
        return images;
      });
    },
    [updateImages]
  );

  const handleAddImageFromUrl = useCallback(() => {
    const url = newImageUrl.trim();
    if (!url) return;
    updateImages((images) => [
      ...images,
      { source: 'web', variant: 'other', url_or_base64: url, notes: t('sheet.upload.note.manual') },
    ]);
    setNewImageUrl('');
  }, [newImageUrl, updateImages]);

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const handleUploadImage = useCallback(
    async (file: File) => {
      if (!file) return;
      try {
        const base64 = await fileToBase64(file);
        updateImages((images) => [
          ...images,
          { source: 'upload', variant: 'other', url_or_base64: base64, notes: file.name || t('sheet.upload.note.upload') },
        ]);
      } catch (error) {
        console.error('Failed to read image file', error);
      }
    },
    [updateImages]
  );

  const handleUploadImages = useCallback(
    async (fileList: FileList | File[] | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.isArray(fileList) ? fileList : Array.from(fileList);
      for (const file of files) {
        // eslint-disable-next-line no-await-in-loop
        await handleUploadImage(file);
      }
    },
    [handleUploadImage]
  );

  const handleUploadDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsUploadDragActive(true);
  }, []);

  const handleUploadDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsUploadDragActive(false);
  }, []);

  const handleUploadDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsUploadDragActive(false);
      const files = event.dataTransfer?.files;
      if (files?.length) {
        handleUploadImages(files);
      }
    },
    [handleUploadImages]
  );

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  // NO AUTO-GENERATION - user must click "Generate Images" button manually

  const handleGenerateImages = async () => {
    if (!localProduct.id) return;
    if (!selectedReferenceImage) {
      showNotification('error', t('sheet.msg.referenceRequired'));
      return;
    }
    setIsGeneratingImages(true);
    showNotification('success', t('sheet.msg.vertexStart'));

    const result = await generateProductImages(localProduct.id, selectedReferenceImage, {
      sampleCount: 1,
      product: localProduct,
    });

    if (result.ok && result.data) {
      updateImages((images) => [...images, ...(result.data || [])]);
      showNotification('success', t('sheet.msg.vertexSuccess', { count: result.data?.length || 0 }));
    } else {
      showNotification('error', result.error?.message || t('sheet.msg.vertexError'));
    }
    setIsGeneratingImages(false);
  };

  const handleInventoryAssign = useCallback(
    async (inventoryId: string) => {
      if (!inventoryId || inventoryId === localProduct.inventory?.inventoryId) {
        return;
      }
      setAssigningInventory(true);
      setInventoryMessage(null);
      try {
        await setProductInventoryId(localProduct.id, inventoryId);
        const resolved =
          inventories.find((inv) => inv.inventoryId === inventoryId) ||
          (await resolveInventory(inventoryId));
        const updatedProduct: Product = {
          ...localProduct,
          inventory: {
            ...(localProduct.inventory || {}),
            inventoryId,
            inventoryName: resolved?.name || localProduct.inventory?.inventoryName || null,
          },
        };
        setLocalProduct(updatedProduct);
        onUpdate(updatedProduct);
        setInventoryMessage(t('sheet.inventory.assignSuccess'));
      } catch (error: any) {
        console.error('Inventory assignment failed:', error);
        setInventoryMessage(error?.message || t('sheet.inventory.assignError'));
      } finally {
        setAssigningInventory(false);
      }
    },
    [localProduct, inventories, onUpdate, resolveInventory, t]
  );

  const handleInventoryLabel = useCallback(() => {
    const inventoryId = localProduct.inventory?.inventoryId;
    if (!inventoryId) {
      showNotification('error', t('sheet.inventory.printError'));
      return;
    }
    const result = openInventoryLabelWindow(inventoryId);
    if (!result.ok) {
      showNotification('error', result.error?.message || t('sheet.inventory.printError'));
    }
  }, [localProduct.inventory?.inventoryId, showNotification, t]);

  const performSave = useCallback(async () => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    setIsSaving(true);

    try {
      // Snapshot AFTER blur-based updates have had a chance to commit.
      const baseProduct = latestProductRef.current;
      const parsedBarcodes = parseBarcodes(latestBarcodeInputRef.current);
      const productToSave: Product = {
        ...baseProduct,
        identification: {
          ...(baseProduct.identification || {}),
          barcodes: parsedBarcodes,
        },
      };

      setLocalProduct(productToSave);
      const result = await saveProduct(productToSave);
      if (result.ok && result.data) {
        const assignedSku =
          result.data.sku ||
          productToSave.identification.sku ||
          productToSave.details.identifiers?.sku ||
          null;
        const updatedProduct: Product = {
          ...productToSave,
          identification: {
            ...productToSave.identification,
            sku: assignedSku || productToSave.identification.sku,
          },
          details: {
            ...productToSave.details,
            identifiers: {
              ...(productToSave.details.identifiers || {}),
              sku: assignedSku || productToSave.details.identifiers?.sku || undefined,
            },
          },
          ops: {
            ...productToSave.ops,
            revision: result.data.revision,
            last_saved_iso: new Date().toISOString(),
          },
        };
        const normalized = normalizeProduct(updatedProduct);
        setLocalProduct(normalized);
        onUpdate(normalized);
        setIsEditing(false);
        setIsDirty(false);
        setBarcodeInput((normalized.identification?.barcodes || []).join('\n'));
        showNotification('success', t('sheet.msg.saveSuccess'));
      } else {
        showNotification('error', result.error?.message || t('sheet.msg.saveError'));
      }
    } finally {
      setIsSaving(false);
      isSavingRef.current = false;
    }
  }, [normalizeProduct, onUpdate, parseBarcodes, showNotification, t]);

  const handleSave = () => {
    // Critical: inputs in this sheet commit changes onBlur (attributes, K-Typ, description, highlights).
    // Clicking "Save" triggers blur + click in the same tick, so state updates may not be applied yet.
    // Defer the save to the next tick so blur updates are committed before snapshotting the product.
    setTimeout(() => {
      void performSave();
    }, 0);
  };
  const handlePrintLabel = () => {
    if (!localProduct?.id) return;
    setIsPrintingLabel(true);
    // Popup-free print path (works even when popups are blocked).
    void printSkuLabel(localProduct.id).then((result) => {
      if (!result.ok) {
        // Fallback: try opening a new tab (may still be blocked by browser settings).
        const fallback = openSkuLabelWindow(localProduct.id);
        if (!fallback.ok) {
          showNotification('error', result.error?.message || fallback.error?.message || t('sheet.msg.labelError'));
        } else {
          showNotification('success', t('sheet.msg.labelSuccess'));
        }
      } else {
        showNotification('success', t('sheet.msg.labelSuccess'));
      }
      setIsPrintingLabel(false);
    });
  };

  const handleAssignBin = async () => {
    if (!binCodeInput) {
      showNotification('error', t('sheet.msg.binRequired'));
      return;
    }
    setIsAssigningBin(true);
    const result = await stockInProduct({
      productId: localProduct.id,
      binCode: binCodeInput.toUpperCase(),
      quantity: Number(binQuantity) || 1,
      meta: { flow: 'product-sheet', action: 'stock-in' },
    });
    if (result.ok && result.data?.product) {
      const normalized = normalizeProduct(result.data.product);
      setLocalProduct(normalized);
      onUpdate(normalized);
      setBinCodeInput(binCodeInput.toUpperCase());
      setBinQuantity(1);
      loadProductBins(normalized.id);
      showNotification('success', t('sheet.msg.binAssignSuccess'));
    } else {
      showNotification('error', result.error?.message || t('sheet.msg.binAssignError'));
    }
    setIsAssigningBin(false);
  };

  const handleRemoveBin = async () => {
    if (!binCodeInput) {
      showNotification('error', t('sheet.msg.binRequired'));
      return;
    }
    const qty = Number(binQuantity) || 0;
    if (!qty || qty <= 0) {
      showNotification('error', t('sheet.msg.binAssignError'));
      return;
    }
    const response = await stockOutProduct({
      productId: localProduct.id,
      binCode: binCodeInput.toUpperCase(),
      quantity: qty,
      meta: { flow: 'product-sheet', action: 'stock-out' },
    });
    if (!response.ok || !response.data?.product) {
      showNotification('error', response.error?.message || t('sheet.msg.binRemoveError'));
      return;
    }
    const normalized = normalizeProduct(response.data.product);
    setLocalProduct(normalized);
    onUpdate(normalized);
    setBinQuantity(1);
    loadProductBins(localProduct.id);
    showNotification('success', t('sheet.msg.binRemoveSuccess'));
  };

  const applyAssistantChange = (change: DatasheetChange) => {
    console.log('Applying Assistant Change:', change);
    let incomingBarcodes: string[] | null = null;

    const normalizeLower = (v: any) => (v == null ? '' : String(v).trim().toLowerCase());
    const isMarketplaceKey = (key: string) => {
      const k = normalizeLower(key);
      if (!k) return false;
      return k.includes('ebay') || k.includes('kaufland');
    };
    const isBarcodeAttrKey = (key: string) => {
      const k = normalizeLower(key);
      if (!k) return false;
      return (
        k === 'ean' ||
        k === 'gtin' ||
        k === 'upc' ||
        k === 'barcode' ||
        k === 'barcodes' ||
        k === 'ean/gtin' ||
        k.includes('ean') ||
        k.includes('gtin') ||
        k.includes('upc')
      );
    };

    setLocalProduct((prev) => {
      const next = JSON.parse(JSON.stringify(prev)) as Product;

      // 1. Identity / Basic Info
      if (change.identity || change.title) {
        next.identification = next.identification || {};

        // Handle direct title alias
        if (change.title) {
          next.identification.name = change.title;
        }

        // Handle identity object
        if (change.identity) {
          next.identification = {
            ...next.identification,
            ...change.identity,
          };
          // Explicitly ensure name is overwritten if present in identity/title
          if (change.identity.name) {
            next.identification.name = change.identity.name;
          } else if (change.identity.title) {
            next.identification.name = change.identity.title;
          }
          // Explicitly ensure brand is overwritten if present in identity
          if (change.identity.brand) {
            next.identification.brand = change.identity.brand;
          }
        }

        // Handle barcodes merging specifically
        if (change.identity?.barcodes && Array.isArray(change.identity.barcodes)) {
          const merged = new Set([
            ...(next.identification.barcodes || []),
            ...change.identity.barcodes
          ]);
          next.identification.barcodes = Array.from(merged)
            .map(b => normalizeBarcode(String(b)))
            .filter(b => b && isValidGtin(b));
          incomingBarcodes = next.identification.barcodes;
        }
      }

      // 1.5 eBay category (canonical)
      if (change.categoryId || change.categoryPath) {
        next.details = next.details || {};
        next.identification = next.identification || {};
        if (change.categoryId) {
          (next.details as any).categoryId = String(change.categoryId).replace(/\D+/g, '').trim();
        }
        if (change.categoryPath) {
          next.identification.category = String(change.categoryPath).trim();
        }
      }

      // 1.6 BaseLinker category (legacy compatibility)
      if (change.baselinkerCategoryPath || change.baselinkerCategoryId) {
        next.details = next.details || {};
        if (change.baselinkerCategoryPath) {
          (next.details as any).baselinkerCategoryPath = String(change.baselinkerCategoryPath).trim();
        }
        if (change.baselinkerCategoryId) {
          (next.details as any).baselinkerCategoryId = String(change.baselinkerCategoryId).trim();
        }
      }

      // 2. Short Description
      if (change.short_description) {
        next.details = next.details || {};
        next.details.short_description = change.short_description;
      }

      // 3. Key Features
      if (Array.isArray(change.key_features) && change.key_features.length > 0) {
        next.details = next.details || {};
        next.details.key_features = change.key_features;
      }

      // 3.5 GPSR (structured)
      if (change.gpsr && typeof change.gpsr === 'object') {
        next.details = next.details || {};
        next.details.gpsr = {
          ...(next.details.gpsr || {}),
          ...(change.gpsr || {}),
        };
      }

      // 4. Attributes (Merge)
      if (change.attributes && Object.keys(change.attributes).length > 0) {
        next.details = next.details || {};
        const cleanedIncoming: Record<string, any> = {};
        Object.entries(change.attributes).forEach(([key, value]) => {
          if (!key) return;
          // GPSR/compliance keys are stored under details.gpsr (not as regular attributes) to avoid duplicates.
          const keyLowerRaw = String(key || '').trim().toLowerCase();
          if (keyLowerRaw.startsWith('gpsr ')) {
            const v = value === null || value === undefined ? '' : String(value).trim();
            next.details.gpsr = next.details.gpsr || {};
            if (keyLowerRaw.includes('manufacturer') && keyLowerRaw.includes('name') && v) {
              next.details.gpsr.manufacturer_name = v;
              return;
            }
            if (
              keyLowerRaw.includes('manufacturer') &&
              (keyLowerRaw.includes('address') || keyLowerRaw.includes('adresse')) &&
              v
            ) {
              next.details.gpsr.manufacturer_address = v;
              return;
            }
            if ((keyLowerRaw.includes('email') || keyLowerRaw.includes('e-mail')) && v) {
              next.details.gpsr.email = v;
              return;
            }
            if ((keyLowerRaw.includes('url') || keyLowerRaw.includes('website') || keyLowerRaw.includes('webseite')) && v) {
              next.details.gpsr.url = v;
              return;
            }
            // Unknown GPSR-* key -> ignore for now (kept server-side in attributes_extra if needed).
            return;
          }
          // Never allow marketplace-specific attributes.
          if (isMarketplaceKey(key)) return;
          // Never store barcode identifiers as regular attributes; move them into barcodes.
          if (isBarcodeAttrKey(key)) {
            const digits = normalizeBarcode(String(value ?? ''));
            if (digits && isValidGtin(digits)) {
              next.identification = next.identification || {};
              const merged = new Set([...(next.identification.barcodes || []), digits]);
              next.identification.barcodes = Array.from(merged);
              incomingBarcodes = next.identification.barcodes;
            }
            return;
          }
          cleanedIncoming[key] = value as any;
        });
        next.details.attributes = {
          ...next.details.attributes,
          ...cleanedIncoming,
        };
      }

      // 5. Pricing
      if (change.pricing) {
        next.details = next.details || {};
        next.details.pricing = {
          ...next.details.pricing,
          ...change.pricing,
          lowest_price: {
            ...(next.details.pricing?.lowest_price || {}),
            ...(change.pricing.lowest_price || {}),
          },
        };
      }

      // 6. Notes
      if (change.notes) {
        const mergeUnique = (a: any, b: any) => {
          const left = Array.isArray(a) ? a : [];
          const right = Array.isArray(b) ? b : [];
          const out: string[] = [];
          const seen = new Set<string>();
          for (const item of [...left, ...right]) {
            const s = item == null ? '' : String(item).trim();
            if (!s) continue;
            const key = s.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(s);
          }
          return out;
        };
        next.notes = {
          unsure: mergeUnique(next.notes?.unsure, change.notes.unsure),
          warnings: mergeUnique(next.notes?.warnings, change.notes.warnings),
        };
      }

      // Propagate update to parent (Critical fix)
      onUpdate(next);
      return next;
    });

    setIsDirty(true);
    if (incomingBarcodes) {
      setBarcodeInput(incomingBarcodes.join('\n'));
    }
    showNotification('success', t('sheet.msg.changeApplied'));
  };

  const applyAssistantImages = (images: ProductImage[]) => {
    if (!images || images.length === 0) return;
    // Allow trusted AI images (Gemini/Vertex), but block unknown placeholder-like AI images.
    const safeImages = images.filter((img) => !isGeneratedImageMeta(img) || isTrustedAiImage(img));
    if (!safeImages.length) {
      showNotification('error', t('sheet.msg.generatedBlocked'));
      return;
    }
    setLocalProduct((prev) => {
      const existing = Array.isArray(prev.details?.images) ? prev.details.images : [];
      const seen = new Set(existing.map((img) => img?.url_or_base64).filter(Boolean) as string[]);
      const dedupedIncoming = safeImages.filter((img) => {
        const key = img?.url_or_base64;
        if (!key || typeof key !== 'string') return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!dedupedIncoming.length) {
        showNotification('success', t('sheet.msg.imagesAdded', { count: 0 }));
        return prev;
      }
      return {
      ...prev,
        details: { ...prev.details, images: [...existing, ...dedupedIncoming] },
      };
    });
    setIsDirty(true);
    showNotification('success', t('sheet.msg.imagesAdded', { count: safeImages.length }));
  };

  const buildProductWithBarcodeDraft = useCallback(() => {
    const parsedBarcodes = parseBarcodes(barcodeInput);
    return {
      ...localProduct,
      identification: {
        ...localProduct.identification,
        barcodes: parsedBarcodes,
      },
    };
  }, [barcodeInput, localProduct, parseBarcodes]);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const categoryPath = String(getProductBaselinkerCategoryPath(localProduct) || '').trim();
      if (!categoryPath) {
        showNotification('error', 'BaseLinker Kategorie fehlt.');
        return;
      }

      const result = await syncToBaseLinker(localProduct, syncInventoryId);
      const entry = result.results?.find((e) => e.id === localProduct.id);
      if (entry?.status === 'synced') {
        showNotification('success', 'Sync zu BaseLinker erfolgreich.');
      } else {
        showNotification('error', entry?.message || result.error?.message || t('sheet.msg.syncError'));
      }

      // Refresh product from backend so linkage/status is reflected in UI
      const refreshed = await fetchProductById(localProduct.id);
      onUpdate(refreshed);
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePublishToEbay = async () => {
    if (isPublishingEbay) return;
    setIsPublishingEbay(true);
    setEbayPublishStatus('verifying');
    try {
      const verifyResult = await verifyEbayPublish(localProduct.id);
      if (!verifyResult.canPublish) {
        showNotification('error', `eBay Publish blockiert: ${verifyResult.blockers.join(', ')}`);
        setEbayPublishStatus('idle');
        return;
      }
      if (verifyResult.warnings?.length) {
        showNotification('info', `eBay Hinweise: ${verifyResult.warnings.join(', ')}`);
      }
      const feeSummary = (verifyResult.fees || [])
        .filter((f) => f.amount && f.amount !== '0.0' && f.amount !== '0')
        .map((f) => `${f.name}: ${f.amount} ${f.currency || 'EUR'}`)
        .join(', ');

      if (!window.confirm(`Produkt auf eBay.de listen?${feeSummary ? `\n\nGebühren: ${feeSummary}` : ''}\n\nFortfahren?`)) {
        setEbayPublishStatus('idle');
        return;
      }

      setEbayPublishStatus('publishing');
      const result = await publishToEbay(localProduct.id);
      if (result.ok && result.itemId) {
        showNotification('success', `Erfolgreich auf eBay gelistet! Item ID: ${result.itemId}`);
        const refreshed = await fetchProductById(localProduct.id);
        onUpdate(refreshed);
      } else {
        showNotification('error', result.blockers?.join(', ') || 'eBay Publish fehlgeschlagen.');
      }
      setEbayPublishStatus('done');
    } catch (err: any) {
      showNotification('error', err?.message || 'eBay Publish fehlgeschlagen.');
      setEbayPublishStatus('idle');
    } finally {
      setIsPublishingEbay(false);
    }
  };

  const handleFieldChange = (field: string, value: string) => {
    const keys = field.split('.');
    setLocalProduct(prev => {
      const newProd = JSON.parse(JSON.stringify(prev)); // Deep copy
      let current = newProd;
      for (let i = 0; i < keys.length - 1; i++) {
        current = current[keys[i]];
      }
      current[keys[keys.length - 1]] = value;
      return newProd;
    });
    setIsDirty(true);
  };

  const handleCategorySelect = useCallback(
    (categoryId: string) => {
      if (!categoryId) return;
      setLocalProduct((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        next.details = next.details || {};
        next.identification = next.identification || {};
        const match = categoryOptions.find((opt) => String(opt.id) === String(categoryId));
        if (match?.id) {
          next.details.categoryId = String(match.id);
        } else {
          next.details.categoryId = String(categoryId);
        }
        if (match?.breadcrumb) {
          next.identification.category = String(match.breadcrumb);
        }
        return next;
      });
      const selected = categoryOptions.find((opt) => String(opt.id) === String(categoryId));
      if (selected?.breadcrumb) {
        setCategoryQuery(selected.breadcrumb);
      }
      setIsDirty(true);
    },
    [categoryOptions]
  );

  const attributesMap = useMemo(() => localProduct.details?.attributes || {}, [localProduct.details?.attributes]);

  const categorySelectOptions = useMemo(() => {
    const options: EbayCategoryOption[] = [];
    const seen = new Set<string>();
    categoryOptions.forEach((opt) => {
      const id = String(opt?.id || '').trim();
      const breadcrumb = String(opt?.breadcrumb || '').trim();
      if (!id || !breadcrumb) return;
      const key = id;
      if (seen.has(key)) return;
      seen.add(key);
      options.push({
        id,
        name: opt?.name || '',
        breadcrumb,
        leaf: opt?.leaf,
      });
    });
    const current = String(getProductEbayCategoryPath(localProduct) || '').trim();
    const currentId = String(getProductEbayCategoryId(localProduct) || '').trim();
    if (current && currentId) {
      const key = currentId;
      if (!seen.has(key)) {
        options.unshift({
          id: currentId,
          name: 'Aktuell',
          breadcrumb: current,
          leaf: true,
        });
      }
    }
    return options;
  }, [
    categoryOptions,
    localProduct.details?.categoryId,
    localProduct.identification?.category,
  ]);

  const highlightList = useMemo(() => {
    const rawFeatures = Array.isArray(localProduct.details?.key_features)
      ? localProduct.details.key_features
      : [];
    const primary = rawFeatures.map((feature) => feature?.trim()).filter(Boolean);
    const unique = Array.from(new Set(primary));

    const addExtra = (text?: string | null) => {
      const value = text?.toString().trim();
      if (value && !unique.includes(value)) {
        unique.push(value);
      }
    };

    const attr = attributesMap;
    if (attr['Besondere Funktionen']) addExtra(`Features: ${attr['Besondere Funktionen']}`);
    if (attr['Leistung']) addExtra(`Leistung ${attr['Leistung']}`);
    if (attr['Programme']) addExtra(`Programme: ${attr['Programme']}`);
    if (attr['Fassungsvermögen gesamt']) addExtra(`Fassungsvermögen ${attr['Fassungsvermögen gesamt']}`);

    if (unique.length === 0 && localProduct.identification?.brand && localProduct.identification?.category) {
      addExtra(`${localProduct.identification.brand} ${localProduct.identification.category} für den Alltag`);
    }

    return unique.slice(0, 5);
  }, [
    localProduct.details?.key_features,
    localProduct.details?.pricing?.lowest_price,
    localProduct.identification?.brand,
    localProduct.identification?.category,
    attributesMap,
  ]);

  const descriptionText = useMemo(() => {
    const raw = (localProduct.details?.short_description || '').trim();
    if (raw) {
      return raw;
    }
    // Never fabricate placeholder/price text in the UI. If we don't have a description yet, say so plainly.
    return t('sheet.description.empty');
  }, [localProduct.details?.short_description, t]);

  const requiresKTyp = useMemo(() => {
    const cat = (localProduct?.identification?.category || '').toString().toLowerCase();
    return cat.includes('auto') || cat.includes('kfz') || cat.includes('motorrad');
  }, [localProduct?.identification?.category]);

  const ktypValue = useMemo(() => {
    const attrs = localProduct?.details?.attributes || {};
    const key = Object.keys(attrs).find((k) => {
      const lower = String(k || '').trim().toLowerCase();
      return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
    });
    if (!key) return '';
    const raw = attrs[key];
    return raw == null ? '' : String(raw).trim();
  }, [localProduct?.details?.attributes]);

  const qualityGate = (localProduct as any)?.ops?.data_quality?.quality_gate_v1;
  const qualityIssues = Array.isArray(qualityGate?.issues) ? qualityGate.issues : [];
  const qualityErrorCount = useMemo(
    () => qualityIssues.filter((i: any) => i?.severity === 'error').length,
    [qualityIssues]
  );
  const qualityWarnCount = useMemo(
    () => qualityIssues.filter((i: any) => i?.severity === 'warn').length,
    [qualityIssues]
  );
  const qualityHasErrors = qualityErrorCount > 0;
  const qualityHasWarns = qualityErrorCount === 0 && qualityWarnCount > 0;
  const qualityAttributeHighlightKeys = useMemo(() => {
    const set = new Set<string>();
    for (const issue of qualityIssues) {
      const fields = Array.isArray(issue?.fields) ? issue.fields : [];
      for (const f of fields) {
        if (typeof f !== 'string') continue;
        if (!f.startsWith('details.attributes.')) continue;
        const key = f.slice('details.attributes.'.length);
        if (key) set.add(key);
      }
    }
    return set;
  }, [qualityIssues]);
  const hasQualityIssue = useCallback(
    (prefix: string) =>
      qualityIssues.some((issue: any) =>
        Array.isArray(issue?.fields) ? issue.fields.some((f: string) => typeof f === 'string' && f.startsWith(prefix)) : false
      ),
    [qualityIssues]
  );

  const runQualityGate = useCallback(async () => {
    if (qualityBusy) return;
    setQualityBusy(true);
    setQualityMessage(null);
    try {
      const created = await createQualityJobs([localProduct.id], { force: true, reason: 'manual', requestedBy: 'ui' });
      if (!created.ok || !created.data?.jobs?.length) {
        throw new Error(created.error?.message || 'Quality-Job konnte nicht gestartet werden.');
      }
      const jobId = created.data.jobs[0].jobId;
      await pollQualityJob(jobId, { timeoutMs: 10 * 60 * 1000 });
      const refreshed = await fetchProductById(localProduct.id);
      onUpdate(refreshed);
      setQualityMessage('Quality Gate abgeschlossen.');
    } catch (error: any) {
      setQualityMessage(error?.message || 'Quality Gate fehlgeschlagen.');
    } finally {
      setQualityBusy(false);
    }
  }, [localProduct.id, onUpdate, qualityBusy]);

  return (
    <section
      id="product-sheet"
      className="grid grid-cols-1 gap-6 w-full relative items-start lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]"
    >
      {notification && (
        <div className={`fixed top-20 right-8 p-4 rounded-lg shadow-lg z-50 ${notification.type === 'success' ? 'bg-emerald-600' : 'bg-rose-600'} text-white`}>
          {notification.message}
        </div>
      )}

      <div className="space-y-5">
        <header className="p-4 bg-slate-900/70 border border-slate-800 rounded-xl shadow-lg">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <>
                  <textarea
                    id="p-name"
                    value={localProduct.identification.name}
                    onChange={(e) => handleFieldChange('identification.name', e.target.value)}
                    className={`w-full text-2xl sm:text-3xl font-bold bg-transparent outline-none border-b resize-y min-h-[3.5rem] leading-tight ${
                      hasQualityIssue('identification.name') ? 'border-red-400' : 'border-sky-500'
                    }`}
                    rows={2}
                    style={{ wordBreak: 'break-word' }}
                  />
                  <div className="flex justify-end mt-0.5">
                    <span className={`text-xs tabular-nums ${
                      (localProduct.identification.name?.length || 0) > 80
                        ? 'text-red-400 font-semibold'
                        : (localProduct.identification.name?.length || 0) >= 70
                        ? 'text-amber-400'
                        : 'text-slate-500'
                    }`}>
                      {localProduct.identification.name?.length || 0}/80
                    </span>
                  </div>
                </>
              ) : (
                <h1
                  className={`text-2xl sm:text-3xl font-bold break-words leading-tight ${
                    hasQualityIssue('identification.name') ? 'text-red-200' : ''
                  }`}
                  style={{ wordBreak: 'break-word' }}
                >
                  {localProduct.identification.name}
                </h1>
              )}
              <p id="p-brand-cat" className="text-slate-400 mt-1">
                <input
                  value={localProduct.identification.brand}
                  onChange={(e) => handleFieldChange('identification.brand', e.target.value)}
                  readOnly={!isEditing}
                  className={`bg-transparent inline-block outline-none ${
                    isEditing ? (hasQualityIssue('identification.brand') ? 'border-b border-red-400' : 'border-b border-sky-500') : ''
                  }`}
                />
                {' · '}
                {isEditing ? (
                  <span className="inline-flex flex-col gap-1 text-xs text-slate-200">
                    <input
                      value={categoryQuery}
                      onChange={(e) => setCategoryQuery(e.target.value)}
                      className={`bg-transparent border-b outline-none ${
                        hasQualityIssue('details.categoryId') ? 'border-red-400' : 'border-sky-500'
                      }`}
                      placeholder="eBay Kategorie suchen..."
                    />
                    <select
                      value={
                        getProductEbayCategoryId(localProduct) ||
                        ''
                      }
                      onChange={(e) => handleCategorySelect(e.target.value)}
                      className="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-200"
                    >
                      <option value="">eBay Kategorie auswählen...</option>
                      {categorySelectOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.breadcrumb} ({option.id})
                        </option>
                      ))}
                    </select>
                    {categoryLoading && <span className="text-[10px] text-slate-500">Lade Kategorien…</span>}
                    {categoryError && <span className="text-[10px] text-red-400">{categoryError}</span>}
                  </span>
                ) : (
                  <span className="text-sky-400">
                    {getProductDisplayCategory(localProduct)}
                    {localProduct.details?.categoryId ? (
                      <span className="text-slate-500"> ({localProduct.details.categoryId})</span>
                    ) : null}
                  </span>
                )}
              </p>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 mt-2">
                <span>
                  SKU:{' '}
                  {localProduct.identification.sku || localProduct.details.identifiers?.sku || t('common.skuFallback')}
                </span>
                <button
                  id="btn-print-label"
                  onClick={handlePrintLabel}
                  disabled={!localProduct.identification.sku || isPrintingLabel}
                  className="flex items-center px-3 py-1.5 bg-slate-700 text-white rounded-full hover:bg-slate-600 disabled:opacity-40"
                  title={t('sheet.buttons.printLabelTitle')}
                >
                  <PrintIcon />
                  <span className="ml-1">{t('common.printLabel')}</span>
                </button>
              </div>
              {isEditing ? (
                <div className="mt-3">
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    {t('common.barcodeLabel')}
                  </label>
                  <textarea
                    value={barcodeInput}
                    onChange={(e) => {
                      setBarcodeInput(e.target.value);
                      setIsDirty(true);
                    }}
                    rows={Math.min(4, Math.max(2, barcodeInput.split('\n').length || 2))}
                    className={`w-full bg-slate-800 border rounded-lg p-2 text-xs text-slate-200 ${
                      hasQualityIssue('identification.barcodes') || hasQualityIssue('details.identifiers') ? 'border-red-500/60' : 'border-slate-700'
                    }`}
                    placeholder={t('input.barcodes.placeholder')}
                  />
                  <p className="text-[11px] text-slate-500 mt-1">{t('input.barcodes.hint')}</p>
                  <div className="text-[11px] mt-1">
                    {editingBarcodeSummary.hasValid ? (
                      <span className="text-emerald-300">
                        {editingBarcodeSummary.gtin
                          ? t('sheet.barcodes.statusValidGtin', { code: editingBarcodeSummary.gtin })
                          : t('sheet.barcodes.statusValidEan', { code: editingBarcodeSummary.ean })}
                      </span>
                    ) : (
                      <span className="text-amber-300">{t('sheet.barcodes.statusMissing')}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-1">
                  <p id="p-barcodes" className="text-xs text-slate-500">
                    {t('common.barcodeLabel')}: {localProduct.identification.barcodes?.join(', ') || t('common.na')}
                  </p>
                  <div className="flex flex-wrap gap-2 text-[11px] text-slate-400 mt-1">
                    {currentBarcodeSummary.gtin && (
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-200 border border-emerald-500/30">
                        {t('sheet.barcodes.statusValidGtin', { code: currentBarcodeSummary.gtin })}
                      </span>
                    )}
                    {!currentBarcodeSummary.gtin && currentBarcodeSummary.ean && (
                      <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-200 border border-emerald-500/30">
                        {t('sheet.barcodes.statusValidEan', { code: currentBarcodeSummary.ean })}
                      </span>
                    )}
                    {!currentBarcodeSummary.hasValid && (
                      <span className="text-amber-300">{t('sheet.barcodes.statusMissing')}</span>
                    )}
                  </div>
                </div>
              )}

              <div className="mt-4 border border-slate-800 rounded-lg bg-slate-950/40 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-200">Quality Gate</span>
                      {qualityGate?.checked_at_iso ? (
                        <span className="text-[11px] text-slate-500">
                          {new Date(qualityGate.checked_at_iso).toLocaleString('de-DE')}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-500">noch nicht geprüft</span>
                      )}
                      {qualityGate && qualityErrorCount === 0 && qualityWarnCount === 0 && qualityIssues.length === 0 && (
                        <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-200 border border-emerald-500/30 text-[11px]">
                          OK
                        </span>
                      )}
                      {qualityGate && qualityHasWarns && (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-200 border border-amber-500/30 text-[11px]">
                          W{qualityWarnCount}
                        </span>
                      )}
                      {qualityGate && qualityHasErrors && (
                        <span className="px-2 py-0.5 rounded-full bg-red-500/15 text-red-200 border border-red-500/30 text-[11px]">
                          E{qualityErrorCount}{qualityWarnCount ? ` W${qualityWarnCount}` : ''}
                        </span>
                      )}
                    </div>
                    {qualityGate?.summary && <div className="text-[12px] text-slate-300 mt-1">{qualityGate.summary}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={runQualityGate}
                    disabled={qualityBusy}
                    className={`px-3 py-1.5 rounded-md text-xs font-semibold ${
                      qualityHasErrors
                        ? 'bg-red-600 text-white hover:bg-red-500'
                        : qualityHasWarns
                          ? 'bg-amber-600 text-white hover:bg-amber-500'
                          : 'bg-slate-700 text-slate-100 hover:bg-slate-600'
                    } ${qualityBusy ? 'opacity-50 cursor-not-allowed' : ''}`}
                    title="Quality Gate manuell ausführen"
                  >
                    {qualityBusy ? 'Prüfe…' : 'Prüfen'}
                  </button>
                </div>

                {qualityMessage && <div className="text-[11px] text-slate-400 mt-2">{qualityMessage}</div>}

                {qualityIssues.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {qualityIssues.slice(0, 6).map((issue: any, idx: number) => (
                      <div key={`${issue?.code || 'issue'}-${idx}`} className="flex items-start gap-2 text-[12px]">
                        <span
                          className={`mt-0.5 px-1.5 py-0.5 rounded border text-[10px] uppercase ${
                            issue?.severity === 'error'
                              ? 'bg-red-500/15 text-red-200 border-red-500/30'
                              : issue?.severity === 'warn'
                                ? 'bg-amber-500/15 text-amber-200 border-amber-500/30'
                                : 'bg-slate-600/20 text-slate-200 border-slate-600/30'
                          }`}
                        >
                          {issue?.severity || 'info'}
                        </span>
                        <div className="text-slate-200">
                          <span className="font-semibold">{issue?.code}</span>: {issue?.message}
                        </div>
                      </div>
                    ))}
                    {qualityIssues.length > 6 && (
                      <div className="text-[11px] text-slate-500">… und {qualityIssues.length - 6} weitere</div>
                    )}
                  </div>
                )}

                {qualityGate?.evidence?.query && (
                  <div className="mt-3 border-t border-slate-800 pt-2">
                    <div className="text-[11px] text-slate-500">Web-Evidenz Query:</div>
                    <div className="text-[12px] text-slate-200 font-mono break-words">{qualityGate.evidence.query}</div>
                    {Array.isArray(qualityGate?.evidence?.pages) && qualityGate.evidence.pages.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="text-[11px] text-slate-500">Quellen:</div>
                        {qualityGate.evidence.pages.slice(0, 3).map((p: any, idx: number) => (
                          <div key={`qg-evidence-${idx}`} className="text-[12px]">
                            <a
                              href={p?.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-sky-400 hover:underline break-words"
                            >
                              {p?.title || p?.url}
                            </a>
                            {p?.via && <span className="ml-2 text-[11px] text-slate-500">({p.via})</span>}
                          </div>
                        ))}
                        {qualityGate.evidence.pages.length > 3 && (
                          <div className="text-[11px] text-slate-500">… und {qualityGate.evidence.pages.length - 3} weitere</div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="actions flex flex-col sm:flex-row flex-wrap gap-2 w-full sm:w-auto justify-end">
              <button
                id="btn-edit"
                onClick={() => setIsEditing(v => !v)}
                className={`flex items-center justify-center px-4 py-2 font-medium rounded-lg transition-colors w-full sm:w-auto ${isEditing ? 'bg-slate-700 text-white hover:bg-slate-600' : 'bg-sky-600 text-white hover:bg-sky-500'
                  }`}
              >
                <EditIcon /><span className="ml-2">{isEditing ? t('common.editing') : t('common.edit')}</span>
              </button>
              <button
                id="btn-save"
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center justify-center px-4 py-2 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-500 transition-colors disabled:bg-emerald-900 disabled:cursor-not-allowed w-full sm:w-auto"
              >
                <SaveIcon /><span className="ml-2">{isSaving ? t('common.saving') : t('common.save')}</span>
              </button>
              {onImprove && (
                <button
                  type="button"
                  onClick={() => onImprove(localProduct.id)}
                  disabled={Boolean(isImproving)}
                  className="flex items-center justify-center px-4 py-2 bg-violet-600 text-white font-medium rounded-lg hover:bg-violet-500 transition-colors disabled:opacity-60 w-full sm:w-auto"
                >
                  {isImproving ? t('common.improving') : t('common.improve')}
                </button>
              )}
              <button
                type="button"
                onClick={handlePublishToEbay}
                disabled={isPublishingEbay}
                className="flex items-center justify-center gap-2 px-4 py-2 bg-sky-700 text-white font-medium rounded-lg hover:bg-sky-600 transition-colors disabled:bg-sky-900 disabled:cursor-wait w-full sm:w-auto"
              >
                {isPublishingEbay ? (
                  <Spinner className="w-4 h-4" />
                ) : (
                  <svg className="w-4 h-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="10" cy="10" r="7" />
                    <path d="M3 10h14M10 3a10.5 10.5 0 013 7 10.5 10.5 0 01-3 7 10.5 10.5 0 01-3-7 10.5 10.5 0 013-7z" />
                  </svg>
                )}
                {ebayPublishStatus === 'verifying'
                  ? 'Prüfe...'
                  : ebayPublishStatus === 'publishing'
                    ? 'Listing...'
                    : 'eBay'}
              </button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
          <div id="media-gallery" className="md:col-span-2">
            <ImageGallery
              images={localProduct.details.images}
              resetKey={localProduct.id}
              isEditing={isEditing}
              onDeleteImage={isEditing ? handleDeleteImage : undefined}
              onReorder={isEditing ? handleReorderImages : undefined}
              onUpdateImage={isEditing ? handleUpdateImage : undefined}
            />
            {isEditing && (
              <div className="mt-4 space-y-3">
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="text"
                    placeholder={t('sheet.upload.urlPlaceholder')}
                    className="flex-1 bg-slate-700 border border-slate-600 rounded-lg p-2 text-slate-200"
                    value={newImageUrl}
                    onChange={(e) => setNewImageUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddImageFromUrl();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleAddImageFromUrl}
                    className="px-4 py-2 bg-slate-600 rounded-lg text-white font-semibold hover:bg-slate-500 transition-colors disabled:opacity-50"
                    disabled={!newImageUrl.trim()}
                  >
                    {t('sheet.upload.urlButton')}
                  </button>
                </div>
                <div
                  className={`rounded-xl border-2 border-dashed p-4 text-center text-xs sm:text-sm transition-colors ${isUploadDragActive ? 'border-sky-500 bg-slate-800/60' : 'border-slate-600 bg-slate-900/40'}`}
                  onDragOver={handleUploadDragOver}
                  onDragEnter={handleUploadDragOver}
                  onDragLeave={handleUploadDragLeave}
                  onDrop={handleUploadDrop}
                >
                  <p className="text-sm font-semibold text-white">{t('sheet.upload.dragTitle')}</p>
                  <p className="text-slate-400 mt-1">{t('sheet.upload.dragHint')}</p>
                  <div className="mt-3 flex items-center justify-center gap-2 text-slate-400 text-xs uppercase tracking-wide">
                    <span>{t('sheet.upload.or')}</span>
                    <label className="cursor-pointer rounded-full border border-slate-600 px-3 py-1 text-white">
                      {t('sheet.upload.fileBtn')}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          const { files } = e.target;
                          handleUploadImages(files);
                          if (e.target) {
                            e.target.value = '';
                          }
                        }}
                      />
                    </label>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-2">{t('sheet.upload.support')}</p>
                </div>
              </div>
            )}
            {isEditing && (
              <div className="mt-4 pt-4 border-t border-slate-700 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    {t('sheet.ai.referenceLabel')}
                  </label>
                  {referenceImages.length ? (
                    <select
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                      value={selectedReferenceIndex >= 0 ? selectedReferenceIndex : ''}
                      onChange={(e) => setSelectedReferenceIndex(Number(e.target.value))}
                    >
                      {referenceImages.map((img, index) => {
                        const meta = [img.source, img.variant, img.notes].filter(Boolean).join(' · ');
                        return (
                          <option key={`${img.url_or_base64}-${index}`} value={index}>
                            {`Bild ${index + 1}${meta ? ` – ${meta}` : ''}`}
                          </option>
                        );
                      })}
                    </select>
                  ) : (
                    <p className="text-xs text-amber-400">{t('sheet.ai.noReference')}</p>
                  )}
                </div>
                <button
                  onClick={handleGenerateImages}
                  disabled={isGeneratingImages || !selectedReferenceImage}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gradient-to-r from-violet-600 to-violet-500 text-white font-semibold rounded-xl hover:from-violet-500 hover:to-violet-400 transition-all disabled:opacity-40 shadow-lg shadow-violet-900/20"
                >
                  {isGeneratingImages ? <Spinner className="w-5 h-5 text-white" /> : <MagicIcon className="w-5 h-5" />}
                  <span>{isGeneratingImages ? t('sheet.ai.running') : t('sheet.ai.cta')}</span>
                </button>
                <p className="text-xs text-slate-400 text-center">{t('sheet.ai.helper')}</p>
              </div>
            )}
          </div>
          <section id="highlights" className="md:col-span-3 p-4 bg-slate-900/70 border border-slate-800 rounded-xl shadow-lg">
            <h3 className="text-lg font-semibold mb-2 text-white">{t('sheet.highlights')}</h3>
            {isEditing ? (
              <textarea
                defaultValue={(localProduct.details.key_features || []).join('\n')}
                onBlur={(e) => {
                  const lines = e.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
                  setLocalProduct((prev) => ({
                    ...prev,
                    details: { ...prev.details, key_features: lines },
                  }));
                  setIsDirty(true);
                }}
                placeholder={t('sheet.highlights.placeholder')}
                className="w-full min-h-[110px] bg-slate-800 border border-slate-700 rounded-lg p-3 text-slate-200"
              />
            ) : highlightList.length ? (
              <ul className="space-y-2 list-disc list-inside text-slate-300 text-sm">
                {highlightList.map((feature, index) => (
                  <li key={index}>{feature}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">{t('sheet.highlights.empty')}</p>
            )}
          </section>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <section id="description" className="p-4 bg-slate-800 rounded-lg shadow-lg h-full">
            <h3 className="text-xl font-semibold mb-3 text-white">{t('sheet.description')}</h3>
            {isEditing ? (
              <textarea
                defaultValue={localProduct.details.short_description}
                onBlur={(e) => handleFieldChange('details.short_description', e.target.value)}
                className="w-full min-h-[120px] bg-slate-700 border border-slate-600 rounded-lg p-3 text-slate-200"
              />
            ) : (
              <p className="text-slate-300 leading-relaxed text-sm sm:text-base">{descriptionText}</p>
            )}
          </section>

          <section id="gpsr" className="p-4 bg-slate-800 rounded-lg shadow-lg h-full">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xl font-semibold mb-3 text-white">GPSR</h3>
              {!hasAnyGpsr && !isEditing ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 border border-slate-600/40">
                  leer
                </span>
              ) : null}
            </div>

            <p className="text-xs text-slate-400 mb-3">
              GPSR/Compliance Herstellerdaten (wird aus Identify/Jobs strukturiert unter <span className="font-mono">details.gpsr</span> gespeichert).
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[
                ['manufacturer_name', 'Hersteller Name'],
                ['manufacturer_address', 'Adresse (Straße + Nr.)'],
                ['manufacturer_city', 'Stadt'],
                ['manufacturer_postalcode', 'PLZ'],
                ['manufacturer_state_province', 'Bundesland / Province'],
                ['entity_country', 'Land (EN)'],
                ['country_code', 'Country Code'],
                ['email', 'E-Mail'],
                ['manufacturer_phone', 'Telefon'],
                ['url', 'Website'],
              ].map(([key, label]) => {
                const value = typeof gpsr?.[key] === 'string' ? gpsr[key] : '';
                return (
                  <div key={key} className="flex flex-col gap-1">
                    <div className="text-xs font-semibold text-slate-300">{label}</div>
                    {isEditing ? (
                      <input
                        value={value}
                        onChange={(e) => updateGpsrField(String(key), e.target.value)}
                        className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 text-sm"
                        placeholder="—"
                      />
                    ) : (
                      <div className="text-sm text-slate-200 break-words">
                        {value ? value : <span className="text-slate-500">—</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section id="attributes" className="p-4 bg-slate-800 rounded-lg shadow-lg h-full">
            <h3 className="text-xl font-semibold mb-4 text-white">{t('sheet.attributes')}</h3>

            <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-semibold text-slate-200">K-Typ</div>
                    {requiresKTyp && !ktypValue && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-600/30 text-amber-200 border border-amber-500/30">
                        Pflicht (Auto/KFZ/Motorrad)
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Format: <span className="font-mono">19974|57446|57448</span> (optional mit Kommentar nach Komma je Eintrag).
                  </p>
                </div>
              </div>

              {isEditing ? (
                <textarea
                  defaultValue={ktypValue}
                  placeholder="19974|57446|57448"
                  onBlur={(e) => {
                    const nextVal = e.target.value.trim();
                    setLocalProduct((prev) => {
                      const nextAttrs = { ...(prev.details.attributes || {}) } as Record<string, any>;
                      if (!nextVal) {
                        Object.keys(nextAttrs).forEach((k) => {
                          const lower = String(k || '').trim().toLowerCase();
                          if (lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ') {
                            delete nextAttrs[k];
                          }
                        });
                      } else {
                        nextAttrs['K-Typ'] = nextVal;
                      }
                      return { ...prev, details: { ...prev.details, attributes: nextAttrs } };
                    });
                    setIsDirty(true);
                  }}
                  className="mt-3 w-full min-h-[70px] bg-slate-800 border border-slate-700 rounded-lg p-2 text-slate-200"
                />
              ) : (
                <div className="mt-3 text-sm text-slate-200 whitespace-pre-wrap break-words">
                  {ktypValue ? ktypValue : <span className="text-slate-500">—</span>}
                </div>
              )}
            </div>

            {localProduct?.ops?.data_quality?.ktype_enrich_v1 ? (
              <details className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-slate-200">
                  K-Typ Trace (ops.data_quality.ktype_enrich_v1)
                </summary>
                <pre className="mt-3 overflow-auto whitespace-pre-wrap text-xs text-slate-200">
                  {JSON.stringify(localProduct.ops.data_quality.ktype_enrich_v1, null, 2)}
                </pre>
              </details>
            ) : null}

            <AttributeTable
              attributes={localProduct.details.attributes}
              isEditing={isEditing}
              highlightKeys={qualityAttributeHighlightKeys}
              onChange={(next) => {
                setLocalProduct(prev => ({ ...prev, details: { ...prev.details, attributes: next } }));
                setIsDirty(true);
              }}
            />
          </section>

        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <section id="pricing" className="p-4 bg-slate-800 rounded-lg shadow-lg h-full">
            <h3 className="text-xl font-semibold mb-4 text-white">{t('sheet.pricing')}</h3>
            <PricingInfo
              pricing={localProduct.details?.pricing}
              isEditing={isEditing}
              onChange={(next) => {
                setLocalProduct(prev => ({ ...prev, details: { ...prev.details, pricing: next } }));
                setIsDirty(true);
              }}
            />
          </section>

          <section id="storage" className="p-4 bg-slate-800 rounded-lg shadow-lg h-full">
            <h3 className="text-xl font-semibold mb-4 text-white">{t('sheet.storage')}</h3>
            {binsLoading ? (
              <p className="text-slate-400 text-sm mb-3">{t('sheet.storage.loading')}</p>
            ) : binsError ? (
              <p className="text-rose-300 text-sm mb-3">{binsError}</p>
            ) : productBins.length ? (
              <div className="mb-4 space-y-2 max-h-56 overflow-auto pr-1">
                {productBins.map((bin) => (
                  <div key={bin.code} className="rounded border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-200">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold text-white">{bin.code}</div>
                      <div className="text-xs text-slate-400">
                        Zone {bin.zone} · Etage {bin.etage} · Gang {bin.gang} · Regal {bin.regal} · Ebene {bin.ebene}
                      </div>
                      <div className="text-xs text-slate-300">Menge {bin.quantity ?? bin.productCount ?? 0}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-400 text-sm mb-3">{t('sheet.storage.none')}</p>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">{t('sheet.storage.binLabel')}</label>
                <input
                  value={binCodeInput}
                  onChange={(e) => setBinCodeInput(e.target.value.toUpperCase())}
                  placeholder={t('sheet.storage.binPlaceholder')}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">{t('sheet.storage.quantity')}</label>
                <input
                  type="number"
                  min={1}
                  value={binQuantity}
                  onChange={(e) => setBinQuantity(Number(e.target.value))}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-3 mt-4">
              <button
                onClick={handleAssignBin}
                disabled={isAssigningBin}
                className="px-4 py-2 bg-sky-600 text-white rounded hover:bg-sky-500 disabled:opacity-40"
              >
                {isAssigningBin ? t('sheet.storage.assigning') : t('sheet.storage.assign')}
              </button>
              {binCodeInput && (
                <button
                  onClick={handleRemoveBin}
                  className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-500"
                >
                  {t('sheet.storage.remove')}
                </button>
              )}
            </div>
          </section>
        </div>

        {false && (
        <section className="p-4 bg-slate-800 rounded-lg shadow-lg space-y-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-xl font-semibold text-white">{t('sheet.inventory.title')}</h3>
              <p className="text-sm text-slate-200">
                {localProduct.inventory?.inventoryName || t('sheet.inventory.none')}
              </p>
              <p className="text-xs text-slate-400">
                {localProduct.inventory?.inventoryId || t('sheet.inventory.helper')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleInventoryLabel}
                disabled={!localProduct.inventory?.inventoryId}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-100 hover:bg-slate-700 transition-colors disabled:opacity-50"
              >
                <PrintIcon className="w-4 h-4" />
                {t('sheet.inventory.printLabel')}
              </button>
              <button
                type="button"
                onClick={() => syncInventoryList()}
                disabled={inventorySyncing}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-100 hover:bg-slate-700 transition-colors disabled:opacity-60"
              >
                {inventorySyncing ? <Spinner className="w-4 h-4" /> : <RefreshIcon className="w-4 h-4" />}
                {inventorySyncing ? t('sheet.inventory.syncing') : t('sheet.inventory.sync')}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-slate-400 uppercase tracking-wide">
              {t('sheet.inventory.selectLabel')}
            </label>
            <select
              value={localProduct.inventory?.inventoryId || ''}
              onChange={(event) => handleInventoryAssign(event.target.value)}
              disabled={assigningInventory}
              className="w-full rounded-xl border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
            >
              <option value="">{t('sheet.inventory.selectPlaceholder')}</option>
              {inventories.map((inv) => (
                <option key={inv.inventoryId} value={inv.inventoryId}>
                  {inv.name} ({inv.inventoryId})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                localProduct.inventory?.inventoryId
                  ? setActiveInventoryId(localProduct.inventory.inventoryId)
                  : null
              }
              disabled={!localProduct.inventory?.inventoryId}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-3 py-1.5 text-sm font-semibold text-slate-100 hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              <BarcodeIcon className="w-4 h-4" />
              {t('sheet.inventory.setActive')}
            </button>
          </div>
          {inventoryMessage && <p className="text-xs text-slate-400">{inventoryMessage}</p>}
        </section>
        )}

        <section className="p-4 bg-slate-800 rounded-lg shadow-lg">
          <h3 className="text-xl font-semibold mb-4 text-white">{t('sheet.actions.title')}</h3>
          <div className="actions flex flex-wrap gap-4 items-center">
            {/* Fixed BaseLinker inventory (78659), no selector */}
            <button
              id="btn-sync"
              onClick={handleSync}
              disabled={isSyncing}
              className="flex items-center justify-center px-4 py-2 bg-slate-700 text-slate-200 font-semibold rounded-lg hover:bg-slate-600 transition-colors disabled:bg-slate-500 disabled:cursor-wait"
            >
              {isSyncing ? <Spinner className="w-5 h-5" /> : <SyncIcon />}
              <span className="ml-2">{t('sheet.actions.sync')}</span>
            </button>
            <button
              id="btn-publish-ebay"
              onClick={handlePublishToEbay}
              disabled={isPublishingEbay}
              className="flex items-center justify-center px-4 py-2 bg-sky-700 text-white font-semibold rounded-lg hover:bg-sky-600 transition-colors disabled:bg-sky-900 disabled:cursor-wait"
            >
              {isPublishingEbay ? (
                <Spinner className="w-5 h-5" />
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="10" cy="10" r="7" />
                  <path d="M3 10h14M10 3a10.5 10.5 0 013 7 10.5 10.5 0 01-3 7 10.5 10.5 0 01-3-7 10.5 10.5 0 013-7z" />
                </svg>
              )}
              <span className="ml-2">
                {ebayPublishStatus === 'verifying'
                  ? 'Prüfe...'
                  : ebayPublishStatus === 'publishing'
                    ? 'Wird gelistet...'
                    : 'Auf eBay listen'}
              </span>
            </button>
          </div>
        </section>
      </div>

      <aside id="gemini-chat" className="lg:sticky lg:top-24">
        <div className="h-[60vh] min-h-[420px] lg:h-[75vh]">
          <AssistantChat
            product={localProduct}
            onApplyDatasheetChange={applyAssistantChange}
            onAddImages={applyAssistantImages}
          />
        </div>
      </aside>
    </section>
  );
};

export default ProductSheet;
