/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Enrich missing "K-Typ" for AUTO parts using:
 * 1) Web search (SerpAPI) for HSN/TSN or vehicle fitment clues
 * 2) MVL dataset (exports/DE_MVL_2025_10.compact.jsonl) to map HSN/TSN or vehicle rows -> K-Type IDs
 *
 * Safety:
 * - Default is DRY-RUN (no writes)
 * - Only writes when we have strong evidence (HSN/TSN match in MVL)
 * - Never touches non-auto categories
 *
 * Usage:
 *   MVL_JSONL=exports/DE_MVL_2025_10.compact.jsonl node backend/scripts/enrich-ktype-from-web-mvl.js --dry-run --limit 10
 *   MVL_JSONL=exports/DE_MVL_2025_10.compact.jsonl node backend/scripts/enrich-ktype-from-web-mvl.js --apply --limit 10
 */

const fs = require('fs');
const path = require('path');
const { fetchPageText } = require('../lib/web-search-html');
const { callSerpApi } = require('../lib/serpapi');
const { getAllProducts, getAllProductsForTenant, saveProduct } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
const { getVehicleFitmentMode } = require('../lib/vehicle-fitment');
const { findEbayCategory } = require('../lib/ebay-taxonomy');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeHsnTsn(raw) {
  const s = safeString(raw);
  if (!s) return '';
  // common formats: "0588 AFK", "0588/AFK", "HSN:0588 TSN:AFK"
  const m = s.match(/\b(\d{4})\b[^\p{L}\p{N}]+([a-z0-9]{3})\b/i);
  if (!m) return '';
  return `${m[1]}|${m[2].toUpperCase()}`;
}

function extractHsnTsnCandidates(text = '') {
  const s = String(text || '');
  const out = new Set();

  const push = (hsn, tsn) => {
    const h = String(hsn || '').trim();
    const t = String(tsn || '').trim().toUpperCase();
    if (!/^\d{4}$/.test(h)) return;
    if (!/^[A-Z0-9]{3}$/.test(t)) return;
    out.add(`${h}|${t}`);
  };

  // Strict extraction only: require explicit HSN and TSN labels nearby.
  const re2 = /\bHSN\b[^0-9]{0,40}(\d{4}).{0,120}?\bTSN\b[^A-Z0-9]{0,40}([A-Z0-9]{3})\b/gi;
  let m;
  while ((m = re2.exec(s)) !== null) {
    push(m[1], m[2]);
  }

  return Array.from(out);
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    limit: 10,
    offset: 0,
    engine: 'google',
    num: 5,
    outDir: path.join(process.cwd(), 'exports', 'ktype-enrich'),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    }
    if (t === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--offset') {
      args.offset = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--engine') {
      args.engine = String(argv[i + 1] || 'google');
      i += 1;
    }
    if (t === '--num') {
      args.num = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--out') {
      args.outDir = String(argv[i + 1] || args.outDir);
      i += 1;
    }
  }
  return args;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function hasKTyp(attrs) {
  if (!attrs || typeof attrs !== 'object') return false;
  return Object.keys(attrs).some((k) => {
    const lower = safeString(k).toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
}

function pickMpnOrPartNumber(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};
  return (
    safeString(ids.mpn) ||
    safeString(attrs.Herstellernummer) ||
    safeString(attrs['Teilenummer']) ||
    safeString(attrs['Referenznummer(n) OEM']) ||
    ''
  );
}

function pickBrand(product) {
  return safeString(product?.identification?.brand) || safeString(product?.details?.attributes?.Marke) || '';
}

function pickProductTypeHint(product) {
  const attrs = product?.details?.attributes || {};
  return (
    safeString(attrs.Produktart) ||
    safeString(attrs.Produkttyp) ||
    safeString(attrs.Bauteil) ||
    safeString(product?.identification?.category).split('>').pop()?.trim() ||
    ''
  );
}

function getCategoryId(product) {
  const direct = safeString(product?.details?.categoryId || product?.details?.ebayCategoryId || '');
  if (direct) return direct;
  const breadcrumb = safeString(product?.identification?.category);
  if (!breadcrumb) return '';
  const cat = findEbayCategory(breadcrumb);
  const id = cat?.id ?? cat?.categoryId ?? null;
  return id ? String(id).trim() : '';
}

function looksLikeAutoProduct(product) {
  const catId = getCategoryId(product);
  const mode = catId ? getVehicleFitmentMode(catId) : null;
  // Only enrich when the category explicitly supports vehicle fitment lists (per eBay dataset).
  return Boolean(mode);
}

function loadMvlIndex(jsonlPath) {
  const text = fs.readFileSync(jsonlPath, 'utf8');
  const byHsnTsn = new Map(); // "0588|AFK" -> Set<ktype>
  const makes = new Set(); // lower make names
  const byMakePlatform = new Map(); // `${makeLower}|${platform}` -> Set<ktype>
  const lines = text.split('\n');
  let parsed = 0;
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    parsed += 1;
    const rec = JSON.parse(s);
    const k = Number(rec?.k);
    if (!Number.isFinite(k)) continue;
    const make = safeString(rec?.make);
    const makeLower = make ? make.toLowerCase() : '';
    if (makeLower) makes.add(makeLower);
    const platform = safeString(rec?.platform);
    if (makeLower && platform) {
      const key = `${makeLower}|${platform}`;
      const set = byMakePlatform.get(key) || new Set();
      set.add(k);
      byMakePlatform.set(key, set);
    }
    const raw = safeString(rec?.hsn_tsn);
    if (!raw) continue;
    // MVL may contain multiple pairs separated by "<>"
    const parts = raw.split('<>').map((p) => normalizeHsnTsn(p)).filter(Boolean);
    for (const h of parts) {
      const set = byHsnTsn.get(h) || new Set();
      set.add(k);
      byHsnTsn.set(h, set);
    }
  }
  return { parsed, byHsnTsn, makes, byMakePlatform };
}

