
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { Product, DatasheetChange, ProductImage, WarehouseBin, EbayCategoryOption, EbayConditionOption, Readiness } from '../types';
import { READINESS_LABELS, normalizeReadiness } from '../utils/readiness';
import { ProductNotes } from './ProductNotes';
import {
  saveProduct,
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
  fetchEbayConditions,
} from '../api/client';
import { EditIcon, SaveIcon, PrintIcon, MagicIcon, RefreshIcon, BarcodeIcon } from './icons/Icons';
import { Spinner } from './Spinner';
import ImageGallery from './ImageGallery';
import AttributeTable from './AttributeTable';
import PricingInfo from './PricingInfo';
import CompetitorPrices from './CompetitorPrices';
import AssistantChat from './GeminiChat';
import { normalizeChangeAttributes } from './chatChanges';
import ValidationPanel from './ValidationPanel';
import IdentifyV4Badge from './IdentifyV4Badge';
import { Tabs, TabPanel } from './ui/Tabs';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { useI18n } from '../i18n';
import { normalizeBarcode, summarizeBarcodes, isValidGtin, getGtinLabel, validateIdentifierField, classifyBarcodesByLength, identifierFieldLabel, type IdentifierField } from '../utils/gtin';
import {
  getProductDisplayCategory,
  getProductEbayCategoryId,
  getProductEbayCategoryPath,
  deriveInitials,
} from '../utils/product';
import { useInventoryContext } from '../context/InventoryContext';
import { useAuth } from '../context/AuthContext';

