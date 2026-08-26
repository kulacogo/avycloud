/* eslint-disable no-console */
/**
 * Dedizierte, fokussierte GPSR-Extraktion vom Produktbild (Incident 2026-07-17).
 *
 * Der agentische Chat liest GPSR-Angaben vom Verpackungs-Etikett INKONSISTENT
 * (mal "Guangzhou Yuanshi/China" korrekt, mal "Gr4tec/Polen" mit vertauschten
 * Rollen), weil GPSR dort nur eine von vielen Aufgaben ist. Dieser Baustein
 * macht EINEN fokussierten, niedrig-temperierten Vision-Call mit striktem
 * Schema, der ausschließlich Hersteller- und EU-Verantwortlichen-Angaben genau
 * so ausliest, wie sie auf dem Karton stehen — deterministisch statt Glückssache.
 *
 * Liefert ein normalisiertes gpsr-Objekt (source='product_image') oder null,
 * wenn kein Compliance-Etikett sichtbar ist. Wirft nie.
 */

const { getGenAIClient } = require('./gemini3-client');
const { resolveModel } = require('./model-select');

// Trotz des ENV-Namens ein TEXT-/Vision-Call (GPSR-Etikett lesen), KEIN
// Bildgenerator — laeuft deshalb durch die zentrale Modellpolitik.
function resolveGpsrImageModel() {
  return resolveModel(process.env.GPSR_IMAGE_MODEL, 'GPSR_IMAGE_MODEL', 'gemini-2.5-flash');
}
const MAX_IMAGES = parseInt(process.env.GPSR_IMAGE_MAX || '4', 10);
const IMAGE_TIMEOUT_MS = parseInt(process.env.GPSR_IMAGE_FETCH_TIMEOUT_MS || '8000', 10);
const CALL_TIMEOUT_MS = parseInt(process.env.GPSR_IMAGE_CALL_TIMEOUT_MS || '30000', 10);

const GPSR_SCHEMA = {
  type: 'object',
  properties: {
    label_visible: {
      type: 'boolean',
      description: 'true nur wenn auf einem Bild ein Hersteller-/GPSR-/Compliance-Etikett (mit Manufacturer/EC REP/UK-AR o.ä.) tatsächlich lesbar ist.',
    },
    manufacturer_name: { type: 'string' },
    manufacturer_address: { type: 'string' },
    manufacturer_city: { type: 'string' },
    manufacturer_postalcode: { type: 'string' },
    manufacturer_country: { type: 'string' },
    manufacturer_email: { type: 'string' },
    manufacturer_phone: { type: 'string' },
    eu_responsible_name: { type: 'string' },
    eu_responsible_address: { type: 'string' },
    eu_responsible_city: { type: 'string' },
    eu_responsible_postalcode: { type: 'string' },
    eu_responsible_country: { type: 'string' },
    eu_responsible_email: { type: 'string' },
    eu_responsible_phone: { type: 'string' },
  },
  required: ['label_visible'],
};

const PROMPT = [
  'Du extrahierst GPSR-Compliance-Daten AUSSCHLIESSLICH aus den beigefügten Produkt-/Verpackungsfotos.',
  'Lies NUR, was auf dem Etikett/Karton GEDRUCKT steht. Erfinde NICHTS, rate NICHTS, ergänze KEINE Web-Kenntnisse.',
  'Rollen strikt nach der gedruckten Beschriftung zuordnen:',
  '- Zeile "Manufacturer:"/"Hersteller:" → manufacturer_* (der ECHTE Hersteller, auch wenn in China/CN — NICHT die Marke).',
  '- Zeile "EC REP"/"EU-Bevollmächtigter"/"EU-Verantwortlicher"/"EU-Rep" → eu_responsible_*.',
  '- Zeile "UK/AR"/"UK Responsible Person"/eine reine UK-Company-Adresse → NICHT der EU-Verantwortliche und NICHT der Hersteller — WEGLASSEN.',
  '- Eine allgemeine "Contact:"/"E-mail:"/"Service:"-Zeile, die NICHT unter dem EC-REP- oder UK/AR-Block steht (z. B. oben beim Modell/Ref), ist die Hersteller-/Produkt-Kontaktadresse → manufacturer_email (bzw. manufacturer_phone). NICHT die EC-REP-E-Mail hier eintragen.',
  'Vermische NIEMALS Adresse/PLZ/Telefon/E-Mail verschiedener Rollen. Jedes Feld gehört exakt zu der Rolle, unter der es gedruckt ist.',
  'Übertrage Werte wörtlich (Firmenname, Straße, PLZ, Stadt, Land, E-Mail, Telefon). Felder, die NICHT auf dem Etikett stehen, bleiben leer — NICHT raten.',
  'Ist KEIN Hersteller-/Compliance-Etikett lesbar: label_visible=false und alle Felder leer.',
].join('\n');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

