/* eslint-disable no-console */
/**
 * K-Type (K-Typ) utilities
 *
 * Input format (as provided): eBay compatibility export CSV, where each product starts with a
 * "Revise" row containing "Custom Label" = SKU, followed by multiple "Compatibility" rows:
 *   ,,,,Compatibility,Ktype=57448,
 *   ,,,,Compatibility,Ktype=111981|Notes=Einbauposition:Vorderachse,
 *
 * Output format (AvyCloud K-Typ attribute):
 * - Entries are separated by "|"
 * - Each entry is either:
 *   - "<ktypeId>" (no notes)
 *   - "<ktypeId>,<note>" (with notes)
 */

const { parse } = require('csv-parse/sync');

function decodeHtmlEntities(input = '') {
  const text = (input || '').toString();
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return _;
      }
    });
}

function normalizeNote(note = '') {
  let n = decodeHtmlEntities(note || '');
  n = n.replace(/,+$/g, '').trim();
  if (!n) return '';

  // "Ktype" entries are separated by "|", but notes can contain "|" in some exports.
  // Replace internal pipes to keep our K-Typ value unambiguous.
  if (n.includes('|')) {
    n = n
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' / ');
  }

  // Small normalization for common notes
  n = n.replace(/Einbauposition\s*:\s*/i, 'Einbauposition ');
  n = n.replace(/\s+/g, ' ').trim();

  return n;
}

function parseCompatibilityDetails(detailsRaw) {
  const raw = (detailsRaw == null ? '' : String(detailsRaw)).trim();
  if (!raw) return null;

  // Remove trailing commas sometimes present in CSV exports.
  const cleaned = raw.replace(/,+$/g, '').trim();

  const idMatch = cleaned.match(/Ktype\s*=\s*(\d+)/i);
  if (!idMatch) return null;
  const id = idMatch[1];

  let note = '';
  const lower = cleaned.toLowerCase();
  const marker = '|notes=';
  const idx = lower.indexOf(marker);
  if (idx !== -1) {
    note = cleaned.slice(idx + marker.length);
  } else {
    // Fallback: sometimes "Notes=" can appear without the leading pipe
    const fallback = cleaned.match(/notes\s*=\s*(.+)$/i);
    if (fallback && fallback[1]) note = fallback[1];
  }

  const normalizedNote = normalizeNote(note);

  return {
    id,
    note: normalizedNote || null,
  };
}

function formatKTypEntries(entries = []) {
  const parts = [];
  for (const entry of entries) {
    const id = entry?.id ? String(entry.id).trim() : '';
    if (!id) continue;
    const note = entry?.note ? String(entry.note).trim() : '';
    if (note) {
      parts.push(`${id},${note}`);
    } else {
      parts.push(id);
    }
  }
  return parts.join('|');
}

/**
 * Parse eBay-style Ktype compatibility export CSV into a SKU -> K-Typ string mapping.
 * @returns {{
 *  skuToKTyp: Record<string,string>,
 *  stats: { rows: number, skus: number, entries: number }
 * }}
 */
function parseKTypeEbayCsvToSkuMap(csvContent = '') {
  const content = (csvContent || '').toString();

  const rows = parse(content, {
    columns: true,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  let currentSku = null;
  const map = new Map(); // sku -> { entries: [], seenIds: Set<string> }
  let totalEntries = 0;

  const getBucket = (sku) => {
    if (!map.has(sku)) {
      map.set(sku, { entries: [], seenIds: new Set() });
    }
    return map.get(sku);
  };

  for (const row of rows) {
    const sku = (row['Custom Label'] || row.CustomLabel || row.customLabel || '').toString().trim();
    if (sku) currentSku = sku;
    if (!currentSku) continue;

    const relationship = (row.Relationship || row.relationship || '').toString().trim();
    if (relationship.toLowerCase() !== 'compatibility') continue;

    const details = row.RelationshipDetails || row.relationshipDetails || row['Relationship Details'] || '';
    const entry = parseCompatibilityDetails(details);
    if (!entry?.id) continue;

    const bucket = getBucket(currentSku);
    if (bucket.seenIds.has(entry.id)) continue;
    bucket.seenIds.add(entry.id);
    bucket.entries.push(entry);
    totalEntries += 1;
  }

  const skuToKTyp = {};
  for (const [sku, bucket] of map.entries()) {
    const formatted = formatKTypEntries(bucket.entries);
    if (formatted) {
      skuToKTyp[sku] = formatted;
    }
  }

  return {
    skuToKTyp,
    stats: {
      rows: Array.isArray(rows) ? rows.length : 0,
      skus: Object.keys(skuToKTyp).length,
      entries: totalEntries,
    },
  };
}

module.exports = {
  parseCompatibilityDetails,
  formatKTypEntries,
  parseKTypeEbayCsvToSkuMap,
};


