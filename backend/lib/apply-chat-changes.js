'use strict';

/**
 * apply-chat-changes.js — backend port of the frontend applyAssistantChange
 * mapping. Merges chat datasheetChanges (proposals from runProductChatV3) onto a
 * product so a bulk job can apply the FULL datasheet.
 *
 * HARD RULES:
 *  - NEVER touches inventory / sku / storage / storageBins (not mapped here;
 *    saveProductV2 also protects them).
 *  - NEVER changes category (categoryId / categoryPath / identity.category are
 *    intentionally ignored — category is protected).
 *  - Title is BRAND-FIRST protected (prod incident 2026-06-07).
 *  - Drops "Unbekannt"/empty values (no hallucinated placeholders).
 *
 * Pure + synchronous → easy to unit test. The caller persists via saveProductV2.
 */

const { normalizeLiteralEscapes } = require('./listing-sanitize');

function safeStr(v) {
  // De-literalize escape sequences (model over-escaping "\n"/"\r"/"\t" inside its
  // JSON output) before trimming — keeps a literal backslash-n out of every
  // chat-applied field, especially short_description. Incident 2026-06-29.
  if (v == null) return '';
  return normalizeLiteralEscapes(typeof v === 'string' ? v : String(v)).trim();
}
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isBad(v) {
  const s = safeStr(v);
  return !s || /^unbekannt$/i.test(s) || s === '-' || s === '--' || /^n\/?a$/i.test(s);
}
function toAttrObject(attrs) {
  if (!attrs) return {};
  if (Array.isArray(attrs)) {
    const o = {};
    for (const a of attrs) if (a && a.key != null) o[String(a.key)] = a.value;
    return o;
  }
  if (typeof attrs === 'object') return { ...attrs };
  return {};
}
function brandFirst(title, brand) {
  const t = safeStr(title);
  const b = safeStr(brand);
  if (!t || !b) return t;
  if (t.toLowerCase().startsWith(b.toLowerCase())) return t;
  const stripped = t.replace(new RegExp('\\b' + escapeRe(b) + '\\b', 'ig'), '').replace(/\s+/g, ' ').trim();
  return `${b} ${stripped}`.replace(/\s+/g, ' ').trim();
}

