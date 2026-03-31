/**
 * Kanonisches Produkt-Schema.
 * JEDER Schreibvorgang auf products_v2 MUSS durch normalizeProduct() laufen.
 * Dieses Modul ist die EINZIGE Quelle der Wahrheit für die Datenstruktur.
 */

/**
 * Normalisiert ein Produkt-Dokument in das kanonische Format.
 * Idempotent: Kann auf bereits normalisierte Dokumente angewendet werden.
 */
function normalizeProduct(raw) {
  const product = structuredClone(raw);

  // ── 1. Attributes: Array → Object ──
  if (Array.isArray(product.details?.attributes)) {
    const obj = {};
    for (const entry of product.details.attributes) {
      const key = (entry?.key || '').trim();
      if (key) obj[key] = entry?.value ?? '';
    }
    product.details.attributes = obj;
  }
  if (!product.details) product.details = {};
  if (!product.details.attributes || typeof product.details.attributes !== 'object') {
    product.details.attributes = {};
  }

  // ── 2. Kategorie-Felder: Konsolidieren → details.categoryId ──
  if (!product.details.categoryId) {
    product.details.categoryId =
      product.details?.ebayCategoryId ||
      product.details?.ebay_category_id ||
      product.details?.attributes?.['ebay_category_id'] ||
      product.details?.attributes?.['ebay.category_id'] ||
      product.details?.attributes?.category_id ||
      product.details?.attributes?.categoryId ||
      null;
  }
  // Legacy-Felder entfernen (nur aus dem normalisierten Dokument)
  delete product.details.ebayCategoryId;
  delete product.details.ebay_category_id;

  // ── 3. Marketplace-Metadaten aus Attributes extrahieren ──
  if (!product.details.marketplace) product.details.marketplace = {};
  const attrs = product.details.attributes;
  const marketplaceKeys = [];
  for (const key of Object.keys(attrs)) {
    if (key.startsWith('ebay.') || key.startsWith('ebay_') ||
        key.startsWith('kaufland.') || key.startsWith('kaufland_')) {
      // In dediziertes marketplace-Objekt verschieben
      product.details.marketplace[key] = attrs[key];
      marketplaceKeys.push(key);
    }
  }
  for (const key of marketplaceKeys) {
    delete attrs[key];
  }

  // ── 4. Gewicht: Normalisieren → attributes.Gewicht ──
  const weightAliases = ['weight', 'Gewicht(kg)', 'Bruttogewicht', 'Artikelgewicht'];
  for (const alias of weightAliases) {
    if (attrs[alias] !== undefined && attrs['Gewicht'] === undefined) {
      attrs['Gewicht'] = attrs[alias];
    }
    if (alias !== 'Gewicht') delete attrs[alias];
  }

  // ── 5. Placeholder bereinigen → leere Strings statt Fake-Werte ──
  // WICHTIG: Nur brand und category werden bereinigt. 'name' wird NIEMALS
  // automatisch gelöscht — Datenverlust-Risiko zu hoch (BUG-091).
  const placeholders = ['unbekannt', 'unknown', 'n/a', 'na', '-', '—', '--', 'null'];
  if (product.identification) {
    for (const field of ['brand', 'category']) {
      const val = (product.identification[field] || '').trim();
      if (placeholders.includes(val.toLowerCase())) {
        product.identification[field] = null;
      }
    }
  }

  // ── 6. Pflichtfelder sicherstellen (mit Defaults) ──
  product.identification = product.identification || {};
  product.identification.method = product.identification.method || 'unknown';
  product.identification.barcodes = product.identification.barcodes || [];
  product.identification.confidence = product.identification.confidence ?? 0;
  product.details.short_description = product.details.short_description || '';
  product.details.key_features = product.details.key_features || [];
  product.details.identifiers = product.details.identifiers || {};
  product.details.images = product.details.images || [];
  product.details.pricing = product.details.pricing || {};
  product.ops = product.ops || {};
  product.notes = product.notes || {};

  // ── 7. Produkt-ID kanonisieren ──
  // WICHTIG: Die Document-ID darf NICHT geändert werden — das erzeugt Duplikate (BUG-085).
  // Die kanonische ID wird nur als Metadatum gespeichert für spätere Lookups/Dedup.
  const canonicalId = _pickCanonicalId(product);
  if (canonicalId && canonicalId !== product.id) {
    product.ops._canonicalId = canonicalId; // Nur als Metadatum, NICHT als Document-ID
  }

  // ── 8. Normalisierungs-Metadaten ──
  product.ops._normalized = true;
  product.ops._normalizedAt = new Date().toISOString();
  product.ops._schemaVersion = 2;

  return product;
}