// Manche Modell-Antworten füllen leere Felder mit dem LITERAL-String "null"/"n/a"/
// "-" statt sie wegzulassen. Diese Platzhalter sind KEINE echten Etikett-Werte und
// dürfen nie als Hersteller-/EU-Rep-Angabe durchrutschen.
const JUNK_VALUES = new Set(['null', 'n/a', 'na', 'none', 'nil', 'unknown', 'unbekannt', 'keine angabe', 'k.a.', 'ka', '-', '--', 'n.a.', 'not available', 'nicht angegeben']);
function isJunkValue(s) {
  return JUNK_VALUES.has(safeString(s).toLowerCase());
}

async function fetchImageParts(product) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  const candidates = images
    .filter((img) => typeof img?.url_or_base64 === 'string' && img.url_or_base64.startsWith('http'))
    .slice(0, MAX_IMAGES);
  if (!candidates.length) return [];
  const results = await Promise.all(
    candidates.map(async (img) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
        const res = await fetch(img.url_or_base64, { signal: controller.signal, headers: { Accept: 'image/*,*/*;q=0.8' } });
        clearTimeout(timer);
        if (!res.ok) return null;
        const contentType = res.headers.get('content-type') || 'image/jpeg';
        if (!contentType.startsWith('image/')) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 500 || buf.length > 10_000_000) return null;
        return { inlineData: { data: buf.toString('base64'), mimeType: contentType.split(';')[0].trim() } };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

async function _extractOnce(imageParts, aiClient) {
  const ai = aiClient || (await getGenAIClient());
  const contents = [{ role: 'user', parts: [{ text: PROMPT }, ...imageParts] }];
  const response = await Promise.race([
    ai.models.generateContent({
      model: resolveGpsrImageModel(),
      contents,
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseJsonSchema: GPSR_SCHEMA,
      },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('gpsr-image-extract timeout')), CALL_TIMEOUT_MS)),
  ]);
  const text = typeof response?.text === 'string' ? response.text : '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { reason: 'parse_failed' }; }
  if (!parsed || parsed.label_visible !== true) return { reason: 'no_label_visible' };

  const g = {};
  const put = (k, v) => { const s = safeString(v); if (s && !isJunkValue(s)) g[k] = s; };
  // E-Mail-Felder: nur echte Adressen (mit @) übernehmen. Das Modell schreibt
  // gelegentlich eine WEBSITE ins E-Mail-Feld (z.B. "www.firma.pl") — das lässt
  // eBay den Regulatory-Revise mit "E-Mail falsch formatiert" abweisen. Eine
  // erkennbare URL wird stattdessen als url gemerkt, alles andere verworfen.
  const putEmail = (k, v) => {
    const s = safeString(v);
    if (!s || isJunkValue(s)) return;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) { g[k] = s; return; }
    if (!g.url && (/^https?:\/\//i.test(s) || /^www\./i.test(s) || /^[^\s@]+\.[a-z]{2,}$/i.test(s))) {
      g.url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    }
  };
  put('manufacturer_name', parsed.manufacturer_name);
  put('manufacturer_address', parsed.manufacturer_address);
  put('manufacturer_city', parsed.manufacturer_city);
  put('manufacturer_postalcode', parsed.manufacturer_postalcode);
  put('entity_country', parsed.manufacturer_country);
  putEmail('email', parsed.manufacturer_email);
  put('manufacturer_phone', parsed.manufacturer_phone);
  put('eu_responsible_name', parsed.eu_responsible_name);
  put('eu_responsible_address', parsed.eu_responsible_address);
  put('eu_responsible_city', parsed.eu_responsible_city);
  put('eu_responsible_postalcode', parsed.eu_responsible_postalcode);
  put('eu_responsible_country', parsed.eu_responsible_country);
  putEmail('eu_responsible_email', parsed.eu_responsible_email);
  put('eu_responsible_phone', parsed.eu_responsible_phone);

  if (!g.manufacturer_name && !g.eu_responsible_name) return { reason: 'no_role_name' };
  return { gpsr: g, source: 'product_image' };
}

