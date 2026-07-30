'use strict';

/**
 * ebay-aspect-name-normalizer.js — Merkmalsnamen-Normalisierer (reine Bibliothek).
 *
 * Problem (gemessen 2026-07-29): 52 % der an eBay gesendeten Artikelmerkmale tragen
 * einen Namen, den eBay in der ZIELKATEGORIE nicht kennt ("Materialzusammensetzung"
 * statt "Material", "Herstellungsland" statt "Ursprungsland"). Solche Merkmale
 * stehen zwar im Angebot, erzeugen aber KEINEN Filter in der eBay-Suchleiste —
 * die Pflegearbeit verpufft.
 *
 * Diese Datei ist NUR die Bibliothek. Sie ist NICHT verdrahtet: kein Aufrufer im
 * Publish-/Revise-Pfad, keine ENV-Auswertung, kein Default-Verhaltenswechsel.
 * Grund: der Aspektkatalog im Repo (backend/ebay-data/aspects-full.json) ist vom
 * 2026-02-17 und damit 5 Monate alt — vor der Verdrahtung muss er frisch gezogen
 * werden (backend/scripts/sync-ebay-required-aspects-full.js).
 *
 * Eigenschaften:
 *  - REIN: kein Firestore, kein HTTP, kein ENV. Der Kategorie-Katalog wird
 *    hineingereicht (`catalogAspectNames`), nicht selbst geladen.
 *  - VERLUSTFREI: unbekannte Namen bleiben stehen, Werte werden nie angefasst.
 *  - FAIL-CLOSED: ohne Katalog oder ohne expliziten Synonymeintrag passiert nichts.
 *  - IDEMPOTENT: ein bereits gueltiger Katalogname wird nie umbenannt.
 */

const SYNONYM_FILE = require('../data/ebay-aspect-synonyms.json');

const MODES = new Set(['off', 'shadow', 'on']);
const DEFAULT_MODE = 'off';

// Schluessel, die gar nicht als Artikelmerkmal gemeint sind. Sie werden von
// lib/ebay-direct.js beim Senden ohnehin aussortiert und duerfen deshalb weder
// umbenannt noch als "unbekannt" gezaehlt werden (sonst luegt das Audit).
const IGNORED_TOKENS = new Set([
  'category',
  'kategorie',
  'categoryid',
  'ebaycategoryid',
  'categorypath',
  'ebaycategorypath',
  'categorybreadcrumb',
  'ebaycategorybreadcrumb',
  // K-Typ (TecDoc) gehoert in die ItemCompatibilityList, nicht in die ItemSpecifics.
  'ktyp',
  'ktype',
  'ktypid',
  'ktypeid',
  'ktypids',
  'ktypeids',
]);

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Token-Normalisierung — bewusst deckungsgleich mit `normalizeSpecificToken`
 * aus lib/ebay-direct.js, damit "bekannt/unbekannt" hier genau das bedeutet,
 * was der Sendepfad spaeter auch entscheidet.
 */
function normalizeAspectToken(value) {
  const lower = safeString(value)
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
  const token = lower.replace(/[^a-z0-9]+/g, '');
  if (!token) return '';
  if (token === 'groesse' || token === 'size') return 'size';
  if (
    token === 'hoehe' ||
    token === 'height' ||
    token === 'dicke' ||
    token === 'staerke' ||
    token === 'materialstaerke' ||
    token === 'thickness'
  ) {
    return 'hoehe';
  }
  if (
    token === 'marke' ||
    token === 'brand' ||
    token === 'hersteller' ||
    token === 'manufacturer' ||
    token === 'herstellername' ||
    token === 'manufacturername'
  ) {
    return 'brand';
  }
  if (token === 'herstellernummer' || token === 'manufacturerpartnumber' || token === 'mpn') return 'mpn';
  if (token === 'ean' || token === 'gtin') return 'gtin';
  if (token.includes('fahrradtyp')) return 'fahrradtyp';
  if (token.includes('fahrradgroesse') || token.includes('fahrradsize')) return 'fahrradgroesse';
  return token;
}

