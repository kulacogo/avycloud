'use strict';

/**
 * cassini-category-map.js
 *
 * Mapping eBay-DE L1 Top-Level-Categories -> 9 Cassini-Buckets aus dem
 * Strategischer eBay Leitfaden, Sektion 9 (Title-Patterns pro Kategorie).
 *
 * 9 Buckets:
 *   fashion            (Kleidung & Accessoires)
 *   electronics        (Computer, Handys, TV, Konsolen)
 *   home_garden        (Moebel, Baumarkt, Deko)
 *   motors             (Auto- & Motorradteile)
 *   collectibles       (Sammeln, Antiquitaeten, Kunst, Muenzen, Trading Cards)
 *   toys               (Spielzeug & Modellbau)
 *   books_music_films  (Buecher, Musik, Filme, Videospiele)
 *   business_industrial(B2B)
 *   hobby_sport        (Sport, Camping, Musikinstrumente)
 *
 * Funktionen:
 *   getCassiniCategoryBucket(ebayCategoryId, ebayBreadcrumb?) -> bucket | 'default'
 *   getCategoryPattern(bucket) -> Title-Pattern-String fuer SEO-Title-Worker
 *
 * Pure CJS, keine externen Abhaengigkeiten.
 */

// eBay-DE Top-Level L1 Category IDs.
// Quelle: eBay Trading API GetCategoryFeatures + manuelle Recherche auf
// https://www.ebay.de/n/all-categories
// Strings (NICHT Numbers), weil eBay-IDs in firestore typischerweise als Strings
// gespeichert werden und ueberraschenderweise JSON-Numbers >MAX_SAFE_INTEGER
// einzelne Edge-Cases produzieren koennten.
const L1_BUCKET_MAP = Object.freeze({
  // fashion
  '11450': 'fashion',     // Kleidung & Accessoires
  '281': 'fashion',       // Schmuck & Uhren
  // electronics
  '293': 'electronics',   // Elektronik / Consumer Electronics
  '58058': 'electronics', // Handys & Kommunikation
  '15032': 'electronics', // Handys & Smartphones
  '177': 'electronics',   // Computer, Tablets & Netzwerk
  '625': 'electronics',   // Foto & Camcorder
  '32852': 'electronics', // Audio & Hi-Fi
  '11232': 'electronics', // TV, Video & Audio
  // home_garden
  '11700': 'home_garden', // Moebel & Wohnen
  '159912': 'home_garden',// Heimwerker
  '20081': 'home_garden', // Garten & Terrasse
  // motors
  '9800': 'motors',       // Auto & Motorrad: Teile
  '6028': 'motors',       // Auto & Motorrad: Fahrzeuge (Top-Container)
  // collectibles
  '1': 'collectibles',    // Antiquitaeten & Kunst
  '550': 'collectibles',  // Kunst
  '20121': 'collectibles',// Sammeln & Seltenes
  '64482': 'collectibles',// Sport-Memorabilia, Fan-Shop & Trading Cards
  // toys
  '220': 'toys',          // Spielzeug
  // books_music_films
  '267': 'books_music_films', // Buecher
  '11233': 'books_music_films',// Musik (CDs, Vinyl)
  '11232.1': 'books_music_films', // Film & DVD (kuenstlich diff, see fallback below)
  '617': 'books_music_films', // Filme & DVDs
  '1249': 'books_music_films',// PC- & Videospiele
  // business_industrial
  '12576': 'business_industrial', // Business & Industrie
  // hobby_sport
  '888': 'hobby_sport',   // Sport
  '619': 'hobby_sport',   // Musikinstrumente
  '237': 'hobby_sport',   // Modellbau (Hobby-nah)
});

// Title-Patterns aus Leitfaden Sektion 9 (verbatim, Diakritika reduziert fuer
// Konsistenz mit JSON-Prompt-Files die ohne Umlaute geschrieben sind).
const PATTERNS = Object.freeze({
  fashion:
    '[Marke] [Modell/Linie] [Produkttyp] [Zielgruppe] [Groesse] [Farbe] [Material]',
  electronics:
    '[Marke] [Modellname] [Modellnummer/MPN] [Hauptmerkmal/Prozessor] [Farbe]',
  home_garden:
    '[Marke/Hersteller] [Produktbezeichnung] [Material] [Maße/Groesse] [Farbe] [Stil/Zustand]',
  motors:
    '[Hersteller] [Teilename] [Einbauposition] [OEM/OES-Referenznummer]',
  collectibles:
    '[Jahr/Epoche] [Objektbezeichnung] [Edition/Besonderheit] [Zustand/Grading]',
  toys:
    '[Marke] [Thema/Charakter] [Set-Nummer] [Produktart] [Zustand]',
  books_music_films:
    '[Titel] [Autor/Kuenstler/Plattform] [Format/Medium] [Edition] [Zustand]',
  business_industrial:
    '[Marke] [Modell/Geraetetyp] [Spezifikation/Leistung] [Herstellernummer/MPN]',
  hobby_sport:
    '[Marke] [Modell] [Sportart/Aktivitaet] [Spezifikation/Groesse] [Farbe]',
  default:
    '[Marke] [Modell] [Produkttyp] [Hauptmerkmal]',
});

