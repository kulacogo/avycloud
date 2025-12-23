import { Product, ProductEnrichmentRecord, ProductImage } from '../types';
import { isValidGtin, normalizeBarcode } from './gtin';

const UNKNOWN = 'unknown';

const normalizeValue = (value?: string | null) => {
  if (!value) return '';
  const trimmed = value.toString().trim();
  if (!trimmed) return '';
  if (trimmed.toLowerCase() === UNKNOWN) return '';
  return trimmed;
};

const isUnknownToken = (value?: string | null) => {
  const trimmed = (value ?? '').toString().trim().toLowerCase();
  if (!trimmed) return true;
  if (trimmed === UNKNOWN) return true;
  if (trimmed === 'unbekannt') return true;
  if (trimmed.startsWith('unbekannt')) return true; // "unbekannte Marke", "unbekanntes Produkt", ...
  if (trimmed.startsWith('unknown')) return true; // "unknown brand", ...
  return false;
};

export const isEnrichmentRecordIdentified = (record: ProductEnrichmentRecord): boolean => {
  const barcodeCandidates = [record.gtin, record.ean, record.upc]
    .map(normalizeValue)
    .map(normalizeBarcode)
    .filter(Boolean);
  const hasValidBarcode = barcodeCandidates.some((code) => isValidGtin(code));

  const brand = normalizeValue(record.brand);
  const model = normalizeValue(record.model);
  const variant = normalizeValue(record.variant);
  const hasBrand = brand.length >= 2 && !isUnknownToken(brand);
  const hasModel = model.length >= 2 && !isUnknownToken(model);
  const hasVariant = variant.length >= 2 && !isUnknownToken(variant);

  const category = normalizeValue(record.internalCategory);
  const hasCategory =
    category.length >= 3 && !isUnknownToken(category) && category.toLowerCase() !== 'unkategorisiert';

  const titleCandidate = normalizeValue(record.title_ebay) || normalizeValue(record.title_kaufland);
  const hasMeaningfulTitle =
    titleCandidate.length >= 6 &&
    !isUnknownToken(titleCandidate) &&
    !/^(artikel|produkt)$/i.test(titleCandidate);

  // Recognized if we have a strong identifier, or meaningful descriptive signals.
  return (
    hasValidBarcode ||
    (hasBrand && (hasModel || hasVariant)) ||
    hasCategory ||
    hasMeaningfulTitle
  );
};

const dedupe = <T>(values: T[]) => Array.from(new Set(values));

const parseBarcodeString = (input?: string) =>
  input
    ? input
        .split(/[\s,;|]+/)
        .map((entry) => normalizeBarcode(entry.trim()))
        .filter(Boolean)
    : [];

const buildImages = (record: ProductEnrichmentRecord): ProductImage[] => {
  const images: ProductImage[] = [];
  if (normalizeValue(record.heroImageUrl)) {
    images.push({
      source: 'upload',
      variant: 'front',
      url_or_base64: record.heroImageUrl,
      notes: 'pipeline-v2 hero',
    });
  }
  (record.galleryImageUrls || []).forEach((url, index) => {
    if (!normalizeValue(url)) return;
    images.push({
      source: 'upload',
      variant: index % 2 === 0 ? 'detail' : 'other',
      url_or_base64: url,
      notes: 'pipeline-v2 gallery',
    });
  });
  return images;
};

const buildAttributes = (record: ProductEnrichmentRecord) => {
  const attributes: Record<string, string> = {};
  const add = (key?: string, value?: string) => {
    const normalizedKey = normalizeValue(key);
    const normalizedValue = normalizeValue(value);
    if (!normalizedKey || !normalizedValue) return;
    attributes[normalizedKey] = normalizedValue;
  };

  (record.item_specifics || []).forEach((attr) => add(attr.key, attr.value));
  (record.attributes_kaufland || []).forEach((attr) => add(attr.key, attr.value));
  add('eBay Kategorie', record.ebayCategoryPath);
  add('Kaufland Kategorie', record.kauflandCategoryPath);
  add('Zustand', record.condition);
  add('Farbe', record.color);
  add('Material', record.material);
  add('Größe', record.size);
  return attributes;
};

const buildKeyFeatures = (record: ProductEnrichmentRecord) => {
  const features =
    record.item_specifics
      ?.map((attr) => {
        const key = normalizeValue(attr.key);
        const value = normalizeValue(attr.value);
        if (!key || !value) return null;
        return `${key}: ${value}`;
      })
      .filter(Boolean) || [];
  if (features.length >= 4) {
    return features.slice(0, 6) as string[];
  }
  const description =
    normalizeValue(record.description_kaufland) || normalizeValue(record.description_ebay);
  if (description) {
    const sentences = description.split(/[\n•\.]/).map((sentence) => sentence.trim()).filter(Boolean);
    features.push(...sentences.slice(0, 6));
  }
  return features.length ? (features.slice(0, 6) as string[]) : ['Bitte Highlights ergänzen.'];
};