function applyChatChangesToProduct(product, changes, opts = {}) {
  const work = JSON.parse(JSON.stringify(product || {}));
  work.identification = work.identification || {};
  work.details = work.details || {};
  const changed = new Set();
  const brand = safeStr(work.identification.brand);
  const list = Array.isArray(changes) ? changes : [];

  for (const ch of list) {
    if (!ch || typeof ch !== 'object') continue;

    // title (brand-first)
    if (!isBad(ch.title)) {
      work.identification.name = brandFirst(ch.title, brand) || safeStr(ch.title);
      changed.add('title');
    }

    // identity — brand + identifiers + barcodes only. CATEGORY IS NEVER TOUCHED.
    if (ch.identity && typeof ch.identity === 'object') {
      const idc = ch.identity;
      if (!isBad(idc.brand)) {
        work.identification.brand = safeStr(idc.brand);
        changed.add('brand');
      }
      for (const k of ['gtin', 'ean', 'upc', 'mpn']) {
        if (!isBad(idc[k])) {
          work.details.identifiers = work.details.identifiers || {};
          work.details.identifiers[k] = safeStr(idc[k]);
          changed.add('identifiers');
        }
      }
      if (Array.isArray(idc.barcodes) && idc.barcodes.length) {
        const bc = idc.barcodes.map(safeStr).filter(Boolean);
        if (bc.length) {
          const cur = (work.identification.barcodes || []).map(safeStr).filter(Boolean);
          work.identification.barcodes = Array.from(new Set([...cur, ...bc]));
          changed.add('barcodes');
        }
      }
    }

    // short_description — never SHORTEN an already-good (>=260) description.
    // Only replace when existing is missing/too short OR the new one is longer.
    if (!isBad(ch.short_description)) {
      const incoming = safeStr(ch.short_description);
      const existing = safeStr(work.details.short_description);
      if (!existing || existing.length < 260 || incoming.length >= existing.length) {
        work.details.short_description = incoming;
        changed.add('description');
      }
    }

    // key_features
    if (Array.isArray(ch.key_features) && ch.key_features.length) {
      const kf = ch.key_features.map(safeStr).filter(Boolean);
      if (kf.length) {
        work.details.key_features = kf;
        changed.add('key_features');
      }
    }

    // gpsr (merge, drop bad)
    if (ch.gpsr && typeof ch.gpsr === 'object') {
      const incoming = {};
      for (const [k, v] of Object.entries(ch.gpsr)) if (!isBad(v)) incoming[k] = safeStr(v);
      if (Object.keys(incoming).length) {
        const base = { ...(work.details.gpsr || {}) };
        // Etikett-Quelle (source=product_image): Der Karton wurde vollständig
        // gelesen — pro Rolle die ALTEN Felder verwerfen, wenn die Rolle neu
        // identifiziert wird (change liefert *_name). Sonst überleben stale
        // Falschwerte den additiven Merge (Incident 2026-07-17: EU-REP-PLZ +
        // Chinesen-Telefon blieben beim Hersteller hängen).
        const imageSourced = ch.gpsr_evidence_check && ch.gpsr_evidence_check.outcome === 'product_image';
        if (imageSourced) {
          if (incoming.manufacturer_name) {
            for (const k of Object.keys(base)) if (/^manufacturer_/.test(k)) delete base[k];
          }
          if (incoming.eu_responsible_name) {
            for (const k of Object.keys(base)) if (/^eu_responsible_/.test(k)) delete base[k];
          }
        }
        work.details.gpsr = { ...base, ...incoming };
        changed.add('gpsr');
      }
    }

    // attributes (merge object; keep existing; GPSR-prefixed keys belong in gpsr)
    if (ch.attributes && typeof ch.attributes === 'object') {
      const inc = toAttrObject(ch.attributes);
      const cur = toAttrObject(work.details.attributes);
      let any = false;
      for (const [k, v] of Object.entries(inc)) {
        const key = safeStr(k);
        if (!key || isBad(v) || /^gpsr/i.test(key)) continue;
        cur[key] = v;
        any = true;
      }
      if (any) {
        work.details.attributes = cur;
        changed.add('attributes');
      }
    }

    // pricing → details.pricing.lowest_price (Markt-Recherche). sellPrice wird
    // NUR gefüllt, wenn bisher KEINER existiert — ein vom Menschen gesetzter
    // Verkaufspreis wird NIEMALS von der KI überschrieben (Live-Listing-Schutz).
    if (ch.pricing && typeof ch.pricing === 'object') {
      const p = ch.pricing;
      let lp = null;
      if (p.lowest_price && typeof p.lowest_price === 'object' && Number(p.lowest_price.amount) >= 1) {
        lp = {
          amount: Number(p.lowest_price.amount),
          currency: safeStr(p.lowest_price.currency) || 'EUR',
          sources: Array.isArray(p.lowest_price.sources) ? p.lowest_price.sources : [],
        };
      } else if (Number(p.amount) >= 1) {
        const url = safeStr(p.source_url || p.url);
        lp = { amount: Number(p.amount), currency: safeStr(p.currency) || 'EUR', sources: url ? [{ url, name: 'research' }] : [] };
      }
      if (lp && lp.amount >= 1) {
        work.details.pricing = work.details.pricing || {};
        if (typeof opts.nowIso === 'function') lp.last_checked_iso = opts.nowIso();
        work.details.pricing.lowest_price = lp;
        changed.add('pricing');
      }
      const proposedSell = Number(p.sellPrice);
      if (Number.isFinite(proposedSell) && proposedSell >= 1) {
        work.details.pricing = work.details.pricing || {};
        const existingSell = Number(work.details.pricing.sellPrice) || 0;
        if (!existingSell) {
          work.details.pricing.sellPrice = proposedSell;
          changed.add('pricing');
        }
      }
    }

    // weight_grams → details.weight (kg) + Gewicht attribute
    const wg = Number(ch.weight_grams);
    if (Number.isFinite(wg) && wg > 0) {
      const kg = Math.round((wg / 1000) * 1000) / 1000;
      work.details.weight = kg;
      work.details.attributes = toAttrObject(work.details.attributes);
      if (isBad(work.details.attributes['Gewicht'])) work.details.attributes['Gewicht'] = `${kg} kg`;
      changed.add('weight');
    }

    // notes (merge unique)
    if (ch.notes && typeof ch.notes === 'object') {
      work.notes = work.notes || {};
      for (const k of ['unsure', 'warnings']) {
        if (Array.isArray(ch.notes[k]) && ch.notes[k].length) {
          const existing = Array.isArray(work.notes[k]) ? work.notes[k] : [];
          work.notes[k] = Array.from(new Set([...existing, ...ch.notes[k].map(safeStr).filter(Boolean)]));
          changed.add('notes');
        }
      }
    }

    // category: INTENTIONALLY IGNORED (protected).
  }

  return { product: work, changed: Array.from(changed) };
}

module.exports = { applyChatChangesToProduct, _internal: { brandFirst, toAttrObject, isBad } };
