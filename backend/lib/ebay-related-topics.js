'use strict';

/**
 * Empfehlungs-Kacheln ("Das koennte Sie auch interessieren") fuer die
 * eBay-Angebotsvorlage. Reine Funktionen, KEIN I/O.
 *
 * Siehe __tests__/ebay-related-topics.test.js fuer die Messwerte, aus denen
 * die Bauform folgt.
 */

const { classifyImageHost } = require('./image-hosts');
const { isPlaceholderBrand } = require('./gpsr-registry-guard');

function safeStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * Nur EIGENE Bilder duerfen in die Vorlage. Bewusst `own === true` statt
 * `blocked === false`: ein fremder, aber nicht gesperrter Host waere sonst
 * dabei. classifyImageHost packt `/api/image-proxy?url=`-Wrapper aus — ohne das
 * gilt ein durchgereichtes Amazon-Bild faelschlich als eigenes.
 */
function hatEigenesBild(candidate) {
  const url = safeStr(candidate?.imageUrl);
  if (!url) return false;
  return classifyImageHost(url).own === true;
}

/**
 * Zaehlt, wie viele Kandidaten je Thema im Pool stecken. Ein Thema gilt nur als
 * tragfaehig, wenn genug aktive Artikel dahinterstehen — sonst fuehrt die
 * Suchseite ins Leere.
 */
function buildTopicIndex(pool = [], { minTopicSize = 8 } = {}) {
  const produktart = new Map();
  const marke = new Map();
  const bump = (map, key) => {
    const k = safeStr(key);
    if (!k) return;
    map.set(k, (map.get(k) || 0) + 1);
  };
  (Array.isArray(pool) ? pool : []).forEach((c) => {
    bump(produktart, c?.produktart);
    bump(marke, c?.marke);
  });
  return { produktart, marke, minTopicSize };
}

const EBAY_SEARCH_BASE = 'https://www.ebay.de/sch/i.html';

/** Unter zwei Kacheln wird die Sektion gar nicht erst gerendert. */
const MIN_TILES = 2;

/**
 * Baut eine Verkaeufer-Suche. OHNE Suchwort listet sie ALLE aktiven Angebote des
 * Verkaeufers — deshalb ist sie der sichere Rueckfall: nie leer, und sie schickt
 * den Kaeufer nie zu einem Wettbewerber.
 */
function buildSellerSearchUrl(sellerId, keyword = '') {
  const seller = safeStr(sellerId);
  if (!seller) return '';
  const params = [`_ssn=${encodeURIComponent(seller)}`];
  const kw = safeStr(keyword);
  if (kw) params.push(`_nkw=${encodeURIComponent(kw)}`);
  return `${EBAY_SEARCH_BASE}?${params.join('&')}`;
}

/**
 * Bestes tragfaehiges Thema eines Kandidaten. Ein Thema unterhalb `minTopicSize`
 * wird verworfen — die Suchseite koennte sonst leer laufen, sobald ein paar
 * Artikel verkauft sind.
 */
function resolveTopic(candidate, index) {
  const min = index?.minTopicSize ?? 8;
  const produktart = safeStr(candidate?.produktart);
  if (produktart && (index?.produktart?.get(produktart) || 0) >= min) return produktart;
  const marke = safeStr(candidate?.marke);
  if (marke && (index?.marke?.get(marke) || 0) >= min) return marke;
  return '';
}

/**
 * Deterministischer Streuwert 0..1 aus zwei IDs.
 *
 * WARUM DETERMINISTISCH: die Beschreibung wird bei jedem Abgleich neu gerendert.
 * Mit Math.random() saehe jedes Angebot nach jedem Revise anders aus, kein Test
 * koennte das pruefen, und der Spiegel-Vergleich bekaeme staendig Bewegung.
 * Mit festem Streuwert bekommt jedes Produkt eine EIGENE, aber stabile Reihung —
 * so zeigen nicht alle Angebote derselben Art dieselben vier Nachbarn.
 */