export interface BuildProductOptions {
  fallbackId?: string;
  barcodes?: string;
  label?: string;
  inventoryId?: string | null;
  inventoryName?: string | null;
}

export const buildProductFromEnrichment = (
  record: ProductEnrichmentRecord,
  options?: BuildProductOptions
): Product => {
  const identified = isEnrichmentRecordIdentified(record);
  const identifierCandidates = [
    normalizeValue(record.ean),
    normalizeValue(record.gtin),
    normalizeValue(record.upc),
    normalizeValue(record.sku),
  ].filter(Boolean);
  const productId = identifierCandidates[0] || options?.fallbackId || `v2-${Date.now()}`;

  const brand = normalizeValue(record.brand) || 'Unbekannt';
  const model = normalizeValue(record.model);
  const variant = normalizeValue(record.variant);
  const titleCandidate =
    normalizeValue(record.title_ebay) ||
    normalizeValue(record.title_kaufland) ||
    '';

  const nameParts = [brand, model, variant].filter(Boolean);
  const namePartsJoined = nameParts.join(' ').trim();
  const canUseNameParts = Boolean(namePartsJoined) && !(isUnknownToken(brand) && !model && !variant);
  const unknownName = options?.label ? `Unbekanntes Produkt (${options.label})` : 'Unbekanntes Produkt';
  const identificationName =
    titleCandidate || (canUseNameParts ? namePartsJoined : '') || (identified ? options?.label : unknownName) || unknownName;

  const manualBarcodes = parseBarcodeString(options?.barcodes || '');
  const barcodeFromInsights =
    (record.barcode_sources && record.barcode_sources[0]?.code) || '';
  const normalizedBarcodes = dedupe(
    [record.gtin, record.ean, record.upc, barcodeFromInsights, ...manualBarcodes]
      .map(normalizeValue)
      .filter(Boolean)
  );

  const images = buildImages(record);
  const attributes = buildAttributes(record);
  const keyFeatures = buildKeyFeatures(record);
  const shortDescription =
    normalizeValue(record.description_kaufland) ||
    normalizeValue(record.description_ebay) ||
    `${identificationName} – Beschreibung folgt.`;

  const barcodeConfidence = Math.max(record.gtin_confidence || 0, record.ean_confidence || 0);
  const confidence = identified
    ? Math.min(0.92, Math.max(0.55, 0.55 + barcodeConfidence * 0.35))
    : 0.22;

  const warnings = identified
    ? []
    : [
        'Identifikation unsicher: Produkt wurde als "Unbekannt" erstellt. Bitte Titel/Marke/Kategorie prüfen und ggf. ergänzen.',
      ];

  const product: Product = {
    id: productId,
    identification: {
      method: record.input_mode === 'label' ? 'barcode' : 'image',
      barcodes: normalizedBarcodes.length ? normalizedBarcodes : undefined,
      name: identificationName,
      brand,
      category: normalizeValue(record.internalCategory) || 'Unkategorisiert',
      confidence,
      sku: normalizeValue(record.sku) || undefined,
    },
    details: {
      short_description: shortDescription,
      key_features: keyFeatures,
      attributes,
      identifiers: {
        ean: normalizeValue(record.ean) || undefined,
        gtin: normalizeValue(record.gtin) || undefined,
        upc: normalizeValue(record.upc) || undefined,
        sku: normalizeValue(record.sku) || undefined,
      },
      images,
      pricing: {
        lowest_price: {
          amount: 0,
          currency: 'EUR',
          sources: [],
        },
        price_confidence: 0,
      },
    },
    ops: {
      sync_status: 'pending',
      revision: 0,
      pending_intake_quantity: 0,
    },
    notes: warnings.length ? { warnings } : undefined,
    inventory: {
      quantity: 0,
      inventoryId: options?.inventoryId || null,
      inventoryName: options?.inventoryName || null,
    },
  };

  const priceHint: any = (record as any).price_hint;
  if (priceHint && typeof priceHint.amount === 'number' && priceHint.amount > 0) {
    product.details.pricing = {
      ...product.details.pricing,
      lowest_price: {
        amount: priceHint.amount,
        currency: priceHint.currency || 'EUR',
        sources: [
          {
            name: priceHint.source || 'SerpAPI',
            url: priceHint.url || '',
            price: priceHint.amount,
            checked_at: new Date().toISOString(),
          },
        ],
      },
      price_confidence: 0.6,
    };
  }

  return product;
};

