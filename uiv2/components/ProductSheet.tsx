
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Product, DatasheetChange, ProductImage, WarehouseBin, BaseLinkerCategoryOption } from '../types';
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
  fetchBaseLinkerCategories,
  refreshPrice,
} from '../api/client';
import { EditIcon, SaveIcon, SyncIcon, PrintIcon, MagicIcon, RefreshIcon, BarcodeIcon } from './icons/Icons';
import { Spinner } from './Spinner';
import ImageGallery from './ImageGallery';
import AttributeTable from './AttributeTable';
import PricingInfo from './PricingInfo';
import AssistantChat from './GeminiChat';
import { useI18n } from '../i18n';
import { normalizeBarcode, summarizeBarcodes, isValidGtin } from '../utils/gtin';
import { useInventoryContext } from '../context/InventoryContext';
import {
  ChevronRight, Save, Pencil, RefreshCw, Printer, Sparkles, Image as ImageIcon,
  FileText, AlignLeft, List, Package, Tag, Globe, ShieldCheck, Plus, GripVertical,
  Eye, Upload, X, Check, AlertTriangle, Clock, User, ArrowUpDown,
} from 'lucide-react';

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
  const [priceBusy, setPriceBusy] = useState(false);
  const [priceMessage, setPriceMessage] = useState<string | null>(null);
  const [isGeneratingImages, setIsGeneratingImages] = useState(false);
  const [selectedReferenceIndex, setSelectedReferenceIndex] = useState<number>(-1);
  const [isUploadDragActive, setIsUploadDragActive] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState<string>(() => (product.identification?.barcodes || []).join('\n'));
  const latestBarcodeInputRef = useRef<string>(barcodeInput);
  latestBarcodeInputRef.current = barcodeInput;
  const [categoryQuery, setCategoryQuery] = useState('');
  const [categoryQueryDebounced, setCategoryQueryDebounced] = useState('');
  const [categoryOptions, setCategoryOptions] = useState<BaseLinkerCategoryOption[]>([]);
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
    const legacyMap = (localProduct.details?.baselinkerCategories || {}) as any;
    const current =
      localProduct.details?.baselinkerCategoryPath ||
      legacyMap?.['78659'] ||
      legacyMap?.['91387'] ||
      '';
    setCategoryQuery((prev) => prev || String(current || ''));
  }, [isEditing, localProduct.details?.baselinkerCategoryPath, localProduct.details?.baselinkerCategories]);

  useEffect(() => {
    const handle = setTimeout(() => {
      setCategoryQueryDebounced(categoryQuery.trim());
    }, 200);
    return () => clearTimeout(handle);
  }, [categoryQuery]);

  useEffect(() => {
    if (!isEditing) return;
    const query = categoryQueryDebounced;
    const params: { inventoryId: string; query?: string; id?: string; limit?: number; leafOnly?: boolean } = {
      inventoryId: '78659',
      limit: 60,
      leafOnly: true,
    };
    if (query.length >= 2) params.query = query;
    if (localProduct.details?.baselinkerCategoryId) {
      params.id = String(localProduct.details.baselinkerCategoryId);
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
    fetchBaseLinkerCategories(params)
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
  }, [isEditing, categoryQueryDebounced, localProduct.details?.baselinkerCategoryId]);

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

      // 1.5 BaseLinker category (single category)
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
      const categoryPath = String(localProduct.details?.baselinkerCategoryPath || '').trim();
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
    (breadcrumb: string) => {
      if (!breadcrumb) return;
      setLocalProduct((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        next.details = next.details || {};
        const match = categoryOptions.find((opt) => opt.breadcrumb === breadcrumb);
        if (match?.id) {
          next.details.baselinkerCategoryId = String(match.id);
        }
        next.details.baselinkerCategoryPath = breadcrumb;
        return next;
      });
      setCategoryQuery(breadcrumb);
      setIsDirty(true);
    },
    [categoryOptions]
  );

  const attributesMap = useMemo(() => localProduct.details?.attributes || {}, [localProduct.details?.attributes]);

  const categorySelectOptions = useMemo(() => {
    const options: BaseLinkerCategoryOption[] = [];
    const seen = new Set<string>();
    categoryOptions.forEach((opt) => {
      if (!opt?.breadcrumb) return;
      const key = String(opt.breadcrumb).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      options.push(opt);
    });
    const current = String(localProduct.details?.baselinkerCategoryPath || '').trim();
    const currentId = String(localProduct.details?.baselinkerCategoryId || '').trim();
    if (current) {
      const key = current.toLowerCase();
      if (!seen.has(key)) {
        options.unshift({
          id: currentId || 'current',
          name: 'Aktuell',
          breadcrumb: current,
        });
      }
    }
    return options;
  }, [categoryOptions, localProduct.details?.baselinkerCategoryPath, localProduct.details?.baselinkerCategoryId]);

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

  const identifyQuality = (localProduct as any)?.ops?.data_quality?.identify_v2_quality_v1 || null;
  const improveQuality = (localProduct as any)?.ops?.data_quality?.improve_quality_v1 || null;
  const readiness = useMemo(() => {
    const a = identifyQuality;
    const b = improveQuality;
    if (!a && !b) return null;
    if (a && !b) return a;
    if (!a && b) return b;
    const ta = Date.parse(String(a?.checked_at_iso || ''));
    const tb = Date.parse(String(b?.checked_at_iso || ''));
    if (Number.isFinite(tb) && Number.isFinite(ta)) return tb >= ta ? b : a;
    return b || a;
  }, [identifyQuality, improveQuality]);
  const readinessIssues = useMemo(
    () => (Array.isArray(readiness?.issues_detailed) ? readiness.issues_detailed : []),
    [readiness]
  );
  const readinessErrorCount = useMemo(
    () => readinessIssues.filter((i: any) => i?.severity === 'error').length,
    [readinessIssues]
  );
  const readinessWarnCount = useMemo(
    () => readinessIssues.filter((i: any) => i?.severity === 'warn').length,
    [readinessIssues]
  );
  const readinessInfoCount = useMemo(
    () => readinessIssues.filter((i: any) => i?.severity === 'info').length,
    [readinessIssues]
  );
  const readinessHasErrors = Boolean(readiness && readinessErrorCount > 0);
  const readinessHasWarns = Boolean(
    readiness &&
      !readinessHasErrors &&
      (readinessWarnCount > 0 || readinessInfoCount > 0)
  );
  const highlightIssues = useMemo(
    () => ([] as any[]).concat(qualityIssues || [], readinessIssues || []),
    [qualityIssues, readinessIssues]
  );

  const qualityAttributeHighlightKeys = useMemo(() => {
    const set = new Set<string>();
    for (const issue of highlightIssues) {
      const fields = Array.isArray(issue?.fields) ? issue.fields : [];
      for (const f of fields) {
        if (typeof f !== 'string') continue;
        if (!f.startsWith('details.attributes.')) continue;
        const key = f.slice('details.attributes.'.length);
        if (key) set.add(key);
      }
    }
    return set;
  }, [highlightIssues]);
  const hasQualityIssue = useCallback(
    (prefix: string) =>
      highlightIssues.some((issue: any) =>
        Array.isArray(issue?.fields) ? issue.fields.some((f: string) => typeof f === 'string' && f.startsWith(prefix)) : false
      ),
    [highlightIssues]
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

  const runPriceRefresh = useCallback(async () => {
    if (priceBusy) return;
    setPriceBusy(true);
    setPriceMessage(null);
    try {
      const res = await refreshPrice(localProduct.id);
      if (!res.ok) {
        throw new Error(res.error?.message || t('sheet.priceRefresh.error'));
      }
      const refreshed = await fetchProductById(localProduct.id);
      onUpdate(refreshed);
      setPriceMessage(t('sheet.priceRefresh.success'));
    } catch (error: any) {
      setPriceMessage(error?.message || t('sheet.priceRefresh.error'));
    } finally {
      setPriceBusy(false);
    }
  }, [localProduct.id, onUpdate, priceBusy, t]);

  return (
    <section id="product-sheet">
      {/* Notification Toast */}
      {notification && (
        <div className={`toast-notification ${notification.type}`} style={{ position: 'fixed', top: 20, right: 20, zIndex: 1000 }}>
          {notification.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />}
          {notification.message}
        </div>
      )}

      {/* Breadcrumb */}
      <nav className="breadcrumb">
        <button type="button" onClick={() => window.history.back()}>Produkte</button>
        <ChevronRight size={14} className="breadcrumb-sep" />
        <span className="breadcrumb-current">{localProduct.identification.name || 'Produkt'}</span>
      </nav>

      {/* Page Header */}
      <div className="page-header">
        <div>
          <div className="page-title-group">
            {isEditing ? (
              <textarea
                id="p-name"
                value={localProduct.identification.name}
                onChange={(e) => handleFieldChange('identification.name', e.target.value)}
                className={`page-title-input ${hasQualityIssue('identification.name') ? 'has-error' : ''}`}
                rows={1}
              />
            ) : (
              <h1 className="page-title">{localProduct.identification.name}</h1>
            )}
            <span className={`status-badge ${localProduct.ops?.last_saved_iso ? 'active' : 'draft'}`}>
              <span className="status-dot" />
              {localProduct.ops?.last_saved_iso ? t('common.active') : t('common.draft')}
            </span>
          </div>
        </div>
        <div className="page-header-actions">
          <button className="btn btn-ghost" onClick={() => setIsEditing(v => !v)}>
            <Pencil size={14} />
            {isEditing ? t('common.editing') : t('common.edit')}
          </button>
          {onImprove && (
            <button
              className="btn btn-secondary"
              onClick={() => onImprove(localProduct.id)}
              disabled={Boolean(isImproving)}
            >
              <Sparkles size={14} />
              {isImproving ? t('common.improving') : t('common.improve')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={handleSync} disabled={isSyncing}>
            {isSyncing ? <Spinner className="w-4 h-4" /> : <RefreshCw size={14} />}
            {t('sheet.actions.sync')}
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
            <Save size={14} />
            {isSaving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      {/* Split Layout */}
      <div className="split-layout">
        {/* LEFT COLUMN */}
        <div className="left-col">

          {/* Bilder-Galerie Card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <ImageIcon size={16} />
                {t('sheet.gallery') || 'Bilder-Galerie'}
              </span>
              <span className="card-action">{t('sheet.gallery.manage') || 'Alle verwalten'} &rarr;</span>
            </div>
            <div className="card-body">
              <ImageGallery
                images={localProduct.details.images}
                isEditing={isEditing}
                onDeleteImage={isEditing ? handleDeleteImage : undefined}
                onReorder={isEditing ? handleReorderImages : undefined}
              />

              {isEditing && (
                <div style={{ marginTop: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                  <div className="form-row">
                    <div className="form-group">
                      <input
                        type="text"
                        className="form-input"
                        placeholder={t('sheet.upload.urlPlaceholder')}
                        value={newImageUrl}
                        onChange={(e) => setNewImageUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddImageFromUrl(); } }}
                      />
                    </div>
                    <div className="form-group">
                      <button className="btn btn-secondary" onClick={handleAddImageFromUrl} disabled={!newImageUrl.trim()}>
                        <Plus size={14} />
                        {t('sheet.upload.urlButton')}
                      </button>
                    </div>
                  </div>

                  <div
                    className={`image-main ${isUploadDragActive ? 'has-image' : ''}`}
                    style={{ aspectRatio: 'auto', minHeight: 100, borderStyle: 'dashed' }}
                    onDragOver={handleUploadDragOver}
                    onDragEnter={handleUploadDragOver}
                    onDragLeave={handleUploadDragLeave}
                    onDrop={handleUploadDrop}
                  >
                    <div className="image-main-placeholder">
                      <Upload size={32} />
                      <span>{t('sheet.upload.dragTitle')}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t('sheet.upload.dragHint')}</span>
                      <label className="btn btn-sm btn-secondary" style={{ marginTop: 8, cursor: 'pointer' }}>
                        {t('sheet.upload.fileBtn')}
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            handleUploadImages(e.target.files);
                            if (e.target) e.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* AI Image Generation (editing only) */}
              {isEditing && (
                <div className="ai-tools-section">
                  <div className="ai-tools-header">
                    <div className="ai-tools-label">
                      <Sparkles size={14} />
                      {t('sheet.ai.referenceLabel')}
                      <span className="ai-badge">AI</span>
                    </div>
                  </div>
                  {referenceImages.length ? (
                    <select
                      className="form-input"
                      value={selectedReferenceIndex >= 0 ? selectedReferenceIndex : ''}
                      onChange={(e) => setSelectedReferenceIndex(Number(e.target.value))}
                    >
                      {referenceImages.map((img, index) => {
                        const meta = [img.source, img.variant, img.notes].filter(Boolean).join(' . ');
                        return (
                          <option key={`${img.url_or_base64}-${index}`} value={index}>
                            {`Bild ${index + 1}${meta ? ` - ${meta}` : ''}`}
                          </option>
                        );
                      })}
                    </select>
                  ) : (
                    <p style={{ fontSize: 12, color: 'var(--warning)' }}>{t('sheet.ai.noReference')}</p>
                  )}
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', justifyContent: 'center', marginTop: 'var(--space-3)' }}
                    onClick={handleGenerateImages}
                    disabled={isGeneratingImages || !selectedReferenceImage}
                  >
                    {isGeneratingImages ? <Spinner className="w-4 h-4" /> : <Sparkles size={14} />}
                    {isGeneratingImages ? t('sheet.ai.running') : t('sheet.ai.cta')}
                  </button>
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center', marginTop: 'var(--space-2)' }}>
                    {t('sheet.ai.helper')}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Grunddaten Card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <FileText size={16} />
                {t('sheet.basicData') || 'Grunddaten'}
              </span>
            </div>
            <div className="card-body">
              <div className="form-group">
                <label className="form-label">{t('sheet.field.brand') || 'Marke'}</label>
                <input
                  className={`form-input ${hasQualityIssue('identification.brand') ? 'error' : ''}`}
                  value={localProduct.identification.brand}
                  onChange={(e) => handleFieldChange('identification.brand', e.target.value)}
                  readOnly={!isEditing}
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">SKU</label>
                  <input
                    className="form-input form-input-mono"
                    value={localProduct.identification.sku || localProduct.details.identifiers?.sku || t('common.skuFallback')}
                    readOnly
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('sheet.field.condition') || 'Zustand'}</label>
                  {isEditing ? (
                    <select
                      className="form-input"
                      value={(localProduct.details as any)?.condition || ''}
                      onChange={(e) => handleFieldChange('details.condition', e.target.value)}
                    >
                      <option value="">--</option>
                      <option value="Neu">Neu</option>
                      <option value="Gebraucht - Wie Neu">Gebraucht - Wie Neu</option>
                      <option value="Gebraucht - Gut">Gebraucht - Gut</option>
                      <option value="Gebraucht - Akzeptabel">Gebraucht - Akzeptabel</option>
                      <option value="Generalueberholt">Generalueberholt</option>
                      <option value="Defekt / Ersatzteile">Defekt / Ersatzteile</option>
                    </select>
                  ) : (
                    <input className="form-input" value={(localProduct.details as any)?.condition || '--'} readOnly />
                  )}
                </div>
              </div>

              {/* BaseLinker Category */}
              <div className="form-group">
                <label className="form-label">{t('sheet.field.category') || 'Kategorie'}</label>
                {isEditing ? (
                  <>
                    <input
                      className={`form-input ${hasQualityIssue('details.baselinkerCategoryPath') ? 'error' : ''}`}
                      value={categoryQuery}
                      onChange={(e) => setCategoryQuery(e.target.value)}
                      placeholder="BaseLinker Kategorie suchen..."
                    />
                    <select
                      className="form-input"
                      style={{ marginTop: 6 }}
                      value={
                        localProduct.details?.baselinkerCategoryPath ||
                        String((((localProduct.details?.baselinkerCategories || {}) as any)?.['91387'] || '') as any) ||
                        ''
                      }
                      onChange={(e) => handleCategorySelect(e.target.value)}
                    >
                      <option value="">Kategorie auswaehlen...</option>
                      {categorySelectOptions.map((option) => (
                        <option key={option.id} value={option.breadcrumb}>{option.breadcrumb}</option>
                      ))}
                    </select>
                    {categoryLoading && <span className="form-error" style={{ color: 'var(--text-tertiary)' }}>Lade Kategorien...</span>}
                    {categoryError && <span className="form-error">{categoryError}</span>}
                  </>
                ) : (
                  <input
                    className="form-input"
                    value={
                      localProduct.details?.baselinkerCategoryPath ||
                      String((((localProduct.details?.baselinkerCategories || {}) as any)?.['91387'] || '') as any) ||
                      '--'
                    }
                    readOnly
                  />
                )}
              </div>

              {/* Barcodes */}
              <div className="form-group">
                <label className="form-label">{t('common.barcodeLabel')}</label>
                {isEditing ? (
                  <>
                    <textarea
                      className={`form-input ${hasQualityIssue('identification.barcodes') || hasQualityIssue('details.identifiers') ? 'error' : ''}`}
                      value={barcodeInput}
                      onChange={(e) => { setBarcodeInput(e.target.value); setIsDirty(true); }}
                      rows={Math.min(4, Math.max(2, barcodeInput.split('\n').length || 2))}
                      placeholder={t('input.barcodes.placeholder')}
                      style={{ minHeight: 60 }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4, display: 'block' }}>{t('input.barcodes.hint')}</span>
                    <div style={{ fontSize: 11, marginTop: 4 }}>
                      {editingBarcodeSummary.hasValid ? (
                        <span style={{ color: 'var(--success)' }}>
                          {editingBarcodeSummary.gtin
                            ? t('sheet.barcodes.statusValidGtin', { code: editingBarcodeSummary.gtin })
                            : t('sheet.barcodes.statusValidEan', { code: editingBarcodeSummary.ean || '' })}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--warning)' }}>{t('sheet.barcodes.statusMissing')}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      className="form-input form-input-mono"
                      value={localProduct.identification.barcodes?.join(', ') || t('common.na')}
                      readOnly
                    />
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6, fontSize: 11 }}>
                      {currentBarcodeSummary.gtin && (
                        <span className="status-badge active">{t('sheet.barcodes.statusValidGtin', { code: currentBarcodeSummary.gtin })}</span>
                      )}
                      {!currentBarcodeSummary.gtin && currentBarcodeSummary.ean && (
                        <span className="status-badge active">{t('sheet.barcodes.statusValidEan', { code: currentBarcodeSummary.ean })}</span>
                      )}
                      {!currentBarcodeSummary.hasValid && (
                        <span style={{ color: 'var(--warning)' }}>{t('sheet.barcodes.statusMissing')}</span>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Print Label */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={handlePrintLabel}
                  disabled={!localProduct.identification.sku || isPrintingLabel}
                  title={t('sheet.buttons.printLabelTitle')}
                >
                  <Printer size={14} />
                  {t('common.printLabel')}
                </button>
              </div>
            </div>
          </div>

          {/* Beschreibung Card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <AlignLeft size={16} />
                {t('sheet.description')}
              </span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {isEditing ? (
                <textarea
                  className="rich-textarea"
                  defaultValue={localProduct.details.short_description}
                  onBlur={(e) => handleFieldChange('details.short_description', e.target.value)}
                  style={{ borderTop: 'none', borderRadius: '0 0 var(--radius-lg) var(--radius-lg)' }}
                />
              ) : (
                <div style={{ padding: 'var(--space-5)', fontSize: 14, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                  {descriptionText}
                </div>
              )}
            </div>
          </div>

          {/* Highlights Card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <List size={16} />
                {t('sheet.highlights')}
              </span>
            </div>
            <div className="card-body">
              {isEditing ? (
                <textarea
                  className="form-input"
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
                  style={{ minHeight: 110 }}
                />
              ) : highlightList.length ? (
                <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6, color: 'var(--text-secondary)', fontSize: 13 }}>
                  {highlightList.map((feature, index) => (
                    <li key={index}>{feature}</li>
                  ))}
                </ul>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('sheet.highlights.empty')}</p>
              )}
            </div>
          </div>

          {/* GPSR Card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <ShieldCheck size={16} />
                GPSR
              </span>
              {!hasAnyGpsr && !isEditing && (
                <span className="status-badge draft" style={{ fontSize: 11 }}>leer</span>
              )}
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <p style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: 'var(--space-4) var(--space-5) 0' }}>
                GPSR/Compliance Herstellerdaten
              </p>
              {isEditing ? (
                <div style={{ padding: 'var(--space-4) var(--space-5)' }}>
                  <div className="form-row">
                    {([
                      ['manufacturer_name', 'Hersteller Name'],
                      ['manufacturer_address', 'Adresse'],
                      ['manufacturer_city', 'Stadt'],
                      ['manufacturer_postalcode', 'PLZ'],
                      ['manufacturer_state_province', 'Bundesland'],
                      ['entity_country', 'Land (EN)'],
                      ['country_code', 'Country Code'],
                      ['email', 'E-Mail'],
                      ['manufacturer_phone', 'Telefon'],
                      ['url', 'Website'],
                    ] as [string, string][]).map(([key, label]) => {
                      const value = typeof gpsr?.[key] === 'string' ? gpsr[key] : '';
                      return (
                        <div key={key} className="form-group">
                          <label className="form-label">{label}</label>
                          <input
                            className="form-input"
                            value={value}
                            onChange={(e) => updateGpsrField(key, e.target.value)}
                            placeholder="--"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="specs-grid">
                  {([
                    ['manufacturer_name', 'Hersteller Name'],
                    ['manufacturer_address', 'Adresse'],
                    ['manufacturer_city', 'Stadt'],
                    ['manufacturer_postalcode', 'PLZ'],
                    ['manufacturer_state_province', 'Bundesland'],
                    ['entity_country', 'Land (EN)'],
                    ['country_code', 'Country Code'],
                    ['email', 'E-Mail'],
                    ['manufacturer_phone', 'Telefon'],
                    ['url', 'Website'],
                  ] as [string, string][]).filter(([key]) => {
                    const value = typeof gpsr?.[key] === 'string' ? gpsr[key] : '';
                    return Boolean(value);
                  }).map(([key, label]) => {
                    const value = typeof gpsr?.[key] === 'string' ? gpsr[key] : '';
                    return (
                      <div key={key} className="spec-row">
                        <div className="spec-key">{label}</div>
                        <div className="spec-value">{value || '--'}</div>
                      </div>
                    );
                  })}
                  {!hasAnyGpsr && (
                    <div style={{ padding: 'var(--space-4) var(--space-5)', fontSize: 13, color: 'var(--text-tertiary)' }}>
                      Keine GPSR-Daten vorhanden.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Spezifikationen / Attributes Card */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">
                <Tag size={16} />
                {t('sheet.attributes')}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 }}>
                {Object.keys(attributesMap).length} {t('sheet.attributes.count') || 'Eintraege'}
              </span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {/* K-Typ section */}
              <div style={{ padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>K-Typ</span>
                  {requiresKTyp && !ktypValue && (
                    <span className="status-badge warning" style={{ fontSize: 11 }}>Pflicht (Auto/KFZ/Motorrad)</span>
                  )}
                </div>
                <p style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
                  Format: <code style={{ fontFamily: 'var(--mono, monospace)' }}>19974|57446|57448</code>
                </p>
                {isEditing ? (
                  <textarea
                    className="form-input"
                    defaultValue={ktypValue}
                    placeholder="19974|57446|57448"
                    onBlur={(e) => {
                      const nextVal = e.target.value.trim();
                      setLocalProduct((prev) => {
                        const nextAttrs = { ...(prev.details.attributes || {}) } as Record<string, any>;
                        if (!nextVal) {
                          Object.keys(nextAttrs).forEach((k) => {
                            const lower = String(k || '').trim().toLowerCase();
                            if (lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ') delete nextAttrs[k];
                          });
                        } else {
                          nextAttrs['K-Typ'] = nextVal;
                        }
                        return { ...prev, details: { ...prev.details, attributes: nextAttrs } };
                      });
                      setIsDirty(true);
                    }}
                    style={{ marginTop: 8, minHeight: 70 }}
                  />
                ) : (
                  <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {ktypValue || <span style={{ color: 'var(--text-tertiary)' }}>--</span>}
                  </div>
                )}
              </div>

              {localProduct?.ops?.data_quality?.ktype_enrich_v1 && (
                <details style={{ padding: 'var(--space-3) var(--space-5)', borderBottom: '1px solid var(--border)' }}>
                  <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    K-Typ Trace
                  </summary>
                  <pre style={{ marginTop: 8, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
                    {JSON.stringify(localProduct.ops.data_quality.ktype_enrich_v1, null, 2)}
                  </pre>
                </details>
              )}

              <div style={{ padding: 'var(--space-4) var(--space-5)' }}>
                <AttributeTable
                  attributes={localProduct.details.attributes}
                  isEditing={isEditing}
                  highlightKeys={qualityAttributeHighlightKeys}
                  onChange={(next) => {
                    setLocalProduct(prev => ({ ...prev, details: { ...prev.details, attributes: next } }));
                    setIsDirty(true);
                  }}
                />
              </div>
            </div>
          </div>

        </div>

        {/* RIGHT COLUMN */}
        <div className="right-col">

          {/* Status Card */}
          <div className="ctx-card">
            <div className="ctx-header">
              <span className="ctx-title">Status</span>
              <span className={`status-badge ${localProduct.ops?.last_saved_iso ? 'active' : 'draft'}`} style={{ fontSize: 11, padding: '2px 10px' }}>
                <span className="status-dot" />
                {localProduct.ops?.last_saved_iso ? t('common.active') : t('common.draft')}
              </span>
            </div>
            <div className="ctx-body">
              <div className="ctx-row">
                <span className="ctx-label">SKU</span>
                <span className="ctx-value ctx-value-mono">
                  {localProduct.identification.sku || localProduct.details.identifiers?.sku || '--'}
                </span>
              </div>
              <div className="ctx-row">
                <span className="ctx-label">{t('sheet.field.brand') || 'Marke'}</span>
                <span className="ctx-value">{localProduct.identification.brand || '--'}</span>
              </div>
              {localProduct.ops?.last_saved_iso && (
                <div className="ctx-row">
                  <span className="ctx-label">Gespeichert</span>
                  <span className="ctx-value">{new Date(localProduct.ops.last_saved_iso).toLocaleString('de-DE')}</span>
                </div>
              )}
              {localProduct.details?.baselinkerCategoryId && (
                <>
                  <div className="ctx-divider" />
                  <div className="ctx-row">
                    <span className="ctx-label">Kategorie ID</span>
                    <span className="ctx-value ctx-value-mono">{localProduct.details.baselinkerCategoryId}</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* eBay Readiness Card */}
          <div className="ctx-card">
            <div className="ctx-header">
              <span className="ctx-title">
                <Globe size={14} />
                {t('sheet.ebayReadiness.title')}
              </span>
              {readiness && !readinessHasErrors && !readinessHasWarns && (
                <span className="status-badge active" style={{ fontSize: 11, padding: '2px 10px' }}>
                  <span className="status-dot" />OK
                </span>
              )}
              {readiness && readinessHasWarns && (
                <span className="status-badge warning" style={{ fontSize: 11, padding: '2px 10px' }}>
                  <span className="status-dot" />W{readinessWarnCount}{readinessInfoCount ? ` I${readinessInfoCount}` : ''}
                </span>
              )}
              {readiness && readinessHasErrors && (
                <span className="status-badge error" style={{ fontSize: 11, padding: '2px 10px' }}>
                  <span className="status-dot" />E{readinessErrorCount}{readinessWarnCount ? ` W${readinessWarnCount}` : ''}{readinessInfoCount ? ` I${readinessInfoCount}` : ''}
                </span>
              )}
              {!readiness && (
                <span className="status-badge draft" style={{ fontSize: 11, padding: '2px 10px' }}>
                  <span className="status-dot" />--
                </span>
              )}
            </div>
            <div className="ctx-body">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {readiness?.checked_at_iso
                    ? new Date(readiness.checked_at_iso).toLocaleString('de-DE')
                    : t('sheet.ebayReadiness.notChecked')}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {onImprove && (
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => onImprove(localProduct.id)}
                      disabled={Boolean(isImproving)}
                    >
                      <Sparkles size={12} />
                      {isImproving ? t('common.improving') : t('common.improve')}
                    </button>
                  )}
                  <button className="btn btn-sm btn-secondary" onClick={runPriceRefresh} disabled={priceBusy}>
                    {priceBusy ? <Spinner className="w-4 h-4" /> : <RefreshCw size={12} />}
                    {t('sheet.priceRefresh.cta')}
                  </button>
                  <button className="btn btn-sm btn-secondary" onClick={runQualityGate} disabled={qualityBusy}>
                    <ShieldCheck size={12} />
                    {qualityBusy ? t('sheet.qualityGate.running') : t('sheet.qualityGate.cta')}
                  </button>
                </div>
              </div>

              {priceMessage && (
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>{priceMessage}</p>
              )}

              {!readiness && (
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('sheet.ebayReadiness.none')}</p>
              )}

              {readinessIssues.length > 0 && (
                <div className="quality-issue-list">
                  {readinessIssues.slice(0, 5).map((issue: any, idx: number) => (
                    <div key={`readiness-${issue?.code || 'issue'}-${idx}`} className="quality-issue-item">
                      <span
                        className="quality-severity-tag"
                        style={{
                          background: issue?.severity === 'error' ? 'var(--error-bg)' : issue?.severity === 'warn' ? 'var(--warning-bg)' : 'var(--surface-secondary)',
                          color: issue?.severity === 'error' ? 'var(--error)' : issue?.severity === 'warn' ? 'var(--warning)' : 'var(--text-primary)',
                          borderColor: issue?.severity === 'error' ? 'var(--error-border)' : issue?.severity === 'warn' ? 'var(--warning-border)' : 'var(--border)',
                        }}
                      >
                        {issue?.severity || 'info'}
                      </span>
                      <div style={{ color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <div>
                          <span style={{ fontWeight: 600 }}>{issue?.code}</span>: {issue?.message}
                        </div>
                        {issue?.source_url && (
                          <a
                            href={issue.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ctx-value-link"
                            style={{ fontSize: 11, wordBreak: 'break-word' }}
                          >
                            {t('sheet.ebayReadiness.source')}
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                  {readinessIssues.length > 5 && (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      ... {t('sheet.ebayReadiness.more', { count: readinessIssues.length - 5 })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Lagerbestand Card */}
          <div className="ctx-card">
            <div className="ctx-header">
              <span className="ctx-title">
                <Package size={14} />
                {t('sheet.storage')}
              </span>
            </div>
            <div className="ctx-body">
              {binsLoading ? (
                <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{t('sheet.storage.loading')}</p>
              ) : binsError ? (
                <p style={{ fontSize: 13, color: 'var(--error)' }}>{binsError}</p>
              ) : productBins.length ? (
                <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 200, overflowY: 'auto' }}>
                  {productBins.map((bin) => (
                    <div key={bin.code} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{bin.code}</span>
                        <span style={{ color: 'var(--text-secondary)' }}>Menge {(bin as any).quantity ?? bin.productCount ?? 0}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                        Zone {bin.zone} . Etage {bin.etage} . Gang {bin.gang} . Regal {bin.regal} . Ebene {bin.ebene}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 12 }}>{t('sheet.storage.none')}</p>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">{t('sheet.storage.binLabel')}</label>
                  <input
                    className="form-input form-input-mono"
                    value={binCodeInput}
                    onChange={(e) => setBinCodeInput(e.target.value.toUpperCase())}
                    placeholder={t('sheet.storage.binPlaceholder')}
                  />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">{t('sheet.storage.quantity')}</label>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    value={binQuantity}
                    onChange={(e) => setBinQuantity(Number(e.target.value))}
                  />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={handleAssignBin} disabled={isAssigningBin} style={{ flex: 1, justifyContent: 'center' }}>
                    <Plus size={12} />
                    {isAssigningBin ? t('sheet.storage.assigning') : t('sheet.storage.assign')}
                  </button>
                  {binCodeInput && (
                    <button className="btn btn-danger btn-sm" onClick={handleRemoveBin} style={{ flex: 1, justifyContent: 'center' }}>
                      <X size={12} />
                      {t('sheet.storage.remove')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Preise Card */}
          <div className="ctx-card">
            <div className="ctx-header">
              <span className="ctx-title">{t('sheet.pricing')}</span>
            </div>
            <div className="ctx-body">
              <PricingInfo
                pricing={localProduct.details?.pricing}
                isEditing={isEditing}
                onChange={(next) => {
                  setLocalProduct(prev => ({ ...prev, details: { ...prev.details, pricing: next } }));
                  setIsDirty(true);
                }}
              />
            </div>
          </div>

          {/* Quality Gate Card */}
          <div className="ctx-card">
            <div className="ctx-header">
              <span className="ctx-title">
                <ShieldCheck size={14} />
                Quality Gate
              </span>
              {qualityGate && qualityErrorCount === 0 && qualityWarnCount === 0 && qualityIssues.length === 0 && (
                <span className="status-badge active" style={{ fontSize: 11, padding: '2px 10px' }}>
                  <span className="status-dot" />OK
                </span>
              )}
              {qualityGate && qualityHasWarns && (
                <span className="status-badge warning" style={{ fontSize: 11, padding: '2px 10px' }}>
                  <span className="status-dot" />W{qualityWarnCount}
                </span>
              )}
              {qualityGate && qualityHasErrors && (
                <span className="status-badge error" style={{ fontSize: 11, padding: '2px 10px' }}>
                  <span className="status-dot" />E{qualityErrorCount}{qualityWarnCount ? ` W${qualityWarnCount}` : ''}
                </span>
              )}
            </div>
            <div className="ctx-body">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {qualityGate?.checked_at_iso
                    ? new Date(qualityGate.checked_at_iso).toLocaleString('de-DE')
                    : 'noch nicht geprueft'}
                </span>
                <button
                  className={`btn btn-sm ${qualityHasErrors ? 'btn-danger' : qualityHasWarns ? 'btn-secondary' : 'btn-secondary'}`}
                  onClick={runQualityGate}
                  disabled={qualityBusy}
                >
                  {qualityBusy ? 'Pruefe...' : 'Pruefen'}
                </button>
              </div>
              {qualityGate?.summary && (
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>{qualityGate.summary}</p>
              )}
              {qualityMessage && (
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>{qualityMessage}</p>
              )}
              {qualityIssues.length > 0 && (
                <div className="quality-issue-list">
                  {qualityIssues.slice(0, 6).map((issue: any, idx: number) => (
                    <div key={`${issue?.code || 'issue'}-${idx}`} className="quality-issue-item">
                      <span
                        className="quality-severity-tag"
                        style={{
                          background: issue?.severity === 'error' ? 'var(--error-bg)' : issue?.severity === 'warn' ? 'var(--warning-bg)' : 'var(--surface-secondary)',
                          color: issue?.severity === 'error' ? 'var(--error)' : issue?.severity === 'warn' ? 'var(--warning)' : 'var(--text-primary)',
                          borderColor: issue?.severity === 'error' ? 'var(--error-border)' : issue?.severity === 'warn' ? 'var(--warning-border)' : 'var(--border)',
                        }}
                      >
                        {issue?.severity || 'info'}
                      </span>
                      <div style={{ color: 'var(--text-primary)' }}>
                        <span style={{ fontWeight: 600 }}>{issue?.code}</span>: {issue?.message}
                      </div>
                    </div>
                  ))}
                  {qualityIssues.length > 6 && (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>... und {qualityIssues.length - 6} weitere</div>
                  )}
                </div>
              )}
              {qualityGate?.evidence?.query && (
                <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Web-Evidenz Query:</div>
                  <div style={{ fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace', wordBreak: 'break-word' }}>{qualityGate.evidence.query}</div>
                  {Array.isArray(qualityGate?.evidence?.pages) && qualityGate.evidence.pages.length > 0 && (
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Quellen:</div>
                      {qualityGate.evidence.pages.slice(0, 3).map((p: any, idx: number) => (
                        <div key={`qg-evidence-${idx}`} style={{ fontSize: 12 }}>
                          <a href={p?.url} target="_blank" rel="noopener noreferrer" className="ctx-value-link" style={{ wordBreak: 'break-word' }}>
                            {p?.title || p?.url}
                          </a>
                          {p?.via && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>({p.via})</span>}
                        </div>
                      ))}
                      {qualityGate.evidence.pages.length > 3 && (
                        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>... und {qualityGate.evidence.pages.length - 3} weitere</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* KI Assistent Card */}
          <div className="ctx-card">
            <div className="ctx-header">
              <span className="ctx-title">
                KI Assistent <span className="ai-badge">AI</span>
              </span>
            </div>
            <div className="ctx-body" style={{ padding: 0 }}>
              <div style={{ height: '50vh', minHeight: 360 }}>
                <AssistantChat
                  product={localProduct}
                  onApplyDatasheetChange={applyAssistantChange}
                  onAddImages={applyAssistantImages}
                />
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Unsaved Changes Banner */}
      <div className={`unsaved-banner ${isDirty ? 'visible' : ''}`}>
        <div className="unsaved-banner-left">
          <div className="unsaved-dot" />
          <span className="unsaved-text">{t('sheet.unsaved') || 'Ungespeicherte Aenderungen'}</span>
        </div>
        <div className="unsaved-banner-right">
          <button className="btn btn-ghost" onClick={() => { setLocalProduct(normalizeProduct(product)); setIsDirty(false); setIsEditing(false); }}>
            {t('common.discard') || 'Verwerfen'}
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={isSaving}>
            <Save size={14} />
            {isSaving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </section>
  );

};

export default ProductSheet;
