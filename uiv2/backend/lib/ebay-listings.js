const { parse } = require('csv-parse/sync');
const { FieldValue } = require('@google-cloud/firestore');
const { firestore } = require('./firestore');

const COLLECTION = 'ebayListings';

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSku(raw) {
  const s = safeString(raw);
  return s;
}

function collectImages(record) {
  const urls = [];
  const group = safeString(record['Group Picture URL']);
  if (group) urls.push(group);
  for (let i = 1; i <= 24; i += 1) {
    const u = safeString(record[`Picture URL ${i}`]);
    if (u) urls.push(u);
  }
  // De-dupe while preserving order
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

function collectAttributes(record) {
  const attrs = {};
  for (let i = 1; i <= 30; i += 1) {
    const name = safeString(record[`Attribute Name ${i}`]);
    const value = safeString(record[`Attribute Value ${i}`]);
    if (!name) continue;
    if (!value) continue;
    // Keep first non-empty value per key (do not overwrite silently).
    if (attrs[name] === undefined) {
      attrs[name] = value;
    }
  }
  return attrs;
}

function scoreListing(listing) {
  const titleLen = safeString(listing?.title).length;
  const descLen = safeString(listing?.description).length;
  const images = Array.isArray(listing?.images) ? listing.images.length : 0;
  const attrs = listing?.attributes && typeof listing.attributes === 'object' ? Object.keys(listing.attributes).length : 0;
  const hasCat = safeString(listing?.categoryId) ? 1 : 0;
  const hasBrand = safeString(listing?.brand) ? 1 : 0;
  const hasEan = safeString(listing?.ean) ? 1 : 0;
  // Weighted completeness score
  return (
    Math.min(120, titleLen) +
    Math.min(3000, descLen) / 10 +
    images * 10 +
    attrs * 3 +
    hasCat * 20 +
    hasBrand * 10 +
    hasEan * 10
  );
}

function pickBestListing(listings = []) {
  const list = Array.isArray(listings) ? listings : [];
  if (list.length <= 1) return list[0] || null;
  const scored = list.map((l) => ({ l, s: scoreListing(l) }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0]?.l || null;
}

function parseMipCsv(buffer) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer || ''), 'utf8');
  const records = parse(input, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    columns: (header) =>
      (Array.isArray(header) ? header : []).map((h) => {
        const key = safeString(h);
        // eBay MIP export contains a trailing comma → empty last column name. Skip it.
        if (!key) return null;
        return key;
      }),
  });

  return Array.isArray(records) ? records : [];
}

function mapMipRecordToListing(record) {
  const sku = normalizeSku(record?.SKU);
  if (!sku) return null;

  const listing = {
    sku,
    locale: safeString(record?.['Localised For']) || null,
    title: safeString(record?.Title) || null,
    subtitle: safeString(record?.Subtitle) || null,
    description: safeString(record?.['Product Description']) || null,
    additionalInfo: safeString(record?.['Additional Info']) || null,
    categoryId: safeString(record?.Category) || null,
    channelId: safeString(record?.['Channel Id']) || null,
    condition: safeString(record?.Condition) || null,
    conditionDescription: safeString(record?.['Condition Description']) || null,
    brand: safeString(record?.Brand) || null,
    mpn: safeString(record?.MPN) || null,
    ean: safeString(record?.EAN) || null,
    upc: safeString(record?.UPC) || null,
    isbn: safeString(record?.ISBN) || null,
    epid: safeString(record?.ePID) || null,
    price: safeString(record?.['List Price']) || null,
    images: collectImages(record),
    attributes: collectAttributes(record),
  };

  return listing;
}

async function upsertListingsBySku({
  listingsBySku,
  source,
  actor,
}) {
  const entries = Object.entries(listingsBySku || {});
  if (!entries.length) return { written: 0 };

  let written = 0;
  // Firestore batch limit: 500 ops
  const chunkSize = 450;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const batch = firestore.batch();
    const slice = entries.slice(i, i + chunkSize);
    for (const [sku, group] of slice) {
      const best = pickBestListing(group.listings);
      if (!best) continue;
      const dupCount = Array.isArray(group.listings) ? group.listings.length : 1;
      const sampleTitles = (group.listings || [])
        .map((l) => safeString(l?.title))
        .filter(Boolean)
        .slice(0, 5);

      const docRef = firestore.collection(COLLECTION).doc(String(sku));
      batch.set(
        docRef,
        {
          sku,
          listing: best,
          duplicates: dupCount > 1 ? { count: dupCount, sampleTitles } : null,
          source: {
            type: source?.type || 'mip_csv',
            filename: source?.filename || null,
            importedAt: FieldValue.serverTimestamp(),
            importedBy: actor
              ? { uid: actor?.uid || null, email: actor?.email || null }
              : null,
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      written += 1;
    }
    await batch.commit();
  }

  return { written };
}

async function importMipCsvBuffer(buffer, { filename = null, actor = null } = {}) {
  const rawRecords = parseMipCsv(buffer);

  const listingsBySku = {};
  let rows = 0;
  let missingSku = 0;
  for (const record of rawRecords) {
    rows += 1;
    const listing = mapMipRecordToListing(record);
    if (!listing?.sku) {
      missingSku += 1;
      continue;
    }
    const sku = listing.sku;
    if (!listingsBySku[sku]) {
      listingsBySku[sku] = { listings: [] };
    }
    listingsBySku[sku].listings.push(listing);
  }

  const uniqueSkus = Object.keys(listingsBySku).length;
  const duplicates = Object.entries(listingsBySku)
    .filter(([, v]) => Array.isArray(v?.listings) && v.listings.length > 1)
    .map(([sku, v]) => ({ sku, count: v.listings.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const write = await upsertListingsBySku({
    listingsBySku,
    source: { type: 'mip_csv', filename },
    actor,
  });

  return {
    rowsParsed: rows,
    uniqueSkus,
    missingSkuRows: missingSku,
    written: write.written,
    duplicateSkusSample: duplicates,
  };
}

async function getEbayListingBySku(sku) {
  const key = normalizeSku(sku);
  if (!key) return null;
  const snap = await firestore.collection(COLLECTION).doc(key).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return data?.listing || null;
}

module.exports = {
  importMipCsvBuffer,
  getEbayListingBySku,
};

