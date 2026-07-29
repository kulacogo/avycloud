/**
 * Kaufsicherheits-Bloecke fuer die eBay-Angebotsbeschreibung.
 *
 * Reine Funktionen, kein I/O. Rendert aus BEREITS VORHANDENEN Feldern drei Bloecke:
 * Lieferumfang, "Maße & Gewicht" und Passgenauigkeit — plus ein mobiltaugliches Layout.
 *
 * Befund (Audit 2026-07-29, 765 Bestandsprodukte): 80 % nennen keinen Lieferumfang,
 * 37 % keine Massangabe, 67 % nichts zur Passgenauigkeit. "Was ist eigentlich drin?"
 * ist die haeufigste Rueckfrage vor dem Kauf — wer das nicht findet, kauft woanders.
 *
 * HARTE REGELN:
 *   - Verlustfrei: fehlt die Quelle, faellt der Block komplett weg. Nie "Unbekannt".
 *   - Nichts erfinden: gerendert wird nur, was im Datenblatt steht.
 *   - eBay verbietet aktive Inhalte (Script/iframe/Formulare) und mag keine festen
 *     Pixelbreiten. Beides wird hier nicht erzeugt.
 */

/** Werte, die faktisch "keine Angabe" bedeuten und nie gerendert werden duerfen. */
const PLATZHALTER = new Set([
  'unbekannt', 'unknown', 'n/a', 'na', 'k.a.', 'ka', 'keine angabe',
  'nicht zutreffend', 'nicht verfuegbar', 'nicht verfügbar',
  'does not apply', 'todo', '-', '--', '?', 'null', 'none', 'sonstige',
]);

const LIEFERUMFANG_KEYS = ['lieferumfang', 'set beinhaltet', 'set enthält', 'inhalt', 'im lieferumfang'];
const KOMPAT_KEYS = ['passend für', 'passend fuer', 'kompatibel mit', 'kompatibilität', 'kompatibilitaet', 'geeignet für', 'geeignet fuer', 'fahrzeugtyp'];
const MASS_EINZEL = ['Länge', 'Breite', 'Höhe', 'Tiefe', 'Durchmesser'];
const MASS_GESAMT = ['Maße', 'Masse', 'Abmessungen', 'Größe', 'Produktmaße'];

function safeStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function istPlatzhalter(value) {
  const v = safeStr(value).toLowerCase();
  if (!v) return true;
  return PLATZHALTER.has(v);
}

function escapeHtml(value) {
  return safeStr(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Sucht einen Merkmalswert ueber mehrere moegliche Schluesselnamen (Gross-/Kleinschreibung egal). */
function findeMerkmal(details, keys) {
  const pools = [details?.attributes, details?.attributes_extra];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const wanted of keys) {
      const hit = Object.keys(pool).find((k) => safeStr(k).toLowerCase() === safeStr(wanted).toLowerCase());
      if (!hit) continue;
      const value = safeStr(pool[hit]);
      if (value && !istPlatzhalter(value)) return { key: hit, value };
    }
  }
  return null;
}

/** Zerlegt eine Aufzaehlung in Einzelpositionen (Zeilenumbruch, Semikolon, Komma). */
function zuPositionen(raw) {
  const text = safeStr(raw);
  if (!text) return [];
  const trenner = /\r?\n|;|,/;
  return text
    .split(trenner)
    .map((x) => safeStr(x).replace(/^[-*•]\s*/, ''))
    .filter((x) => x && !istPlatzhalter(x));
}

function resolveScopeOfDelivery(product) {
  const details = product?.details || {};

  const feld = details?.scope_of_delivery;
  if (Array.isArray(feld)) {
    const items = feld.map(safeStr).filter((x) => x && !istPlatzhalter(x));
    if (items.length) return { items, source: 'field' };
  } else if (safeStr(feld)) {
    const items = zuPositionen(feld);
    if (items.length) return { items, source: 'field' };
  }

  const merkmal = findeMerkmal(details, LIEFERUMFANG_KEYS);
  if (merkmal) {
    const items = zuPositionen(merkmal.value);
    if (items.length) return { items, source: 'attribute' };
  }

  return { items: [], source: null };
}

function resolveDimensions(product) {
  const details = product?.details || {};
  const rows = [];

  const gesamt = findeMerkmal(details, MASS_GESAMT);
  if (gesamt) rows.push({ label: 'Maße', value: gesamt.value });

  if (!gesamt) {
    for (const label of MASS_EINZEL) {
      const hit = findeMerkmal(details, [label]);
      if (hit) rows.push({ label, value: hit.value });
    }
  }

  const gewicht = Number(details?.weight);
  if (Number.isFinite(gewicht) && gewicht > 0) {
    const anzeige = Number.isInteger(gewicht) ? String(gewicht) : String(gewicht).replace('.', ',');
    rows.push({ label: 'Gewicht', value: `${anzeige} kg` });
  }

  return { rows, source: rows.length ? 'attributes' : null };
}

function resolveCompatibility(product) {
  const details = product?.details || {};
  const merkmal = findeMerkmal(details, KOMPAT_KEYS);
  if (!merkmal) return { items: [], source: null };
  const items = zuPositionen(merkmal.value);
  if (!items.length) return { items: [], source: null };
  return { items, source: 'attribute', label: merkmal.key };
}

/** Umbruchpunkt fuer Handys — ueber 60 % der eBay-Kaeufe laufen mobil. */
function buildMobileStyles() {
  return `
@media (max-width: 640px) {
  .to-wrap { padding: 12px; }
  .to-product { display: block; }
  .to-product-image, .to-product-info { max-width: 100%; width: 100%; }
  .to-title { font-size: 20px; line-height: 1.3; }
  .to-facts-row { display: block; }
  .to-facts-label { display: block; font-weight: 700; }
  .to-related-grid { gap: 10px; }
}`;
}

function renderListe(titel, items) {
  const li = items.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  return `
  <div class="to-section">
    <div class="to-section-label">${escapeHtml(titel)}</div>
    <ul>${li}</ul>
  </div>`;
}

function renderTabelle(titel, rows) {
  const zeilen = rows
    .map(
      (r) =>
        `<div class="to-facts-row"><span class="to-facts-label">${escapeHtml(r.label)}</span>`
        + `<span class="to-facts-value">${escapeHtml(r.value)}</span></div>`
    )
    .join('');
  return `
  <div class="to-section">
    <div class="to-section-label">${escapeHtml(titel)}</div>
    <div class="to-facts">${zeilen}</div>
  </div>`;
}

/**
 * Baut die zusaetzlichen Bloecke. Leerer String, wenn keine einzige Quelle etwas hergibt.
 */
function buildDescriptionBlocks(product) {
  const teile = [];

  const lieferumfang = resolveScopeOfDelivery(product);
  if (lieferumfang.items.length) teile.push(renderListe('Lieferumfang', lieferumfang.items));

  const masse = resolveDimensions(product);
  if (masse.rows.length) teile.push(renderTabelle('Maße & Gewicht', masse.rows));

  const kompat = resolveCompatibility(product);
  if (kompat.items.length) teile.push(renderListe('Passgenauigkeit', kompat.items));

  return teile.join('');
}

/** Ist der Schalter an? Default 'off' == heutige Vorlage byte-identisch. */
function isDescriptionBlocksEnabled() {
  return String(process.env.EBAY_DESCRIPTION_BLOCKS || '').trim().toLowerCase() === 'on';
}

module.exports = {
  resolveScopeOfDelivery,
  resolveDimensions,
  resolveCompatibility,
  buildDescriptionBlocks,
  buildMobileStyles,
  isDescriptionBlocksEnabled,
};