/**
 * Katalog -> Map(token -> Katalogname in Original-Schreibweise).
 * Akzeptiert sowohl ['Material', ...] als auch [{ name: 'Material' }, ...].
 */
function buildCatalogNameIndex(catalogAspectNames) {
  const index = new Map();
  // FALLE (gefunden 2026-07-29): getCategoryAspectCatalog() aus lib/ebay-taxonomy liefert
  // ein OBJEKT ({categoryId, requiredAspects, recommendedAspects, optionalAspects,
  // allAspects, ...}), kein Array. Vorher gab diese Funktion dafuer stillschweigend einen
  // leeren Index zurueck — der Normalisierer lief also bei jedem echten Aufruf ins Leere
  // und benannte nie etwas um. Beide Formen werden jetzt akzeptiert.
  let rows = catalogAspectNames;
  if (!Array.isArray(rows) && isPlainObject(rows)) {
    if (Array.isArray(rows.allAspects)) {
      rows = rows.allAspects;
    } else {
      rows = []
        .concat(Array.isArray(rows.requiredAspects) ? rows.requiredAspects : [])
        .concat(Array.isArray(rows.recommendedAspects) ? rows.recommendedAspects : [])
        .concat(Array.isArray(rows.optionalAspects) ? rows.optionalAspects : []);
    }
  }
  if (!Array.isArray(rows)) return index;
  rows.forEach((row) => {
    const name = safeString(isPlainObject(row) ? row.name : row).trim();
    if (!name) return;
    const token = normalizeAspectToken(name);
    if (!token) return;
    if (index.has(token)) return; // erster gewinnt (stabil)
    index.set(token, name);
  });
  return index;
}

function getSynonymTable() {
  const table = SYNONYM_FILE && isPlainObject(SYNONYM_FILE.synonyms) ? SYNONYM_FILE.synonyms : {};
  return table;
}

function getDeferredTable() {
  return SYNONYM_FILE && isPlainObject(SYNONYM_FILE.deferred) ? SYNONYM_FILE.deferred : {};
}

let cachedTable = null;
let cachedTableSource = null;

/** Synonymtabelle -> Map(quellToken -> [zielName, ...]). Gecached fuer die Default-Tabelle. */
function buildSynonymIndex(synonyms) {
  const source = isPlainObject(synonyms) ? synonyms : getSynonymTable();
  if (source === cachedTableSource && cachedTable) return cachedTable;
  const index = new Map();
  Object.entries(source).forEach(([from, targets]) => {
    const fromToken = normalizeAspectToken(from);
    if (!fromToken) return;
    const list = (Array.isArray(targets) ? targets : [targets])
      .map((t) => safeString(t).trim())
      .filter(Boolean)
      // Selbstverweise wuerden nur Rauschen erzeugen.
      .filter((t) => normalizeAspectToken(t) !== fromToken);
    if (!list.length) return;
    if (!index.has(fromToken)) index.set(fromToken, list);
  });
  if (source === getSynonymTable()) {
    cachedTable = index;
    cachedTableSource = source;
  }
  return index;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_e) {
    return false;
  }
}

/**
 * @param {object}   args
 * @param {string}   args.categoryId          eBay-Kategorie (Leaf) des Angebots.
 * @param {object}   args.itemSpecifics       { name: values } — Werte beliebig (Array/String).
 * @param {string}   args.mode                'off' (default) | 'shadow' | 'on'.
 * @param {Array}    args.catalogAspectNames  Aspektnamen dieser Kategorie (aus dem eBay-Katalog).
 * @param {object}   [args.synonyms]          Optionale eigene Synonymtabelle.
 * @returns {{itemSpecifics: object, renames: Array<{from:string,to:string}>, unknown: Array<{name:string,reason:string}>, mode: string, categoryId: (string|null), catalogAvailable: boolean, changed: boolean}}
 */