/**
 * @returns {Promise<{ gpsr: object, source: 'product_image' }|null>}
 */
async function extractGpsrFromImages(product, opts = {}) {
  let imageParts;
  try {
    imageParts = opts.imageParts || (await fetchImageParts(product));
  } catch {
    imageParts = [];
  }
  if (!imageParts || !imageParts.length) {
    console.warn('[gpsr-image-extract] null: no_images (product=%s)', product?.id || '?');
    return null;
  }

  // EIN Retry gegen transiente Timeouts (der Call läuft im Bulk direkt nach dem
  // schweren agentischen Enrich → Ressourcen-/Socket-Kontention → gelegentlicher
  // Timeout). Deterministisch korrektes Ergebnis darf daran nicht scheitern.
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await _extractOnce(imageParts, opts.aiClient);
      if (out && out.gpsr) return out;
      lastReason = (out && out.reason) || 'empty';
      if (lastReason === 'no_label_visible' || lastReason === 'no_role_name') break; // kein Retry-Nutzen
    } catch (err) {
      lastReason = `error:${err?.message || err}`;
    }
  }
  console.warn('[gpsr-image-extract] null: %s (product=%s)', lastReason, product?.id || '?');
  return null;
}

/**
 * Führt die vom Etikett gelesenen GPSR-Angaben mit denen zusammen, die bereits
 * auf der Änderungskarte stehen.
 *
 * WARUM ES DIESE FUNKTION GIBT (Vorfall 2026-08-10):
 * Die Aufrufstelle in routes/identify.js machte
 *
 *     gpsrChange.gpsr = { ...extracted.gpsr, source: 'product_image' };
 *
 * also ein ERSETZEN. `_extractOnce` liefert aber nur, was auf dem Foto
 * tatsächlich lesbar war — häufig nur der Hersteller. Alles, wozu das Etikett
 * schweigt (typisch: der EU-Verantwortliche), wurde damit gelöscht, obwohl
 * der Nutzer es kurz zuvor wörtlich diktiert hatte.
 *
 * Die Absicht der Ersetzung bleibt erhalten: das Etikett ist die
 * verlässlichere Quelle und gewinnt — aber nur FELDWEISE, dort wo es
 * überhaupt etwas sagt. Es darf nicht mehr löschen, wozu es schweigt.
 *
 * @param {object|null} cardGpsr  bereits auf der Karte stehende GPSR-Angaben
 * @param {object|null} labelGpsr vom Etikett gelesene Angaben
 * @returns {object} zusammengeführte Angaben
 */
function mergeLabelGpsrIntoCard(cardGpsr, labelGpsr) {
  const base = cardGpsr && typeof cardGpsr === 'object' ? cardGpsr : {};
  const label = labelGpsr && typeof labelGpsr === 'object' ? labelGpsr : {};
  const merged = { ...base };
  for (const [k, v] of Object.entries(label)) {
    const s = typeof v === 'string' ? v.trim() : v;
    if (s !== '' && s != null) merged[k] = s; // Etikett gewinnt, wo es etwas sagt
  }
  return merged;
}

module.exports = {
  extractGpsrFromImages,
  mergeLabelGpsrIntoCard,
  GPSR_SCHEMA,
  _internal: { fetchImageParts },
};