function normalizeNeedle(value = '') {
  return safeString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractVehicleMakes(text, makeSet) {
  const lower = String(text || '').toLowerCase();
  const found = new Set();
  for (const make of makeSet) {
    if (!make || make.length < 3) continue;
    const re = new RegExp(`\\b${make.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
    if (re.test(lower)) found.add(make);
    if (found.size >= 3) break;
  }
  return Array.from(found);
}

function extractPlatformTokens(text = '') {
  const s = String(text || '');
  const out = new Set();
  const re = /\b[A-Z0-9]{2,6}(?:\/[0-9])?\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = String(m[0] || '').trim();
    if (!tok) continue;
    if (/^(EAN|OEM|HSN|TSN|ABS|ESP|SKU)$/i.test(tok)) continue;
    out.add(tok);
  }
  return Array.from(out);
}

async function findKTypesForProductViaHsnTsn({ brand, mpn, typeHint, mvl }) {
  // Use product-oriented queries to avoid generic HSN/TSN pages.
  const q1 = [brand, mpn, typeHint].filter(Boolean).join(' ').trim();
  const q2 = [brand, mpn, typeHint, 'HSN', 'TSN'].filter(Boolean).join(' ').trim();
  const queries = Array.from(new Set([q1, q2].filter(Boolean)));

  const mpnNeedle = normalizeNeedle(mpn);
  const allCandidates = new Set();
  const platformKTypes = new Set();
  const sources = [];

  const serpEngines = ['google', 'bing', 'duckduckgo'];
  for (const q of queries) {
    let organic = [];
    let usedEngine = null;
    for (const engine of serpEngines) {
      try {
        const data = await callSerpApi(engine, { q, num: 6 });
        organic = Array.isArray(data?.organic_results) ? data.organic_results : [];
        usedEngine = engine;
        if (organic.length) break;
      } catch {
        // try next engine
      }
    }

    for (const r of organic.slice(0, 6)) {
      const url = safeString(r?.link);
      if (!url) continue;
      const fetched = await fetchPageText(url, { timeoutMs: 25_000 });
      if (!fetched?.ok || !fetched?.text) continue;
      const text = String(fetched.text);
      // Guardrail: only trust evidence from pages that actually mention the part number.
      if (mpnNeedle && !normalizeNeedle(text).includes(mpnNeedle)) continue;

      extractHsnTsnCandidates(text).forEach((c) => allCandidates.add(c));

      // Fallback evidence: map via MVL make + platform (still MVL-backed, but weaker than explicit HSN/TSN).
      if (mvl?.makes && mvl?.byMakePlatform) {
        const makes = extractVehicleMakes(text, mvl.makes);
        const platforms = extractPlatformTokens(text);
        for (const make of makes) {
          for (const pTok of platforms) {
            const key = `${make}|${pTok}`;
            const set = mvl.byMakePlatform.get(key);
            if (!set) continue;
            for (const id of set.values()) platformKTypes.add(id);
          }
        }
      }

      sources.push({ title: safeString(r?.title), link: url, via: fetched.via || 'fetch', engine: usedEngine });
      if (sources.length >= 6) break;
    }
    if (sources.length >= 6) break;
  }

  return {
    query: queries.join(' | '),
    engine: 'web-search-html',
    candidates: Array.from(allCandidates),
    ktypes_from_platform: Array.from(platformKTypes).sort((a, b) => a - b).slice(0, 60),
    sources,
    error: null,
  };
}

function formatKTyp(ids = []) {
  return ids.map((id) => String(id).trim()).filter(Boolean).join('|');
}

async function main() {
  const args = parseArgs(process.argv);
  const mvlPath = process.env.MVL_JSONL || path.join(process.cwd(), 'exports', 'DE_MVL_2025_10.compact.jsonl');
  if (!fs.existsSync(mvlPath)) {
    throw new Error(`Missing MVL_JSONL: ${mvlPath} (run MVL extract first)`);
  }
  ensureDir(args.outDir);

  console.log('[ktype-enrich] mode=', args.apply ? 'APPLY' : 'DRY_RUN');
  console.log('[ktype-enrich] mvl=', mvlPath);

  const mvl = loadMvlIndex(mvlPath);
  console.log('[ktype-enrich] mvl_rows=', mvl.parsed, 'hsn_tsn_keys=', mvl.byHsnTsn.size);

  const products = await getAllProductsForTenant(TENANT_ID);
  const candidates = products
    .filter((p) => looksLikeAutoProduct(p))
    .filter((p) => pickMpnOrPartNumber(p))
    .filter((p) => !hasKTyp(p?.details?.attributes));

  candidates.sort((a, b) => safeString(a?.identification?.sku).localeCompare(safeString(b?.identification?.sku), 'de'));
  const offset = Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : 0;
  const slice = candidates.slice(offset, offset + Math.max(0, Math.floor(args.limit || 0)));

  console.log('[ktype-enrich] candidates_total=', candidates.length, 'selected=', slice.length, 'offset=', offset);

  const report = [];
  let updated = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const p = slice[i];
    const sku = safeString(p?.identification?.sku);
    const brand = pickBrand(p);
    const mpn = pickMpnOrPartNumber(p);
    const typeHint = pickProductTypeHint(p);
    console.log(`[ktype-enrich] (${i + 1}/${slice.length}) sku=${sku} mpn=${mpn}`);

    const evidence = await findKTypesForProductViaHsnTsn({ brand, mpn, typeHint, mvl });
    if (evidence?.error) {
      report.push({
        id: p?.id || null,
        sku,
        mpn,
        query: evidence.query,
        error: evidence.error,
        engine: evidence.engine,
      });
      continue;
    }
    const mapped = new Set();
    for (const h of evidence.candidates) {
      const set = mvl.byHsnTsn.get(h);
      if (!set) continue;
      for (const id of set.values()) mapped.add(id);
    }
    if (mapped.size === 0 && Array.isArray(evidence.ktypes_from_platform) && evidence.ktypes_from_platform.length) {
      evidence.ktypes_from_platform.forEach((id) => mapped.add(id));
    }
    const mappedList = Array.from(mapped).sort((a, b) => a - b).slice(0, 40);

    const row = {
      id: p?.id || null,
      sku,
      mpn,
      query: evidence.query,
      hsn_tsn: evidence.candidates,
      ktypes: mappedList,
      sources: evidence.sources,
      ktypes_from_platform: evidence.ktypes_from_platform || [],
    };
    report.push(row);

    // Only write when we have at least one MVL-backed K-Type ID.
    if (args.apply && mappedList.length) {
      const next = JSON.parse(JSON.stringify(p));
      next.details = next.details || {};
      next.details.attributes = next.details.attributes && typeof next.details.attributes === 'object' ? next.details.attributes : {};
      next.details.attributes['K-Typ'] = formatKTyp(mappedList);
      next.ops = next.ops || {};
      next.ops.last_saved_source = 'ktype-web-mvl';
      next.ops.data_quality = {
        ...(next.ops.data_quality || {}),
        ktype_enrich_v1: {
          at_iso: new Date().toISOString(),
          query: evidence.query,
          hsn_tsn: evidence.candidates,
          ktypes: mappedList,
          sources: evidence.sources,
        },
      };

      // Use the standard save pipeline (enforces invariants, keeps warehouse fields safe).
      await saveProduct(next, { source: 'ktype-web-mvl' });
      updated += 1;
    }
  }

  const outPath = path.join(args.outDir, `ktype_enrich_${args.apply ? 'apply' : 'dry'}_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ mode: args.apply ? 'APPLY' : 'DRY_RUN', updated, report }, null, 2), 'utf8');
  console.log('[ktype-enrich] done updated=', updated, 'report=', outPath);
}

main().catch((err) => {
  console.error('ktype-enrich failed:', err);
  process.exit(1);
});