/**
 * Ermittelt die kanonische Produkt-ID nach Priorität:
 * 1. Gültige EAN/GTIN (13 oder 12 Ziffern)
 * 2. Gültige UPC (12 Ziffern)
 * 3. SKU (wenn vorhanden und kein Platzhalter)
 * 4. Bestehende ID beibehalten (UUID, Firestore Auto-ID etc.)
 *
 * WICHTIG: Gibt nur eine ID zurück wenn eine BESSERE gefunden wird.
 * Bestehende barcode-basierte IDs werden nicht verändert.
 */
function _pickCanonicalId(product) {
  const identifiers = product.details?.identifiers || {};
  const barcodes = product.identification?.barcodes || [];

  // Kandidaten sammeln (Reihenfolge = Priorität)
  const candidates = [
    identifiers.ean,
    identifiers.gtin,
    ...barcodes,
    identifiers.upc,
  ]
    .map(v => v ? String(v).trim() : '')
    .filter(v => /^\d{12,14}$/.test(v)); // Nur gültige Barcodes (12-14 Ziffern)

  if (candidates.length > 0) {
    return candidates[0].replace(/\//g, '_'); // Firestore-safe
  }

  // Kein Barcode gefunden → bestehende ID beibehalten
  return null;
}

/**
 * Validiert ob ein Produkt dem kanonischen Schema entspricht.
 * Gibt { valid: true } oder { valid: false, errors: [...] } zurück.
 */
function validateCanonical(product) {
  const errors = [];

  // Attributes MUSS Object sein, kein Array
  if (Array.isArray(product.details?.attributes)) {
    errors.push('details.attributes is Array, must be Object');
  }

  // Keine Legacy-Kategorie-Felder
  if (product.details?.ebayCategoryId) errors.push('Legacy field: details.ebayCategoryId');
  if (product.details?.ebay_category_id) errors.push('Legacy field: details.ebay_category_id');

  // Keine Marketplace-Keys in Attributes
  if (product.details?.attributes) {
    for (const key of Object.keys(product.details.attributes)) {
      if (key.startsWith('ebay.') || key.startsWith('ebay_') ||
          key.startsWith('kaufland.') || key.startsWith('kaufland_')) {
        errors.push(`Marketplace key in attributes: ${key}`);
      }
    }
  }

  // Produkt-ID Format prüfen
  if (product.id) {
    const id = String(product.id);
    // Warnung wenn UUID oder Firestore Auto-ID statt Barcode/SKU
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) || /^prod-/.test(id)) {
      // Prüfe ob Barcode verfügbar wäre
      const identifiers = product.details?.identifiers || {};
      const barcodes = product.identification?.barcodes || [];
      const hasBarcode = [identifiers.ean, identifiers.gtin, ...barcodes]
        .some(v => v && /^\d{12,14}$/.test(String(v).trim()));
      if (hasBarcode) {
        errors.push(`Non-canonical ID "${id}" — barcode-based ID available but not used`);
      }
    }
  }

  // Keine Placeholder in Pflichtfeldern
  const placeholders = ['unbekannt', 'unknown', 'n/a', 'na', '-', '—', '--', 'null'];
  for (const field of ['name', 'brand', 'category']) {
    const val = (product.identification?.[field] || '').trim().toLowerCase();
    if (placeholders.includes(val)) {
      errors.push(`Placeholder in identification.${field}: "${val}"`);
    }
  }

  return errors.length ? { valid: false, errors } : { valid: true };
}

module.exports = { normalizeProduct, validateCanonical, _pickCanonicalId };