function streuwert(produktId, kandidatId) {
  const s = `${safeStr(produktId)}#${safeStr(kandidatId)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Gewichte der Verwandtschafts-Signale.
 *
 * Begruendung aus der Bestandsmessung (2026-08-16, 1.338 Kandidaten):
 *
 *   - PRODUKTART ist das praeziseste Signal: 878 verschiedene Werte auf 1.338
 *     Produkte (Ø 1,5 Artikel je Art). Ein Treffer ist deshalb selten, aber
 *     dann sehr aussagekraeftig. Bekommt das hoechste Gewicht und schlaegt
 *     bewusst Kategorie + Marke ZUSAMMEN (100 > 40 + 30) — zwei schwache
 *     Signale sollen einen starken nicht ueberholen.
 *   - KATEGORIE liegt dazwischen: 732 Werte, 10 davon mit >= 8 Artikeln.
 *   - MARKE trifft am haeufigsten, sagt ueber Passung aber am wenigsten:
 *     873 Werte, und der groesste Einzelposten ist `Markenlos` mit 41
 *     Artikeln — die haben nichts miteinander zu tun. Platzhalter-"Marken"
 *     zaehlen deshalb NICHT (isPlaceholderBrand, dieselbe Quelle wie im
 *     GPSR-Registry-Guard — keine zweite Liste pflegen).
 */
const GEWICHT_PRODUKTART = 100;
const GEWICHT_KATEGORIE = 40;
const GEWICHT_MARKE = 30;

function gleich(a, b) {
  const x = safeStr(a).toLowerCase();
  const y = safeStr(b).toLowerCase();
  return Boolean(x) && x === y;
}

/**
 * Wie gut passt `kandidat` zu `produkt`? Hoeherer Wert = weiter vorn.
 * 0 bedeutet "keine erkennbare Verwandtschaft" — solche Kandidaten fuellen nur
 * auf und werden dann allein vom Streuwert sortiert.
 */
function bewerteNachbar(kandidat, produkt) {
  let score = 0;
  if (gleich(kandidat?.produktart, produkt?.produktart)) score += GEWICHT_PRODUKTART;
  if (gleich(kandidat?.categoryId, produkt?.categoryId)) score += GEWICHT_KATEGORIE;
  const marke = safeStr(kandidat?.marke);
  if (!isPlaceholderBrand(marke) && gleich(marke, produkt?.marke)) score += GEWICHT_MARKE;
  return score;
}

/**
 * Waehlt bis zu `max` Nachbarprodukte als Kacheln.
 */
function pickRelatedTiles({ product, pool = [], index = null, sellerId = '', max = 4 } = {}) {
  // FAIL-CLOSED: ohne Shopnamen laesst sich keine gueltige Suchadresse bauen.
  // Lieber gar keine Sektion als Kacheln, die ins Nichts fuehren.
  if (!safeStr(sellerId)) return [];

  const ownId = safeStr(product?.id);
  const candidates = (Array.isArray(pool) ? pool : [])
    .filter((c) => safeStr(c?.id) !== ownId)
    .filter((c) => safeStr(c?.title))
    .filter(hatEigenesBild);

  // Beste Passung zuerst; bei Gleichstand entscheidet der deterministische
  // Streuwert. Ohne dieses zweite Kriterium wuerde die Firestore-Lesereihenfolge
  // entscheiden — und die ist nicht stabil (siehe Vorfall DHL-Europaket 2026-08-07).
  const sortiert = candidates
    .map((c) => ({
      c,
      score: bewerteNachbar(c, product),
      streu: streuwert(ownId, safeStr(c.id)),
    }))
    .sort((a, b) => (b.score - a.score) || (a.streu - b.streu))
    .map((x) => x.c);

  const tiles = sortiert.slice(0, max).map((c) => {
    const topic = resolveTopic(c, index);
    return {
      productId: safeStr(c.id),
      title: safeStr(c.title),
      imageUrl: safeStr(c.imageUrl),
      topic,
      url: buildSellerSearchUrl(sellerId, topic),
    };
  });

  // Eine einzelne Kachel sieht nach Fehler aus — dann lieber keine Sektion.
  return tiles.length >= MIN_TILES ? tiles : [];
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  return v === null || v === undefined ? [] : [v];
}

/** Merkmalswert ueber mehrere Schreibweisen suchen (Gross-/Kleinschreibung egal). */
function merkmal(details, name) {
  const pools = [details?.attributes, details?.attributes_extra];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    const hit = Object.keys(pool).find((k) => safeStr(k).toLowerCase() === name.toLowerCase());
    if (!hit) continue;
    const v = Array.isArray(pool[hit]) ? pool[hit][0] : pool[hit];
    const value = safeStr(v);
    if (value && value.toLowerCase() !== 'unbekannt') return value;
  }
  return '';
}

/** Erste Bildadresse, die auf EIGENEM Speicher liegt. */
function ersteEigeneBildUrl(product) {
  const roh = [
    ...asArray(product?.details?.images),
    ...asArray(product?.images),
  ];
  for (const entry of roh) {
    const url = safeStr(
      typeof entry === 'string' ? entry : entry?.url_or_base64 || entry?.url || entry?.src || entry?.imageUrl
    );
    if (!url) continue;
    if (classifyImageHost(url).own === true) return url;
  }
  return '';
}

/**
 * Produktdokument -> Kachel-Kandidat. Liefert `null`, wenn das Produkt nicht als
 * Empfehlung taugt.
 *
 * Ausschlussgruende, alle mit Absicht:
 *   - kein Bestand: eine Empfehlung, die man nicht kaufen kann, ist wertlos
 *   - keine eBay-ItemID: steht gar nicht im Shop, die Suche fände es nicht
 *   - kein EIGENES Bild: fremde Marktplatzbilder duerfen nicht weiterverbreitet
 *     werden (23,5 % der Bilder sind urheberrechtlich gesperrt)
 *   - kein Titel: nichts zu zeigen
 */
function toCandidate(product) {
  if (!product) return null;
  if (Number(product?.inventory?.quantity || 0) <= 0) return null;
  if (!safeStr(product?.marketplace?.ebay?.itemId)) return null;

  const title = safeStr(product?.identification?.name);
  if (!title) return null;

  const imageUrl = ersteEigeneBildUrl(product);
  if (!imageUrl) return null;

  return { ...toTopicFields(product), title, imageUrl };
}

/**
 * Nur die Felder, die fuer die Verwandtschafts-Bewertung zaehlen.
 *
 * Getrennt von toCandidate, weil das Produkt, auf dessen Angebot die Kacheln
 * stehen, selbst KEIN gueltiger Kandidat sein muss (es kann z. B. das letzte
 * Stueck sein oder kein eigenes Bild haben) — bewertet werden muss es trotzdem.
 */
function toTopicFields(product) {
  const details = product?.details || {};
  return {
    id: safeStr(product?.id),
    produktart: merkmal(details, 'Produktart'),
    marke: safeStr(product?.identification?.brand) || merkmal(details, 'Marke'),
    categoryId: safeStr(details?.categoryId || details?.ebayCategoryId),
  };
}

function escapeHtml(value) {
  return safeStr(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * CSS der Sektion. Bewusst schlank: keine Schriften, keine Effekte, keine
 * festen Pixelbreiten. Vier Kacheln je Reihe, am Handy zwei.
 */
const RELATED_TOPICS_CSS = `
.to-reco { margin: 32px 0; }
.to-reco-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.to-reco-card { display: block; text-decoration: none; color: inherit; }
.to-reco-card img { width: 100%; aspect-ratio: 1/1; object-fit: contain; background: #fafafa; display: block; }
.to-reco-name { font-size: 12px; line-height: 1.4; color: #444; margin-top: 6px; }
.to-reco-more { font-size: 11px; color: #888; margin-top: 2px; }
@media (max-width: 640px) {
  .to-reco-grid { grid-template-columns: repeat(2, 1fr); gap: 10px; }
}`;

/**
 * Rendert die Empfehlungs-Sektion.
 *
 * Bewusste Entscheidungen:
 *   - `loading="lazy"` + `decoding="async"`: eBay bewertet seit 2024 die
 *     Ladezeit am Handy. Die Bilder werden erst geladen, wenn der Kaeufer
 *     hinunterscrollt.
 *   - Der Produkttitel steht als TEXT in der Kachel — er ist der Teil, den
 *     eBay als (schwaches) Nebensignal auswertet.
 *   - KEIN Preis. Siehe pickRelatedTiles.
 *   - Keine Scripte, keine iframes, keine on*-Attribute — eBay verbietet
 *     aktive Inhalte in der Artikelbeschreibung.
 */
function buildRelatedTopicsHtml(tiles) {
  const list = Array.isArray(tiles) ? tiles.filter(Boolean) : [];
  if (list.length < MIN_TILES) return '';

  const cards = list.map((t) => {
    const alt = escapeHtml(t.title);
    const mehr = safeStr(t.topic)
      ? `<div class="to-reco-more">Mehr: ${escapeHtml(t.topic)}</div>`
      : '';
    return `<a class="to-reco-card" href="${escapeHtml(t.url)}" target="_blank" rel="noopener">`
      + `<img src="${escapeHtml(t.imageUrl)}" alt="${alt}" loading="lazy" decoding="async">`
      + `<div class="to-reco-name">${alt}</div>${mehr}</a>`;
  }).join('');

  return `
  <div class="to-reco">
    <div class="to-section-label">Das könnte Sie auch interessieren</div>
    <div class="to-reco-grid">${cards}</div>
  </div>`;
}

/** Schalter. Vorgabe AUS — ohne `on` bleibt die Vorlage Byte fuer Byte wie bisher. */
function isRelatedTopicsEnabled() {
  return String(process.env.EBAY_RELATED_TOPICS || '').trim().toLowerCase() === 'on';
}

/** Shopname (eBay-Verkaeufername) fuer die Such-Adressen. Leer => Sektion faellt weg. */
function getShopSellerId() {
  return safeStr(process.env.EBAY_SHOP_SELLER_ID);
}

module.exports = {
  buildTopicIndex,
  pickRelatedTiles,
  toCandidate,
  toTopicFields,
  buildRelatedTopicsHtml,
  isRelatedTopicsEnabled,
  getShopSellerId,
  buildSellerSearchUrl,
  bewerteNachbar,
  RELATED_TOPICS_CSS,
  MIN_TILES,
};