// Keyword-Match Fallback wenn keine L1-ID matcht (z.B. Sub-Category-IDs).
// Wird auf den lower-cased ebayBreadcrumb-Join angewendet.
// Reihenfolge wichtig: spezifische Treffer (motors, business) vor generischen.
const BREADCRUMB_KEYWORDS = Object.freeze([
  { bucket: 'motors',             keywords: ['auto & motorrad', 'autoteile', 'kfz-teile', 'motorradteile', 'auto- & motorradteile'] },
  { bucket: 'business_industrial',keywords: ['business & industrie', 'b2b', 'gewerbe'] },
  { bucket: 'fashion',            keywords: ['kleidung', 'damenmode', 'herrenmode', 'kindermode', 'schuhe', 'accessoires', 'schmuck', 'uhren'] },
  { bucket: 'electronics',        keywords: ['handy & tablet', 'handy', 'smartphone', 'computer', 'laptop', 'tv, video', 'foto', 'audio', 'elektronik', 'konsole'] },
  { bucket: 'home_garden',        keywords: ['moebel', 'wohnen', 'heimwerker', 'baumarkt', 'garten', 'terrasse', 'kueche', 'haushalt'] },
  { bucket: 'collectibles',       keywords: ['antiquitaeten', 'kunst', 'sammeln', 'muenzen', 'briefmarken', 'trading cards', 'memorabilia'] },
  { bucket: 'toys',               keywords: ['spielzeug', 'modellbau', 'lego', 'puppen'] },
  { bucket: 'books_music_films',  keywords: ['buecher', 'musik', 'cd', 'vinyl', 'film', 'dvd', 'blu-ray', 'videospiel', 'pc-spiel', 'konsolen-spiel'] },
  { bucket: 'hobby_sport',        keywords: ['sport', 'camping', 'outdoor', 'fitness', 'fahrrad', 'musikinstrument'] },
]);

const VALID_BUCKETS = new Set([
  'fashion',
  'electronics',
  'home_garden',
  'motors',
  'collectibles',
  'toys',
  'books_music_films',
  'business_industrial',
  'hobby_sport',
  'default',
]);

function _normalizeId(ebayCategoryId) {
  if (ebayCategoryId == null) return '';
  if (typeof ebayCategoryId === 'number') return String(ebayCategoryId);
  if (typeof ebayCategoryId === 'string') return ebayCategoryId.trim();
  return '';
}

function _normalizeBreadcrumb(input) {
  if (!input) return '';
  if (Array.isArray(input)) {
    return input.filter(Boolean).map((s) => String(s).toLowerCase()).join(' > ');
  }
  return String(input).toLowerCase();
}

/**
 * getCassiniCategoryBucket(ebayCategoryId, ebayBreadcrumb?)
 *
 * Liefert einen der 9 Buckets oder 'default'.
 * Strategie:
 *   1. Exakter L1-ID-Match in L1_BUCKET_MAP.
 *   2. Wenn nicht, Sub-Category-ID-Match (selbe Map, optimistic prefix).
 *      ID '11450X' -> versuche '11450' als Fallback.
 *   3. Wenn nicht, Keyword-Match auf ebayBreadcrumb.
 *   4. Sonst 'default'.
 *
 * @param {string|number|null} ebayCategoryId
 * @param {string|string[]|null} ebayBreadcrumb
 * @returns {'fashion'|'electronics'|'home_garden'|'motors'|'collectibles'|'toys'|'books_music_films'|'business_industrial'|'hobby_sport'|'default'}
 */
function getCassiniCategoryBucket(ebayCategoryId, ebayBreadcrumb = null) {
  const id = _normalizeId(ebayCategoryId);

  // Strategie 1: exakter Treffer.
  if (id && L1_BUCKET_MAP[id]) return L1_BUCKET_MAP[id];

  // Strategie 2: ID-Prefix-Fallback (Sub-IDs sind oft Hierarchie-Kinder der L1).
  // Wir versuchen die ersten 3-5 Zeichen.
  if (id && /^\d+$/.test(id) && id.length > 3) {
    for (let len = Math.min(id.length - 1, 5); len >= 3; len -= 1) {
      const prefix = id.slice(0, len);
      if (L1_BUCKET_MAP[prefix]) return L1_BUCKET_MAP[prefix];
    }
  }

  // Strategie 3: Keyword-Match auf Breadcrumb.
  const bc = _normalizeBreadcrumb(ebayBreadcrumb);
  if (bc) {
    for (const { bucket, keywords } of BREADCRUMB_KEYWORDS) {
      for (const kw of keywords) {
        if (bc.includes(kw)) return bucket;
      }
    }
  }

  return 'default';
}

/**
 * getCategoryPattern(bucket)
 *
 * Liefert das Title-Pattern fuer den SEO-Title-Worker.
 *
 * @param {string} bucket
 * @returns {string} Pattern-String
 */
function getCategoryPattern(bucket) {
  const safe = typeof bucket === 'string' && VALID_BUCKETS.has(bucket) ? bucket : 'default';
  return PATTERNS[safe] || PATTERNS.default;
}

module.exports = {
  getCassiniCategoryBucket,
  getCategoryPattern,
  // Exposed for tests and future seed scripts:
  _internal: {
    L1_BUCKET_MAP,
    PATTERNS,
    BREADCRUMB_KEYWORDS,
    VALID_BUCKETS,
  },
};