function normalizeAspectNamesForCategory(args) {
  const opts = isPlainObject(args) ? args : {};
  const rawMode = safeString(opts.mode || DEFAULT_MODE);
  const mode = MODES.has(rawMode) ? rawMode : DEFAULT_MODE;
  const categoryId = safeString(opts.categoryId).trim() || null;
  const input = isPlainObject(opts.itemSpecifics) ? opts.itemSpecifics : {};

  const base = {
    itemSpecifics: input,
    renames: [],
    unknown: [],
    mode,
    categoryId,
    catalogAvailable: false,
    changed: false,
  };

  if (mode === 'off') return base;

  const catalogIndex = buildCatalogNameIndex(opts.catalogAspectNames);
  if (!categoryId || catalogIndex.size === 0) {
    // Ohne Katalog kann niemand wissen, ob ein Name gueltig ist -> nichts behaupten.
    return base;
  }
  base.catalogAvailable = true;

  const synonymIndex = buildSynonymIndex(opts.synonyms);

  // Belegte Ziel-Token: alles was schon im Input steht (mit seinem Wert),
  // plus was wir in diesem Lauf schon vergeben haben.
  const occupied = new Map();
  Object.entries(input).forEach(([key, value]) => {
    const token = normalizeAspectToken(key);
    if (!token) return;
    if (!occupied.has(token)) occupied.set(token, value);
  });

  const out = {};
  const renames = [];
  const unknown = [];

  Object.entries(input).forEach(([rawKey, value]) => {
    const key = safeString(rawKey);
    const token = normalizeAspectToken(key);

    if (!token || IGNORED_TOKENS.has(token)) {
      out[key] = value;
      return;
    }

    // Bereits ein gueltiger Katalogname -> niemals anfassen (Idempotenz).
    if (catalogIndex.has(token)) {
      out[key] = value;
      return;
    }

    const targets = synonymIndex.get(token);
    if (!targets) {
      out[key] = value;
      unknown.push({ name: key, reason: 'no_synonym' });
      return;
    }

    let targetName = null;
    let targetToken = null;
    for (const candidate of targets) {
      const candToken = normalizeAspectToken(candidate);
      if (!candToken) continue;
      if (catalogIndex.has(candToken)) {
        targetToken = candToken;
        targetName = catalogIndex.get(candToken);
        break;
      }
    }

    if (!targetName) {
      out[key] = value;
      unknown.push({ name: key, reason: 'target_missing' });
      return;
    }

    // Kollision: Zielname ist schon belegt. Nur wenn der Wert identisch ist,
    // ist das Zusammenfuehren verlustfrei — sonst NICHT umbenennen.
    if (occupied.has(targetToken)) {
      const existing = occupied.get(targetToken);
      const sameKey = normalizeAspectToken(key) === targetToken;
      if (!sameKey && !valuesEqual(existing, value)) {
        out[key] = value;
        unknown.push({ name: key, reason: 'collision' });
        return;
      }
    }

    renames.push({ from: key, to: targetName });
    if (mode === 'on') {
      if (!Object.prototype.hasOwnProperty.call(out, targetName)) out[targetName] = value;
      occupied.set(targetToken, value);
    } else {
      out[key] = value;
    }
  });

  if (mode === 'shadow') {
    return { ...base, renames, unknown, changed: false };
  }

  return {
    itemSpecifics: out,
    renames,
    unknown,
    mode,
    categoryId,
    catalogAvailable: true,
    changed: renames.length > 0,
  };
}

module.exports = {
  normalizeAspectNamesForCategory,
  normalizeAspectToken,
  buildCatalogNameIndex,
  buildSynonymIndex,
  getSynonymTable,
  getDeferredTable,
  MODES,
  DEFAULT_MODE,
  IGNORED_TOKENS,
};