interface ProductSheetProps {
  product: Product;
  onUpdate: (updatedProduct: Product) => void;
  onImprove?: (productId: string) => void;
  isImproving?: boolean;
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Resolve image src from either `{url_or_base64: "..."}` or `{url_or_base64: {url: "..."}}` */
const resolveImageSrc = (img?: any): string => {
  if (!img) return '';
  const raw = img.url_or_base64;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url;
  if (typeof img.url === 'string') return img.url;
  return '';
};

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

const ProductSheet: React.FC<ProductSheetProps> = ({ product, onUpdate, onImprove, isImproving, onClose, onDirtyChange }) => {
  const { t } = useI18n();
  const { user } = useAuth();
  const editorInitials = useMemo(() => deriveInitials(user?.email || ""), [user?.email]);
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
  const [isDirty, setIsDirty] = useState(false);
  // Prevent stale external updates from overwriting recent saves (race condition with improve jobs)
  const lastSaveAtRef = useRef(0);
  // Signal dirty state to parent so polling doesn't overwrite unsaved changes
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  // Bleibende Warnung: Felder, die gesendet wurden und NICHT im Dokument
  // gelandet sind (Schreib-Quittung des Servers, Vorfall 2026-08-10).
  // Bewusst ohne Auto-Ausblenden — verschwindende Warnungen waren die Ursache.
  const [writeReceiptWarning, setWriteReceiptWarning] = useState<
    Array<{ path: string; label: string; wanted: string }> | null
  >(null);
  const [autoGenDone, setAutoGenDone] = useState(false);
  const [isPrintingLabel, setIsPrintingLabel] = useState(false);
  const [binCodeInput, setBinCodeInput] = useState(product.storage?.binCode || '');
  // For multi-BIN: this input is a delta (stock-in/out), not the total product quantity.
  const [binQuantity, setBinQuantity] = useState<number>(1);
  const [isAssigningBin, setIsAssigningBin] = useState(false);
  const [isRemovingBin, setIsRemovingBin] = useState(false);
  // Auslagern ist eine ECHTE Bestandsbuchung (der Bestand ist aus den BINs
  // abgeleitet, siehe backend/lib/warehouse.js refreshProductInventory). Darum
  // Pflicht-Rückfrage vor der Buchung …
  const [stockOutConfirm, setStockOutConfirm] = useState<{ bin: string; qty: number } | null>(null);
  // … und danach eine BLEIBENDE Quittung statt eines 5-Sekunden-Hinweises.
  // Dieselbe Lehre wie beim Einlager-Vorfall 2026-07-30: eine Quittung, die von
  // allein verschwindet, verhindert keine Wiederholung und belegt nichts.
  const [binReceipt, setBinReceipt] = useState<
    { action: 'in' | 'out'; bin: string; qty: number; stockAfter: number | null } | null
  >(null);
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
  // Kanonische Einzelfelder EAN/UPC/GTIN (aus der barcodes-Liste nach Stellenzahl abgeleitet).
  // Sie sind die Editier-Oberfläche; barcodeInput (der Save-Pfad) wird bei jeder Änderung neu
  // aus den drei Feldern zusammengesetzt — je Typ genau ein Wert (Incident 2026-07-13).
  const [idFields, setIdFields] = useState<Record<IdentifierField, string>>(() =>
    classifyBarcodesByLength(product.identification?.barcodes || [])
  );
  const applyIdField = useCallback((field: IdentifierField, rawValue: string) => {
    const digits = normalizeBarcode(rawValue);
    setIdFields((prev) => {
      const next = { ...prev, [field]: digits };
      setBarcodeInput([next.ean, next.upc, next.gtin].filter(Boolean).join('\n'));
      return next;
    });
    setIsDirty(true);
  }, []);
  const [categoryQuery, setCategoryQuery] = useState('');
  const [categoryQueryDebounced, setCategoryQueryDebounced] = useState('');
  const [categoryOptions, setCategoryOptions] = useState<EbayCategoryOption[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  // Artikelzustand: eigenes eBay-Feld, kein Artikelmerkmal. Welche Zustände
  // erlaubt sind UND wie sie heißen, hängt an der Kategorie — deshalb werden
  // die Optionen bei jedem Kategoriewechsel neu geladen.
  const [conditionOptions, setConditionOptions] = useState<EbayConditionOption[]>([]);
  const [conditionRequired, setConditionRequired] = useState(false);
  const [conditionCategoryKnown, setConditionCategoryKnown] = useState(false);

  const [assigningInventory, setAssigningInventory] = useState(false);
  const [inventoryMessage, setInventoryMessage] = useState<string | null>(null);
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
    // Block stale external updates for 10s after a save — improve job results may
    // contain data from before the save (race condition with concurrent jobs).
    if (isSameProduct && lastSaveAtRef.current && (Date.now() - lastSaveAtRef.current < 10_000)) {
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
    setStockOutConfirm(null);
    setBinReceipt(null);
    setNewImageUrl('');
    loadProductBins(product.id);
    setBarcodeInput((product.identification?.barcodes || []).join('\n'));
    setIdFields(classifyBarcodesByLength(product.identification?.barcodes || []));
  }, [product, loadProductBins, normalizeProduct, isDirty, isEditing, isGeneratingImages]);

  const gpsr = (localProduct?.details?.gpsr || {}) as any;
  const hasAnyGpsr = useMemo(() => {
    return Object.values(gpsr || {}).some((v) => typeof v === 'string' && v.trim().length > 0);
  }, [gpsr]);
  // GPSR-Hersteller-Block nur zeigen, wenn echte Hersteller-Kontaktdaten vorliegen
  // (volle Adresse, E-Mail oder Telefon). Bei Nicht-EU-Importen ohne EU-Herstelleradresse
  // sendet eBay ohnehin keinen Hersteller-Block — dann ist die EU-Verantwortliche Person
  // die einzige relevante GPSR-Angabe. Siehe backend/lib/ebay-trading-api.js buildManufacturerXml.
  const hasManufacturerContact = useMemo(() => {
    const s = (k: string) => (typeof gpsr?.[k] === "string" ? gpsr[k].trim() : "");
    const fullAddress = Boolean(s("manufacturer_address") && s("manufacturer_city") && s("manufacturer_postalcode"));
    return Boolean(fullAddress || s("email") || s("manufacturer_phone"));
  }, [gpsr]);
  const showManufacturerBlock = hasManufacturerContact;

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
          zone: primary.zone as NonNullable<Product["storage"]>["zone"],
          etage: primary.etage,
          gang: primary.gang,
          regal: primary.regal,
          ebene: primary.ebene,
          assigned_at: prev.storage?.assigned_at || new Date().toISOString(),
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

  const handleInsertImage = useCallback(
    (image: ProductImage, afterIndex: number) => {
      updateImages((images) => {
        const at = Math.max(0, Math.min(images.length, afterIndex + 1));
        images.splice(at, 0, image);
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

  /**
   * Speichert und meldet EHRLICH zurück, ob es geklappt hat.
   *
   * Der Rückgabewert ist neu (Vorfall 2026-08-10): vorher gab performSave
   * nichts zurück, weshalb kein Aufrufer wissen konnte, ob wirklich
   * geschrieben wurde. Der KI-Assistent hat genau deshalb Erfolg gemeldet,
   * obwohl nie gespeichert wurde.
   */
  const performSave = useCallback(async (): Promise<boolean> => {
    if (isSavingRef.current) return false;
    isSavingRef.current = true;
    setIsSaving(true);
    let saveOk = false;

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
        // Fetch the server-side version of the product to see exactly what was persisted.
        // This prevents "phantom reverts" where the UI shows local data but the server
        // transformed fields (brand casing, attribute aliases, barcode validation, etc.).
        let serverProduct: Product | null = null;
        try {
          serverProduct = await fetchProductById(productToSave.id);
        } catch {
          // Fallback: use local data if server fetch fails
        }

        const finalProduct = serverProduct || productToSave;
        const assignedSku =
          result.data.sku ||
          finalProduct.identification?.sku ||
          finalProduct.details?.identifiers?.sku ||
          null;
        const updatedProduct: Product = {
          ...finalProduct,
          identification: {
            ...finalProduct.identification,
            sku: assignedSku || finalProduct.identification?.sku,
          },
          details: {
            ...finalProduct.details,
            identifiers: {
              ...(finalProduct.details?.identifiers || {}),
              sku: assignedSku || finalProduct.details?.identifiers?.sku || undefined,
            },
          },
          ops: {
            ...finalProduct.ops,
            revision: result.data.revision,
            last_saved_iso: new Date().toISOString(),
          },
        };
        const normalized = normalizeProduct(updatedProduct);
        setLocalProduct(normalized);
        onUpdate(normalized);
        setIsEditing(false);
        setIsDirty(false);
        lastSaveAtRef.current = Date.now();
        setBarcodeInput((normalized.identification?.barcodes || []).join('\n'));
        setIdFields(classifyBarcodesByLength(normalized.identification?.barcodes || []));

        // SCHREIB-QUITTUNG: Der Server hat nach dem Schreiben den echten
        // Dokumentstand gegen die gesendeten Daten verglichen. Fehlende Felder
        // werden BLEIBEND angezeigt — eine Warnung, die nach 5 Sekunden
        // verschwindet, ist genau die Art Meldung, die den Vorfall vom
        // 2026-08-10 neun Tage lang unsichtbar gehalten hat.
        const receipt = result.data.receipt;
        if (receipt && receipt.ok === false && receipt.missing?.length) {
          setWriteReceiptWarning(receipt.missing);
          saveOk = false;
        } else {
          setWriteReceiptWarning(null);
          saveOk = true;
          showNotification('success', t('sheet.msg.saveSuccess'));
        }
      } else {
        showNotification('error', result.error?.message || t('sheet.msg.saveError'));
      }
    } finally {
      setIsSaving(false);
      isSavingRef.current = false;
    }
    return saveOk;
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
      setBinReceipt({
        action: 'in',
        bin: binCodeInput.toUpperCase(),
        qty: Number(binQuantity) || 1,
        stockAfter: typeof normalized.inventory?.quantity === 'number' ? normalized.inventory.quantity : null,
      });
    } else {
      showNotification('error', result.error?.message || t('sheet.msg.binAssignError'));
    }
    setIsAssigningBin(false);
  };

  /**
   * Öffnet NUR die Rückfrage — bucht noch nichts.
   *
   * Der Knopf hieß bis 2026-08-15 „BIN-Zuordnung entfernen“ und löste
   * trotzdem eine echte Lagerausbuchung aus (Menge aus dem Feld daneben,
   * Vorgabe 1), inklusive Push an eBay/Kaufland. Ein reines Lösen der
   * Verknüpfung ist technisch gar nicht möglich: der Bestand IST die Summe
   * der BIN-Einträge (backend/lib/warehouse.js refreshProductInventory).
   * Also heißt der Knopf jetzt, was er tut, und fragt vorher.
   */
  const requestStockOut = () => {
    if (!binCodeInput) {
      showNotification('error', t('sheet.msg.binRequired'));
      return;
    }
    const qty = Number(binQuantity) || 0;
    if (!qty || qty <= 0) {
      showNotification('error', t('sheet.msg.binAssignError'));
      return;
    }
    setStockOutConfirm({ bin: binCodeInput.toUpperCase(), qty });
  };

  const performStockOut = async () => {
    if (!stockOutConfirm) return;
    const { bin, qty } = stockOutConfirm;
    setIsRemovingBin(true);
    try {
      const response = await stockOutProduct({
        productId: localProduct.id,
        binCode: bin,
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
      setBinReceipt({
        action: 'out',
        bin,
        qty,
        stockAfter: typeof normalized.inventory?.quantity === 'number' ? normalized.inventory.quantity : null,
      });
    } finally {
      setIsRemovingBin(false);
      setStockOutConfirm(null);
    }
  };

  /**
   * Übernimmt einen Vorschlag des KI-Assistenten UND speichert ihn.
   *
   * Der Rückgabewert entscheidet, ob die Änderungskarte im Chat verschwinden
   * darf. Vorher war die Funktion synchron und speicherte nicht — die Karte
   * verschwand trotzdem, was wie Erfolg aussah (Vorfall 2026-08-10).
   */
  const applyAssistantChange = async (change: DatasheetChange): Promise<boolean> => {
    let incomingBarcodes: string[] | null = null;
    // Kategorie-Vorschlag ohne aufgelöste eBay-categoryId: NICHT still nur den
    // Anzeige-Breadcrumb schreiben (wirkte wie Erfolg, änderte aber nichts an
    // der wirksamen Kategorie — Incident 2026-07-16). Stattdessen unten die
    // Kategorie-Suche mit dem Vorschlag öffnen und ehrlich benachrichtigen.
    const categoryNeedsConfirm = Boolean(change.categoryPath && !change.categoryId);

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
          // Strip protocol-only `_clear` directive and `barcodes` (handled
          // separately below) before spreading, so an empty `barcodes: []`
          // never accidentally wipes valid existing codes via the spread.
          const identityRest = { ...(change.identity as Record<string, unknown>) };
          delete (identityRest as { _clear?: unknown })._clear;
          delete (identityRest as { barcodes?: unknown }).barcodes;
          // Herstellernummer gehört nach details.identifiers.mpn — DORT liest
          // die UI sie (Identifikatoren-Block), identification.mpn liest
          // niemand. Ohne dieses Umhängen wäre die Schema-Erweiterung in
          // V2/Legacy wirkungslos und sähe trotzdem nach Erfolg aus.
          const incomingMpn = typeof identityRest.mpn === 'string' ? identityRest.mpn.trim() : '';
          delete (identityRest as { mpn?: unknown }).mpn;
          if (incomingMpn) {
            next.details = next.details || ({} as typeof next.details);
            const detailsForMpn = next.details as unknown as { identifiers?: Record<string, unknown> };
            detailsForMpn.identifiers = { ...(detailsForMpn.identifiers || {}), mpn: incomingMpn };
          }
          if (categoryNeedsConfirm) {
            // Kategorie ohne aufgelöste categoryId: auch den identity.category-
            // Breadcrumb nicht schreiben — sonst zeigt die Anzeige eine Kategorie,
            // die nie wirksam wurde (Confirm-Flow unten übernimmt).
            delete (identityRest as { category?: unknown }).category;
          }
          next.identification = {
            ...next.identification,
            ...(identityRest as Partial<typeof next.identification>),
          };
          // Explicitly ensure name is overwritten if present in identity/title
          if (change.identity.name) {
            next.identification.name = change.identity.name;
          } else if ((change.identity as { title?: string }).title) {
            next.identification.name = (change.identity as { title?: string }).title!;
          }
          // Explicitly ensure brand is overwritten if present in identity
          if (change.identity.brand) {
            next.identification.brand = change.identity.brand;
          }
        }

        // Barcode-Korrektur aus dem Chat: die gelieferte Liste ist die
        // VOLLSTÄNDIGE neue Menge (Ersatz, nicht mehr Union). Sonst würde eine
        // EAN-Korrektur die alten falschen Codes nie loswerden (Incident
        // 2026-07-13). Auf je einen gültigen Code pro Typ (EAN/UPC/GTIN) reduziert.
        if (change.identity?.barcodes && Array.isArray(change.identity.barcodes) && change.identity.barcodes.length > 0) {
          const cls = classifyBarcodesByLength(
            change.identity.barcodes.map(b => normalizeBarcode(String(b))).filter(b => b && isValidGtin(b))
          );
          next.identification.barcodes = [cls.ean, cls.upc, cls.gtin].filter(Boolean);
          incomingBarcodes = next.identification.barcodes;
        }

        // Honor explicit clear directive — see DatasheetChange.identity._clear.
        // We delete from BOTH `identification.barcodes` (UI source of truth in
        // Stammdaten) AND `details.identifiers.*` (eBay publish source of truth)
        // to keep the two layers consistent. Without dual-clearing, eBay would
        // still see the EAN in the catalog path OR the user would still see it
        // in Stammdaten — the exact bug from the ATE auto-parts case.
        const clearList = Array.isArray((change.identity as { _clear?: string[] } | undefined)?._clear)
          ? (change.identity as { _clear?: string[] })._clear!
          : [];
        if (clearList.length) {
          next.details = next.details || ({} as typeof next.details);
          const detailsAny = next.details as unknown as { identifiers?: Record<string, string | undefined> };
          const ids = detailsAny.identifiers || {};
          if (clearList.includes('barcodes')) {
            next.identification.barcodes = [];
            incomingBarcodes = [];
          }
          if (clearList.includes('ean')) delete ids.ean;
          if (clearList.includes('gtin')) delete ids.gtin;
          if (clearList.includes('upc')) delete ids.upc;
          detailsAny.identifiers = ids;
        }
      }

      // 1.5 eBay category (canonical)
      if (change.categoryId) {
        next.details = next.details || {};
        next.identification = next.identification || {};
        (next.details as any).categoryId = String(change.categoryId).replace(/\D+/g, '').trim();
        // BUG-094: accepting a chat-proposed category is an explicit user choice,
        // exactly like picking from the dropdown (handleCategorySelect). Mark the
        // source as manual so the fire-and-forget CATEGORY_RESOLVER_V2 auto-correct
        // does not overwrite it post-save (the "springs back" race).
        (next.details as any).categorySource = "manual";
        if (change.categoryPath) {
          next.identification.category = String(change.categoryPath).trim();
        }
      }
      // categoryPath OHNE categoryId wird bewusst NICHT geschrieben — der
      // Breadcrumb-Text allein ändert die wirksame eBay-Kategorie nicht
      // (categoryNeedsConfirm-Flow unten übernimmt).

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
        const baseGpsr: Record<string, any> = { ...(next.details.gpsr || {}) };
        // Etikett-Quelle (aus Produktbild abgelesen): pro Rolle die ALTEN Felder
        // verwerfen, wenn die Rolle neu identifiziert wird — sonst überleben
        // stale Falschwerte (EU-REP-PLZ/Chinesen-Telefon beim Hersteller) den
        // additiven Merge (Incident 2026-07-17). Signal: gpsr_evidence_check.
        const evOutcome = (change as any).gpsr_evidence_check?.outcome;
        const imageSourced = evOutcome === "product_image";
        const inc = change.gpsr as Record<string, any>;
        if (imageSourced) {
          if (inc.manufacturer_name) {
            for (const k of Object.keys(baseGpsr)) if (/^manufacturer_/.test(k)) delete baseGpsr[k];
          }
          if (inc.eu_responsible_name) {
            for (const k of Object.keys(baseGpsr)) if (/^eu_responsible_/.test(k)) delete baseGpsr[k];
          }
        }
        next.details.gpsr = { ...baseGpsr, ...inc };
      }

      // 4. Attributes (Merge) — normalizeChangeAttributes akzeptiert Map UND
      // V3-Array-Shape [{key|name, value}] (sonst entstand attributes['0']-Müll).
      const incomingAttributeMap = normalizeChangeAttributes(change.attributes);
      if (Object.keys(incomingAttributeMap).length > 0) {
        next.details = next.details || {};
        const cleanedIncoming: Record<string, any> = {};
        Object.entries(incomingAttributeMap).forEach(([key, value]) => {
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
        // sellPrice ist "der Preis" (eBay/Kaufland-Sync). Explizit vorgeschlagenes
        // sellPrice gewinnt; sonst füllen wir es nur, wenn das Produkt noch keinen
        // positiven Preis hat (0,00-€-Fall) — ein vom Operator gesetzter Preis
        // wird nie stillschweigend überschrieben. (Gleiches Muster wie der
        // suggestedPrice-Übernehmen-Knopf.)
        const cp: any = change.pricing;
        const explicitSell = typeof cp.sellPrice === 'number' && cp.sellPrice > 0 ? cp.sellPrice : null;
        const researchedAmount =
          (typeof cp.lowest_price?.amount === 'number' && cp.lowest_price.amount > 0 ? cp.lowest_price.amount : null) ??
          (typeof cp.amount === 'number' && cp.amount > 0 ? cp.amount : null);
        const currentSell = next.details.pricing.sellPrice;
        const hasCurrentSell = typeof currentSell === 'number' && currentSell > 0;
        if (explicitSell != null) {
          next.details.pricing.sellPrice = explicitSell;
        } else if (!hasCurrentSell && researchedAmount != null) {
          next.details.pricing.sellPrice = researchedAmount;
        }
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
    // Signal dirty state immediately (not via useEffect) to prevent SSE race conditions
    onDirtyChange?.(true);
    // `incomingBarcodes` is only ever assigned inside the setLocalProduct
    // updater closure above, which TS's control-flow analysis cannot observe —
    // so it resets the variable to its `null` initializer here, narrowing the
    // truthy branch to `never`. Re-assert the declared type to recover it.
    const resolvedBarcodes = incomingBarcodes as string[] | null;
    if (resolvedBarcodes) {
      setBarcodeInput(resolvedBarcodes.join('\n'));
      setIdFields(classifyBarcodesByLength(resolvedBarcodes));
    }
    if (categoryNeedsConfirm) {
      setCategoryQuery(String(change.categoryPath || '').trim());
      showNotification('error', t('sheet.msg.categoryNeedsConfirm'));
      // Kategorie braucht Bestätigung — hier NICHT speichern, der Nutzer
      // muss erst die Kategorie wählen. Ehrlich als "nicht übernommen".
      return false;
    }

    // WIRKLICH SPEICHERN (Vorfall 2026-08-10, SKU-3154363905).
    // Bis hier setzte "Übernehmen" nur React-State und ein Dirty-Flag —
    // gespeichert wurde NIE. Die Änderungskarte verschwand trotzdem sofort,
    // das Datenblatt zeigte die neuen Werte, und beim Schließen war alles
    // weg. Der Nutzer bot derweil die alten, falschen Daten auf eBay an.
    //
    // Das setTimeout(0) folgt handleSave: die setLocalProduct-Aktualisierung
    // oben muss erst gerendert sein, damit latestProductRef den neuen Stand
    // trägt — sonst speichert performSave den ALTEN Zustand.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ok = await performSave();
    if (ok) {
      showNotification('success', t('sheet.msg.changeApplied'));
    }
    // Bei !ok steht bereits die Fehlermeldung bzw. das Quittungs-Banner.
    return ok;
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
      const seen = new Set(existing.map((img) => resolveImageSrc(img)).filter(Boolean));
      const dedupedIncoming = safeImages.filter((img) => {
        const key = resolveImageSrc(img);
        if (!key) return false;
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

  const handleFieldChange = (field: string, value: string | number | null) => {
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

  const handleReadinessChange = useCallback((value: Readiness) => {
    setLocalProduct(prev => ({
      ...prev,
      ops: {
        ...prev.ops,
        readiness: value,
        readiness_editor: editorInitials,
        readiness_set_at: new Date().toISOString(),
      },
    }));
    setIsDirty(true);
  }, [editorInitials]);

  // Ownership: clicking "Bearbeiten" claims the datasheet → status "In Bearbeitung"
  // + the editor's initials, persisted immediately (not only on save). A sheet
  // already marked "Bereit" is left untouched (no accidental downgrade).
  const handleToggleEdit = useCallback(async () => {
    const entering = !isEditing;
    setIsEditing(entering);
    if (!entering) return;
    const current = latestProductRef.current;
    if (!current || current.ops?.readiness === "ready") return;
    if (current.ops?.readiness === "in_progress" && current.ops?.readiness_editor === editorInitials) return;
    const next: Product = {
      ...current,
      ops: {
        ...(current.ops || {}),
        readiness: "in_progress",
        readiness_editor: editorInitials,
        readiness_set_at: new Date().toISOString(),
      },
    };
    setLocalProduct(next);
    try {
      const r = await saveProduct(next);
      if (r.ok && r.data) {
        const merged: Product = { ...next, ops: { ...next.ops, revision: r.data.revision } };
        setLocalProduct(merged);
        onUpdate(merged);
      }
    } catch {
      // best-effort ownership write; full save will persist later
    }
  }, [isEditing, editorInitials, onUpdate]);

  // Zustands-Optionen zur aktuellen Kategorie laden. Läuft auch außerhalb des
  // Bearbeiten-Modus, damit die Anzeige den richtigen Namen zeigt.
  const activeCategoryId = getProductEbayCategoryId(localProduct) || '';
  useEffect(() => {
    let active = true;
    fetchEbayConditions(activeCategoryId || undefined)
      .then((res) => {
        if (!active) return;
        setConditionOptions(res.conditions);
        setConditionRequired(res.required);
        setConditionCategoryKnown(res.known);
      })
      .catch(() => {
        // Kein Fehlerbanner: ohne Liste bleibt das Feld einfach bei der
        // Voreinstellung. Ein Ladefehler darf das Datenblatt nicht stören.
        if (!active) return;
        setConditionOptions([]);
        setConditionCategoryKnown(false);
      });
    return () => {
      active = false;
    };
  }, [activeCategoryId]);

  const handleConditionSelect = useCallback((conditionId: string) => {
    setLocalProduct((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.details = next.details || {};
      if (conditionId) {
        next.details.conditionId = conditionId;
        // Wie bei der Kategorie: eine bewusste Eingabe wird als solche markiert,
        // damit Automatik sie nicht überschreibt.
        next.details.conditionSource = "manual";
      } else {
        delete next.details.conditionId;
        delete next.details.conditionSource;
      }
      return next;
    });
    setIsDirty(true);
  }, []);

  const handleCategorySelect = useCallback(
    (categoryId: string) => {
      if (!categoryId) return;
      setLocalProduct((prev) => {
        const next = JSON.parse(JSON.stringify(prev));
        next.details = next.details || {};
        next.identification = next.identification || {};
        const match = categoryOptions.find((opt) => String(opt.id) === String(categoryId));
        const resolvedId = match?.id ? String(match.id) : String(categoryId);
        next.details.categoryId = resolvedId;
        // B2: always set a human-readable category label alongside the id, so a
        // product can never end up with a categoryId but no readable name. Prefer
        // the breadcrumb, then the option name, then fall back to the id itself.
        next.identification.category = String(match?.breadcrumb || match?.name || resolvedId);
        // B2: mark source as manual so auto-resolvers do not override the user's choice
        next.details.categorySource = "manual";
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
    const primary = rawFeatures.map((feature) => (typeof feature === 'string' ? feature.trim() : '')).filter(Boolean);
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
    const raw = String(localProduct.details?.short_description || '').trim();
    if (raw) {
      return raw;
    }
    return t('sheet.description.empty');
  }, [localProduct.details?.short_description, t]);

  const descriptionIsHtml = useMemo(() => {
    return /<[a-z][\s\S]*>/i.test(descriptionText);
  }, [descriptionText]);

  const sanitizedDescription = useMemo(() => {
    if (!descriptionIsHtml) return '';
    return DOMPurify.sanitize(descriptionText, { USE_PROFILES: { html: true } });
  }, [descriptionText, descriptionIsHtml]);

  const requiresKTyp = useMemo(() => {
    const cat = (localProduct?.identification?.category || '').toString().toLowerCase();
    return cat.includes('auto') || cat.includes('kfz') || cat.includes('motorrad');
  }, [localProduct?.identification?.category]);

  const ktypValue = useMemo(() => {
    const attrs = localProduct?.details?.attributes || {};
    const key = Object.keys(attrs).find((k) => {
      const lower = String(k || '').trim().toLowerCase();
      return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ' || lower === 'ktype' || lower === 'k-type';
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

  const [activeTab, setActiveTab] = useState('stammdaten');

  // KI-Assistent-Tab: Höhe exakt an den sichtbaren Restplatz anpassen (die frühere
  // Konstante h-[calc(100vh-12rem)] unterschätzte den Kopfbereich → das Eingabefeld
  // wurde unten abgeschnitten). Gemessen wird die reale Oberkante des Panels.
  const assistantWrapRef = useRef<HTMLDivElement | null>(null);
  const [assistantHeight, setAssistantHeight] = useState<number | null>(null);
  useEffect(() => {
    if (activeTab !== 'assistent') return;
    const measure = () => {
      const el = assistantWrapRef.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      setAssistantHeight(Math.max(480, window.innerHeight - top - 16));
    };
    const raf = window.requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [activeTab]);

  // Notiz-Anzahl fürs Tab-Badge (aktualisiert sich, wenn im Tab eine Notiz dazukommt).
  const [notesCount, setNotesCount] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    if (!localProduct.id) return;
    import('../api/client').then(({ listProductNotes }) =>
      listProductNotes(localProduct.id)
        .then((notes) => { if (!cancelled) setNotesCount(notes.length); })
        .catch(() => {})
    );
    return () => { cancelled = true; };
  }, [localProduct.id]);

  const sheetTabs = useMemo(() => [
    { id: 'stammdaten', label: 'Stammdaten' },
    { id: 'bilder', label: 'Bilder', count: localProduct.details?.images?.length || 0 },
    { id: 'attribute', label: 'Attribute' },
    { id: 'marktplaetze', label: 'Marktplätze' },
    { id: 'notizen', label: 'Notizen', count: notesCount || undefined },
    { id: 'assistent', label: 'KI-Assistent' },
  ], [localProduct.details?.images?.length, notesCount]);

  return (
    <section id="product-sheet" className="w-full relative">
      {notification && (
        <div
          role="alert"
          aria-live="assertive"
          className={`fixed top-20 right-8 p-4 rounded-xl z-50 ${notification.type === 'success' ? 'bg-success' : 'bg-danger'} text-white`}
        >
          {notification.message}
        </div>
      )}

      {/* Schreib-Quittung: gesendet, aber NICHT gespeichert. Bleibt stehen,
          bis ein sauberer Speichervorgang gelingt oder der Nutzer schließt. */}
      {writeReceiptWarning && writeReceiptWarning.length > 0 && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-4 p-4 rounded-xl border border-danger bg-danger-dim"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-danger">
                Nicht gespeichert — {writeReceiptWarning.length} Angabe(n) fehlen im Datenblatt
              </p>
              <p className="text-xs text-txt-muted mt-1">
                Diese Werte stehen NICHT in der Datenbank und sind NICHT auf den Marktplätzen:
              </p>
              <ul className="mt-2 space-y-1">
                {writeReceiptWarning.map((m) => (
                  <li key={m.path} className="text-sm text-txt-secondary">
                    <span className="font-semibold text-txt-primary">{m.label}</span>
                    <span className="text-txt-muted"> — gewollt: „{m.wanted}"</span>
                  </li>
                ))}
              </ul>
            </div>
            <button
              onClick={() => setWriteReceiptWarning(null)}
              className="shrink-0 px-2 py-1 text-xs text-txt-muted hover:text-txt-primary"
              aria-label="Warnung schließen"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ─── HEADER ─────────────────────────────────────────── */}
      <header className="p-4 bg-app-surface border border-app-border rounded-2xl mb-4">
        <div className="flex items-start gap-4">
          {/* Product image */}
          {resolveImageSrc(localProduct.details?.images?.[0]) ? (
            <img
              src={resolveImageSrc(localProduct.details?.images?.[0])}
              alt=""
              className="w-20 h-20 rounded-xl object-cover flex-shrink-0 bg-app-elevated border border-app-border"
            />
          ) : (
            <div className="w-20 h-20 rounded-xl bg-app-elevated border border-app-border flex items-center justify-center flex-shrink-0">
              <svg className="w-8 h-8 text-txt-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
              </svg>
            </div>
          )}

          {/* Title + meta */}
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-txt-primary truncate leading-tight" title={localProduct.identification.name || "Unbenanntes Produkt"}>
              {localProduct.identification.name || <span className="italic text-txt-secondary">Unbenanntes Produkt</span>}
            </h1>
            <p className="text-sm text-txt-secondary mt-0.5 truncate">
              {localProduct.identification.brand}
              {localProduct.identification.brand && getProductDisplayCategory(localProduct) ? ' · ' : ''}
              {getProductDisplayCategory(localProduct)}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-txt-muted">
              <span>SKU: {localProduct.identification.sku || localProduct.details?.identifiers?.sku || '—'}</span>
              {currentBarcodeSummary.primaryBarcode && <span>{currentBarcodeSummary.primaryLabel}: {currentBarcodeSummary.primaryBarcode}</span>}
              {/* Header-Preis = VERKAUFSPREIS (konsistent zur Tabellen-Spalte "Preis").
                  Fallback Marktpreis nur wenn kein sellPrice gesetzt (Incident 2026-07-10). */}
              {(() => {
                const p = localProduct.details?.pricing;
                const sell = typeof p?.sellPrice === 'number' && p.sellPrice > 0 ? p.sellPrice : null;
                const market = p?.lowest_price?.amount != null ? p.lowest_price.amount : null;
                const shown = sell ?? market;
                if (shown == null) return null;
                return (
                  <span className="font-semibold text-txt-primary" title={sell != null ? 'Verkaufspreis' : 'Marktpreis (kein Verkaufspreis gesetzt)'}>
                    {shown.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €
                    {sell == null ? <span className="ml-1 font-normal text-[10px] text-warning">Marktpreis</span> : null}
                  </span>
                );
              })()}
              {/* Listing status badges inline */}
              {(localProduct as any)?.ops?.listingStatus?.ebay === 'active' && (
                <span className="inline-flex items-center rounded-full bg-success-dim px-2 py-0.5 text-[10px] font-semibold text-success">eBay</span>
              )}
              {(localProduct as any)?.ops?.listingStatus?.kaufland === 'active' && (
                <span className="inline-flex items-center rounded-full bg-success-dim px-2 py-0.5 text-[10px] font-semibold text-success">Kaufland</span>
              )}
              {/* V4 pipeline-provenance badge (no-op for V3/legacy products) */}
              <IdentifyV4Badge product={localProduct} compact />
            </div>
          </div>

          {/* Action buttons — top right */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Readiness status + editor initials */}
            <div className="flex items-center gap-1.5 mr-2">
              <select
                value={normalizeReadiness(localProduct.ops?.readiness)}
                onChange={(e) => handleReadinessChange(e.target.value as Readiness)}
                className="px-2 py-1.5 text-sm rounded-lg bg-app-elevated text-txt-primary border border-app-border"
              >
                <option value="pending">{READINESS_LABELS.pending}</option>
                <option value="in_progress">{READINESS_LABELS.in_progress}</option>
                <option value="ready">{READINESS_LABELS.ready}</option>
              </select>
              {localProduct.ops?.readiness_editor && (
                <span className="text-xs text-txt-muted font-medium">
                  {localProduct.ops.readiness_editor}
                </span>
              )}
            </div>
            <button
              id="btn-edit"
              onClick={handleToggleEdit}
              aria-pressed={isEditing}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${isEditing ? 'bg-accent text-white' : 'bg-app-elevated text-txt-primary hover:bg-app-border border border-app-border'}`}
            >
              <EditIcon className="w-3.5 h-3.5" />
              {isEditing ? t('common.editing') : t('common.edit')}
            </button>
            <button
              id="btn-save"
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-success/20 text-success hover:bg-success/30 transition-colors disabled:opacity-40"
            >
              <SaveIcon className="w-3.5 h-3.5" />
              {isSaving ? t('common.saving') : t('common.save')}
            </button>
            {onImprove && (
              <button
                type="button"
                onClick={() => onImprove(localProduct.id)}
                disabled={Boolean(isImproving)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-accent-dim text-accent hover:bg-accent/20 transition-colors disabled:opacity-40"
              >
                {isImproving ? t('common.improving') : t('common.improve')}
              </button>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
                aria-label="Schließen"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ─── V4 Needs-Review Banner (only shown for V4-produced products) ─── */}
      <div className="mb-3">
        <IdentifyV4Badge product={localProduct} />
      </div>

      {/* ─── TABS ───────────────────────────────────────────── */}
      <Tabs tabs={sheetTabs} activeTab={activeTab} onTabChange={setActiveTab} className="mb-4" />

      {/* ─── TAB: Stammdaten ────────────────────────────────── */}
      <TabPanel tabId="stammdaten" activeTab={activeTab} className="space-y-5">
        {/* Title editing */}
        <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
          <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide mb-3">Produkt</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-txt-secondary mb-1">Titel</label>
              {isEditing ? (
                <div>
                  <textarea
                    id="p-name"
                    aria-label={t('common.productName') || 'Produktname'}
                    value={localProduct.identification.name}
                    onChange={(e) => handleFieldChange('identification.name', e.target.value)}
                    className={`w-full text-sm bg-app-elevated border rounded-lg p-2.5 outline-none resize-y min-h-[3rem] ${
                      hasQualityIssue('identification.name') ? 'border-danger' : 'border-app-border focus:border-accent'
                    }`}
                    rows={2}
                  />
                  <div className="flex justify-end mt-0.5">
                    <span className={`text-[11px] tabular-nums ${(localProduct.identification.name?.length || 0) > 80 ? 'text-danger font-semibold' : 'text-txt-muted'}`}>
                      {localProduct.identification.name?.length || 0}/80
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-txt-primary">{localProduct.identification.name || <span className="italic text-txt-secondary">Unbenanntes Produkt</span>}</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-txt-secondary mb-1">Marke</label>
                {isEditing ? (
                  <input
                    value={localProduct.identification.brand}
                    onChange={(e) => handleFieldChange('identification.brand', e.target.value)}
                    className={`w-full text-sm bg-app-elevated border rounded-lg px-3 py-2 outline-none ${hasQualityIssue('identification.brand') ? 'border-danger' : 'border-app-border focus:border-accent'}`}
                  />
                ) : (
                  <p className="text-sm text-txt-primary">{localProduct.identification.brand || '—'}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-txt-secondary mb-1">Kategorie</label>
                {isEditing ? (
                  <div className="space-y-1">
                    <input
                      value={categoryQuery}
                      onChange={(e) => setCategoryQuery(e.target.value)}
                      placeholder="eBay Kategorie suchen..."
                      className={`w-full text-sm bg-app-elevated border rounded-lg px-3 py-2 outline-none ${hasQualityIssue('details.categoryId') ? 'border-danger' : 'border-app-border focus:border-accent'}`}
                    />
                    <select
                      value={getProductEbayCategoryId(localProduct) || ''}
                      onChange={(e) => handleCategorySelect(e.target.value)}
                      className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-2"
                    >
                      <option value="">Kategorie auswählen...</option>
                      {categorySelectOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.breadcrumb} ({option.id})</option>
                      ))}
                    </select>
                    {categoryLoading && <span className="text-[10px] text-txt-muted">Lade...</span>}
                  </div>
                ) : (
                  <p className="text-sm text-txt-primary">{getProductDisplayCategory(localProduct) || '—'}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-txt-secondary mb-1">
                  Artikelzustand
                  {conditionRequired && <span className="ml-1 text-danger" title="eBay verlangt in dieser Kategorie einen Zustand">*</span>}
                </label>
                {isEditing ? (
                  <div className="space-y-1">
                    <select
                      value={localProduct.details?.conditionId || ''}
                      onChange={(e) => handleConditionSelect(e.target.value)}
                      disabled={conditionCategoryKnown && conditionOptions.length === 0}
                      className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-2 disabled:opacity-50"
                    >
                      <option value="">Neu (Standard)</option>
                      {conditionOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.name}</option>
                      ))}
                    </select>
                    {conditionCategoryKnown && conditionOptions.length === 0 && (
                      <span className="text-[10px] text-txt-muted">Diese Kategorie führt keinen Artikelzustand.</span>
                    )}
                    {!conditionCategoryKnown && activeCategoryId && (
                      <span className="text-[10px] text-txt-muted">Allgemeine Liste — für diese Kategorie liegen keine eBay-Vorgaben vor.</span>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-txt-primary">
                    {conditionOptions.find((c) => c.id === localProduct.details?.conditionId)?.name
                      || (localProduct.details?.conditionId ? localProduct.details.conditionId : 'Neu (Standard)')}
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-txt-secondary mb-1">Beschreibung</label>
              {isEditing ? (
                <textarea
                  defaultValue={localProduct.details.short_description}
                  onBlur={(e) => handleFieldChange('details.short_description', e.target.value)}
                  className="w-full min-h-[80px] text-sm bg-app-elevated border border-app-border rounded-lg p-2.5 outline-none focus:border-accent"
                />
              ) : descriptionIsHtml ? (
                <div
                  className="text-sm text-txt-secondary leading-relaxed prose prose-sm prose-invert max-w-none [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:mb-1 [&_p]:mb-2 [&_strong]:font-semibold [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_a]:text-accent [&_a]:underline"
                  dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
                />
              ) : (
                <p className="text-sm text-txt-secondary leading-relaxed">{descriptionText || '—'}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-txt-secondary mb-1">Highlights</label>
              {isEditing ? (
                <textarea
                  defaultValue={(localProduct.details.key_features || []).join('\n')}
                  onBlur={(e) => {
                    const lines = e.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
                    setLocalProduct((prev) => ({ ...prev, details: { ...prev.details, key_features: lines } }));
                    setIsDirty(true);
                  }}
                  placeholder="Ein Highlight pro Zeile..."
                  className="w-full min-h-[60px] text-sm bg-app-elevated border border-app-border rounded-lg p-2.5 outline-none focus:border-accent"
                />
              ) : highlightList.length ? (
                <ul className="space-y-1 list-disc list-inside text-sm text-txt-secondary">
                  {highlightList.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              ) : (
                <p className="text-sm text-txt-muted">—</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-txt-secondary mb-1">Lieferumfang</label>
              {isEditing ? (
                <textarea
                  defaultValue={(localProduct.details.scope_of_delivery || []).join('\n')}
                  onBlur={(e) => {
                    const lines = e.target.value.split('\n').map((line) => line.trim()).filter(Boolean);
                    setLocalProduct((prev) => ({ ...prev, details: { ...prev.details, scope_of_delivery: lines } }));
                    setIsDirty(true);
                  }}
                  placeholder="Eine Position pro Zeile, z. B. 1x Aluminium-Koffer"
                  className="w-full min-h-[60px] text-sm bg-app-elevated border border-app-border rounded-lg p-2.5 outline-none focus:border-accent"
                />
              ) : (localProduct.details.scope_of_delivery || []).length ? (
                <ul className="space-y-1 list-disc list-inside text-sm text-txt-secondary">
                  {(localProduct.details.scope_of_delivery || []).map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              ) : (
                <p className="text-sm text-txt-muted">—</p>
              )}
            </div>
          </div>
        </section>

        {/* Identifiers + Pricing side by side */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
            <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide mb-3">Identifikatoren</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-txt-secondary mb-1">SKU</label>
                <div className="flex items-center gap-2">
                  <p className="text-sm text-txt-primary font-mono">{localProduct.identification.sku || localProduct.details?.identifiers?.sku || '—'}</p>
                  <button onClick={handlePrintLabel} disabled={!localProduct.identification.sku || isPrintingLabel} className="text-txt-muted hover:text-txt-primary transition-colors" title="SKU-Label drucken">
                    <PrintIcon className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-txt-secondary mb-1">Barcodes (EAN / UPC / GTIN)</label>
                {isEditing ? (
                  <div className="space-y-2">
                    {(['ean', 'upc', 'gtin'] as IdentifierField[]).map((field) => {
                      const validation = validateIdentifierField(field, idFields[field]);
                      const showError = !validation.ok;
                      return (
                        <div key={field}>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-semibold text-txt-muted w-11 shrink-0">{identifierFieldLabel[field]}</span>
                            <input
                              value={idFields[field]}
                              onChange={(e) => applyIdField(field, e.target.value)}
                              inputMode="numeric"
                              placeholder={field === 'ean' ? '13 (oder 8) Stellen' : field === 'upc' ? '12 Stellen' : '14 Stellen'}
                              className={`flex-1 text-sm bg-app-elevated border rounded-lg px-3 py-2 outline-none font-mono ${showError ? 'border-danger focus:border-danger' : 'border-app-border focus:border-accent'}`}
                            />
                          </div>
                          {showError && (
                            <p className="text-[11px] text-danger mt-0.5 ml-[3.25rem]">
                              {validation.reason === 'length'
                                ? `${identifierFieldLabel[field]} braucht ${validation.expected.join(' oder ')} Stellen`
                                : 'Prüfziffer ungültig'}
                            </p>
                          )}
                        </div>
                      );
                    })}
                    <p className="text-[11px] text-txt-muted">Je Typ genau ein Code. Feld leeren = Code entfernen.</p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {currentBarcodeSummary.all.length ? currentBarcodeSummary.all.map((b: string, i: number) => (
                      <span key={i} className="inline-flex items-center gap-1.5 text-sm font-mono text-txt-primary">
                        {b}
                        {isValidGtin(b) && <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" title={`Gültige ${getGtinLabel(b)}`} />}
                        <button
                          type="button"
                          className="text-txt-muted hover:text-txt-primary transition-colors"
                          title="Kopieren"
                          onClick={() => navigator.clipboard.writeText(b)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                        </button>
                      </span>
                    )) : <span className="text-sm text-txt-muted">—</span>}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-txt-secondary mb-1">MPN</label>
                  {isEditing ? (
                    <input
                      value={localProduct.details?.identifiers?.mpn || ''}
                      onChange={(e) => handleFieldChange('details.identifiers.mpn', e.target.value)}
                      placeholder="Herstellerteilenr."
                      className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-2 outline-none focus:border-accent font-mono"
                    />
                  ) : (
                    <p className="text-sm text-txt-primary font-mono">{localProduct.details?.identifiers?.mpn || '—'}</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold text-txt-secondary mb-1">Gewicht (kg)</label>
                  {(() => {
                    const weightValue =
                      localProduct.details?.weight
                      ?? localProduct.details?.attributes?.weight
                      ?? localProduct.details?.attributes?.['Gewicht (kg)']
                      ?? localProduct.details?.attributes?.['Gewicht']
                      ?? '';
                    const displayWeight = weightValue !== '' ? `${weightValue} kg` : '—';

                    return isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        value={typeof weightValue === 'boolean' ? String(weightValue) : weightValue}
                        onChange={(e) => handleFieldChange('details.weight', e.target.value ? parseFloat(e.target.value) : null)}
                        placeholder="z.B. 2.5"
                        className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-2 outline-none focus:border-accent font-mono"
                      />
                    ) : (
                      <p className="text-sm text-txt-primary font-mono">{displayWeight}</p>
                    );
                  })()}
                </div>
              </div>
            </div>
          </section>

          <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
            <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide mb-3">Preis & Lager</h3>
            <PricingInfo
              pricing={localProduct.details?.pricing}
              isEditing={isEditing}
              onChange={(next) => { setLocalProduct(prev => ({ ...prev, details: { ...prev.details, pricing: next } })); setIsDirty(true); }}
            />
            {(() => {
              const pricing = localProduct.details?.pricing;
              const suggestedPrice = pricing?.suggestedPrice;
              if (!suggestedPrice) return null;
              const tier = pricing?.pricingTier;
              const currentAmount = pricing?.lowest_price?.amount;
              const tierConfig: Record<number, { label: string; cls: string }> = {
                1: { label: 'Tier 1', cls: 'bg-success-dim text-success' },
                2: { label: 'Tier 2', cls: 'bg-warning-dim text-warning' },
                0: { label: 'Kosten', cls: 'bg-app-elevated text-txt-muted' },
              };
              const cfg = tier != null ? (tierConfig[tier] ?? tierConfig[0]) : null;
              const diff = currentAmount && currentAmount > 0 ? Math.round(((suggestedPrice - currentAmount) / currentAmount) * 100) : null;
              return (
                <div className="mt-3 pt-3 border-t border-app-border">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-txt-muted font-medium">Vorschlag</span>
                    {cfg && <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${cfg.cls}`}>{cfg.label}</span>}
                    {diff != null && <span className={`text-xs font-medium ${diff > 0 ? 'text-success' : diff < 0 ? 'text-danger' : 'text-txt-muted'}`}>{diff > 0 ? `+${diff}%` : `${diff}%`}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-txt-primary">{suggestedPrice.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</span>
                    <button type="button" onClick={() => { setLocalProduct(prev => ({ ...prev, details: { ...prev.details, pricing: { ...prev.details?.pricing, sellPrice: suggestedPrice, lowest_price: { ...(prev.details?.pricing?.lowest_price || {}), amount: suggestedPrice } } } })); setIsDirty(true); }} className="rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-white hover:bg-accent/80">Übernehmen</button>
                  </div>
                </div>
              );
            })()}
            {currentBarcodeSummary.primaryBarcode && (
              <div className="mt-3 pt-3 border-t border-app-border">
                {/* Vergleichsgrundlage ist der VERKAUFSPREIS — der Preis, den
                    eBay/Kaufland sehen. Bis 2026-08-16 stand hier
                    `lowest_price` (der recherchierte Marktpreis): ein
                    Konkurrent, der den echten Angebotspreis unterbot, erschien
                    dadurch grün als "teurer als du". Der zweite Aufrufer
                    derselben Ansicht (pricing/ProductPricingDetail.tsx) nutzt
                    seit jeher sellPrice. */}
                <CompetitorPrices ean={currentBarcodeSummary.primaryBarcode} ownPrice={localProduct.details?.pricing?.sellPrice ?? localProduct.details?.pricing?.lowest_price?.amount} storedPrices={localProduct.details?.pricing?.competitorPrices} lastPriceCheck={localProduct.details?.pricing?.lastPriceCheck} />
              </div>
            )}
          </section>
        </div>

        {/* GPSR — Hersteller (nur bei echten Hersteller-Kontaktdaten, z. B. EU-Fertigung).
            Bei Nicht-EU-Importen trägt die EU-Verantwortliche Person die GPSR-Pflicht. */}
        {showManufacturerBlock && (
        <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide">GPSR / Hersteller</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {([
              ['manufacturer_name', 'Hersteller'],
              ['manufacturer_address', 'Adresse'],
              ['manufacturer_city', 'Stadt'],
              ['manufacturer_postalcode', 'PLZ'],
              ['entity_country', 'Land'],
              ['email', 'E-Mail'],
              ['manufacturer_phone', 'Telefon'],
              ['url', 'Website'],
            ] as [string, string][]).map(([key, label]) => {
              const value = typeof gpsr?.[key] === 'string' ? gpsr[key] : '';
              return (
                <div key={key}>
                  <label className="block text-xs text-txt-muted mb-0.5">{label}</label>
                  {isEditing ? (
                    <input value={value} onChange={(e) => updateGpsrField(key, e.target.value)} className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-2.5 py-1.5" placeholder="—" />
                  ) : (
                    <p className="text-sm text-txt-secondary">{value || '—'}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        )}

        {/* GPSR — EU-Verantwortlicher (Pflicht bei Nicht-EU-Herstellern) */}
        <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide">GPSR / EU-Verantwortlicher</h3>
          </div>
          <p className="text-xs text-txt-muted mb-3">Pflicht bei Herstellern außerhalb der EU (z. B. China, USA, UK, Schweiz).</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {([
              ['eu_responsible_name', 'Firma'],
              ['eu_responsible_address', 'Adresse'],
              ['eu_responsible_city', 'Stadt'],
              ['eu_responsible_postalcode', 'PLZ'],
              ['eu_responsible_state_province', 'Bundesland'],
              ['eu_responsible_country', 'Land'],
              ['eu_responsible_email', 'E-Mail'],
              ['eu_responsible_phone', 'Telefon'],
            ] as [string, string][]).map(([key, label]) => {
              const value = typeof gpsr?.[key] === 'string' ? gpsr[key] : '';
              return (
                <div key={key}>
                  <label className="block text-xs text-txt-muted mb-0.5">{label}</label>
                  {isEditing ? (
                    <input value={value} onChange={(e) => updateGpsrField(key, e.target.value)} className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-2.5 py-1.5" placeholder="—" />
                  ) : (
                    <p className="text-sm text-txt-secondary">{value || '—'}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Storage */}
        <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
          <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide mb-3">{t('sheet.storage')}</h3>
          {binsLoading ? (
            <p className="text-txt-muted text-sm">{t('sheet.storage.loading')}</p>
          ) : binsError ? (
            <p className="text-danger text-sm">{binsError}</p>
          ) : productBins.length ? (
            <div className="mb-3 space-y-1.5 max-h-40 overflow-auto">
              {productBins.map((bin) => (
                <div key={bin.code} className="flex items-center justify-between rounded-lg border border-app-border bg-app-bg/60 px-3 py-1.5 text-sm">
                  <span className="font-semibold text-txt-primary">{bin.code}</span>
                  <span className="text-xs text-txt-muted">Zone {bin.zone} · Gang {bin.gang} · Menge {bin.quantity ?? bin.productCount ?? 0}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-txt-muted text-sm mb-3">{t('sheet.storage.none')}</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-txt-muted mb-1">{t('sheet.storage.binLabel')}</label>
              <input value={binCodeInput} onChange={(e) => setBinCodeInput(e.target.value.toUpperCase())} placeholder={t('sheet.storage.binPlaceholder')} className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-1.5" />
            </div>
            <div>
              <label className="block text-xs text-txt-muted mb-1">{t('sheet.storage.quantity')}</label>
              <input type="number" min={1} value={binQuantity} onChange={(e) => setBinQuantity(Number(e.target.value))} className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-1.5" />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={handleAssignBin} disabled={isAssigningBin} className="px-3 py-1.5 text-sm bg-accent-dim text-accent rounded-lg hover:bg-accent/20 disabled:opacity-40">{isAssigningBin ? t('sheet.storage.assigning') : t('sheet.storage.assign')}</button>
            {binCodeInput && (
              <button
                onClick={requestStockOut}
                disabled={isAssigningBin || isRemovingBin}
                className="px-3 py-1.5 text-sm bg-danger/20 text-danger rounded-lg hover:bg-danger/30 disabled:opacity-40"
              >
                {t('sheet.storage.stockOut', { qty: Number(binQuantity) || 1, bin: binCodeInput.toUpperCase() })}
              </button>
            )}
          </div>
          {binReceipt && (
            <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-sm">
              <span className="text-txt-primary">
                {t(binReceipt.action === 'in' ? 'sheet.storage.receiptIn' : 'sheet.storage.receiptOut', {
                  qty: binReceipt.qty,
                  bin: binReceipt.bin,
                  after: binReceipt.stockAfter == null ? '—' : binReceipt.stockAfter,
                })}
              </span>
              <button
                onClick={() => setBinReceipt(null)}
                className="shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold text-txt-secondary hover:bg-white/10"
                aria-label={t('sheet.storage.receiptDismiss')}
              >
                ✕
              </button>
            </div>
          )}
          {localProduct.ops?.sourceLot && (
            <div className="mt-3 px-3 py-2 rounded-lg bg-app-elevated border border-app-border text-sm">
              <span className="text-txt-muted">Los: </span>
              <span className="font-semibold text-txt-primary">{localProduct.ops.sourceLot}</span>
              {localProduct.ops.sourceLotAt && (
                <span className="text-txt-muted text-xs ml-2">
                  (seit {new Date(localProduct.ops.sourceLotAt).toLocaleDateString('de-DE')})
                </span>
              )}
            </div>
          )}
        </section>

      </TabPanel>

      {/* ─── TAB: Bilder ────────────────────────────────────── */}
      <TabPanel tabId="bilder" activeTab={activeTab} className="space-y-5">
        <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
          <ImageGallery
            images={localProduct.details.images}
            resetKey={localProduct.id}
            isEditing={isEditing}
            productId={localProduct.id}
            onDeleteImage={isEditing ? handleDeleteImage : undefined}
            onReorder={isEditing ? handleReorderImages : undefined}
            onUpdateImage={isEditing ? handleUpdateImage : undefined}
            onAddImage={isEditing ? handleInsertImage : undefined}
          />
          {isEditing && (
            <div className="mt-4 space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  placeholder={t('sheet.upload.urlPlaceholder')}
                  className="flex-1 text-sm bg-app-elevated border border-app-border rounded-lg p-2"
                  value={newImageUrl}
                  onChange={(e) => setNewImageUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddImageFromUrl(); } }}
                />
                <button onClick={handleAddImageFromUrl} disabled={!newImageUrl.trim()} className="px-4 py-2 text-sm bg-app-elevated rounded-lg text-txt-primary font-medium hover:bg-app-border disabled:opacity-50">{t('sheet.upload.urlButton')}</button>
              </div>
              <div
                className={`rounded-xl border-2 border-dashed p-4 text-center text-sm transition-colors ${isUploadDragActive ? 'border-accent bg-app-elevated/60' : 'border-app-border bg-app-bg/40'}`}
                onDragOver={handleUploadDragOver} onDragEnter={handleUploadDragOver} onDragLeave={handleUploadDragLeave} onDrop={handleUploadDrop}
              >
                <p className="text-sm font-semibold text-txt-primary">{t('sheet.upload.dragTitle')}</p>
                <p className="text-txt-muted mt-1 text-xs">{t('sheet.upload.dragHint')}</p>
                <label className="mt-2 inline-block cursor-pointer rounded-full border border-app-border px-3 py-1 text-xs text-txt-primary">
                  {t('sheet.upload.fileBtn')}
                  <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { handleUploadImages(e.target.files); if (e.target) e.target.value = ''; }} />
                </label>
              </div>
              <div className="pt-3 border-t border-app-border">
                <label className="block text-xs font-semibold text-txt-secondary mb-1">{t('sheet.ai.referenceLabel')}</label>
                {referenceImages.length ? (
                  <select className="w-full text-sm bg-app-elevated border border-app-border rounded-lg px-3 py-2" value={selectedReferenceIndex >= 0 ? selectedReferenceIndex : ''} onChange={(e) => setSelectedReferenceIndex(Number(e.target.value))}>
                    {referenceImages.map((img, i) => <option key={`${img.url_or_base64}-${i}`} value={i}>{`Bild ${i + 1}`}</option>)}
                  </select>
                ) : <p className="text-xs text-txt-muted">{t('sheet.ai.noReference')}</p>}
                <button onClick={handleGenerateImages} disabled={isGeneratingImages || !selectedReferenceImage} className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-white font-medium rounded-xl hover:bg-accent/80 disabled:opacity-40">
                  {isGeneratingImages ? <Spinner className="w-4 h-4" /> : <MagicIcon className="w-4 h-4" />}
                  {isGeneratingImages ? t('sheet.ai.running') : t('sheet.ai.cta')}
                </button>
              </div>
            </div>
          )}
        </section>
      </TabPanel>

      {/* ─── TAB: Attribute ─────────────────────────────────── */}
      <TabPanel tabId="attribute" activeTab={activeTab} className="space-y-5">
        <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
          {/* K-Typ */}
          <div className="mb-4 rounded-lg border border-app-border bg-app-bg/60 p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-semibold text-txt-secondary">K-Typ</span>
              {requiresKTyp && !ktypValue && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-warning-dim text-warning">Pflicht</span>}
            </div>
            {isEditing ? (
              <textarea
                defaultValue={ktypValue}
                placeholder="19974|57446|57448"
                onBlur={(e) => {
                  const nextVal = e.target.value.trim();
                  setLocalProduct((prev) => {
                    const nextAttrs = { ...(prev.details.attributes || {}) } as Record<string, any>;
                    if (!nextVal) { Object.keys(nextAttrs).forEach((k) => { if (['k-typ','ktyp','k typ','ktype','k-type'].includes(k.trim().toLowerCase())) delete nextAttrs[k]; }); }
                    else { nextAttrs['K-Typ'] = nextVal; }
                    return { ...prev, details: { ...prev.details, attributes: nextAttrs } };
                  });
                  setIsDirty(true);
                }}
                className="w-full min-h-[50px] text-sm bg-app-elevated border border-app-border rounded-lg p-2 font-mono"
              />
            ) : (
              <p className="text-sm text-txt-secondary font-mono">{ktypValue || '—'}</p>
            )}
          </div>

          {localProduct?.ops?.data_quality?.ktype_enrich_v1 ? (
            <details className="mb-4 rounded-lg border border-app-border bg-app-bg/60 p-3">
              <summary className="cursor-pointer text-sm font-semibold text-txt-secondary">K-Typ Trace</summary>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-txt-muted">{JSON.stringify(localProduct.ops.data_quality.ktype_enrich_v1, null, 2)}</pre>
            </details>
          ) : null}

          <AttributeTable
            attributes={localProduct.details.attributes}
            isEditing={isEditing}
            highlightKeys={qualityAttributeHighlightKeys}
            onChange={(next) => { setLocalProduct(prev => ({ ...prev, details: { ...prev.details, attributes: next } })); setIsDirty(true); }}
          />
        </section>
      </TabPanel>

      {/* ─── TAB: Marktplätze ───────────────────────────────── */}
      <TabPanel tabId="marktplaetze" activeTab={activeTab} className="space-y-5">
        {/* Pre-Listing Validation (VAL-001) */}
        <ValidationPanel product={localProduct} />

        <section className="p-5 bg-app-surface border border-app-border rounded-2xl">
          <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide mb-4">Listing-Status</h3>
          <div className="space-y-3">
            {/* eBay */}
            <div className="rounded-lg border border-app-border bg-app-bg/60 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-txt-primary">eBay</span>
                {(localProduct as any)?.ops?.listingStatus?.ebay === 'active' ? (
                  <span className="inline-flex items-center rounded-full bg-success-dim px-3 py-1 text-xs font-semibold text-success">Gelistet</span>
                ) : (localProduct as any)?.ops?.listingStatus?.ebay === 'inactive' ? (
                  <span className="inline-flex items-center rounded-full bg-warning-dim px-3 py-1 text-xs font-semibold text-warning">Inaktiv</span>
                ) : (
                  <span className="text-xs text-txt-muted">Nicht gelistet</span>
                )}
              </div>
              {((localProduct as any)?.ops?.ebay?.itemId || (localProduct as any)?.ops?.ebay?.item_id) && (
                <div className="mt-2 text-xs text-txt-muted">
                  Item-ID: <span className="font-mono text-txt-secondary">{(localProduct as any).ops.ebay.itemId || (localProduct as any).ops.ebay.item_id}</span>
                </div>
              )}
            </div>
            {/* Kaufland */}
            <div className="rounded-lg border border-app-border bg-app-bg/60 px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-txt-primary">Kaufland</span>
                {(localProduct as any)?.ops?.listingStatus?.kaufland === 'active' ? (
                  <span className="inline-flex items-center rounded-full bg-success-dim px-3 py-1 text-xs font-semibold text-success">Gelistet</span>
                ) : (localProduct as any)?.ops?.listingStatus?.kaufland === 'inactive' ? (
                  <span className="inline-flex items-center rounded-full bg-warning-dim px-3 py-1 text-xs font-semibold text-warning">Inaktiv</span>
                ) : (
                  <span className="text-xs text-txt-muted">Nicht gelistet</span>
                )}
              </div>
              {((localProduct as any)?.ops?.kaufland?.unitId || (localProduct as any)?.ops?.kaufland?.id_unit) && (
                <div className="mt-2 text-xs text-txt-muted">
                  Unit-ID: <span className="font-mono text-txt-secondary">{(localProduct as any).ops.kaufland.unitId || (localProduct as any).ops.kaufland.id_unit}</span>
                </div>
              )}
            </div>
          </div>
          {(localProduct as any)?.ops?.listingStatus?.lastSyncAt && (
            <p className="text-xs text-txt-muted mt-3">Letzter Sync: {new Date((localProduct as any).ops.listingStatus.lastSyncAt).toLocaleString('de-DE')}</p>
          )}
        </section>
      </TabPanel>

      {/* ─── TAB: Notizen (interne Mitarbeiter-Kommentare) ───── */}
      <TabPanel tabId="notizen" activeTab={activeTab} className="space-y-5">
        <ProductNotes productId={localProduct.id} onCountChange={setNotesCount} />
      </TabPanel>

      {/* ─── TAB: KI-Assistent ──────────────────────────────── */}
      {/* keepMounted: chat state (messages, pending suggestions, in-flight stream) must
          survive tab switches. Otherwise users lose the "Übernehmen" button on the last
          assistant suggestion (datasheetChanges live only in component state) and the
          last user message can race the async server-side session persistence. */}
      <TabPanel tabId="assistent" activeTab={activeTab} keepMounted>
        <div ref={assistantWrapRef} style={assistantHeight ? { height: assistantHeight } : undefined} className="min-h-[480px]">
          <AssistantChat
            product={localProduct}
            onApplyDatasheetChange={applyAssistantChange}
            onAddImages={applyAssistantImages}
          />
        </div>
      </TabPanel>

      <ConfirmDialog
        open={Boolean(stockOutConfirm)}
        tone="danger"
        title={t('sheet.storage.stockOutTitle', { qty: stockOutConfirm?.qty ?? 0 })}
        description={t('sheet.storage.stockOutBody', {
          qty: stockOutConfirm?.qty ?? 0,
          bin: stockOutConfirm?.bin ?? '',
          sku: localProduct.id,
        })}
        confirmLabel={t('sheet.storage.stockOutConfirm')}
        confirmBusy={isRemovingBin}
        onConfirm={performStockOut}
        onCancel={() => setStockOutConfirm(null)}
      />
    </section>
  );
};

export default ProductSheet;
