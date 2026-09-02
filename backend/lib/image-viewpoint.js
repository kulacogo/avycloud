/* eslint-disable no-console */
/**
 * image-viewpoint.js — Beleg-Bilanz für Produktansichten.
 *
 * WARUM ES DAS GIBT (Beschwerde 2026-09-02 "Varianten sind nicht originalgetreu"):
 * `services/prompt-engine.js` verlangte pauschal vier Ansichten — 3/4-Front,
 * 45-Grad-Seite, Makro-Detail und RÜCKANSICHT — und schickte dem Modell dazu ein
 * einziges Frontfoto. Die Rückseite des Produkts hatte nie eine Stufe gesehen.
 * Das Modell KONNTE sie nicht reproduzieren, es konnte sie nur erfinden.
 * Recherchiert und belegt: Novel-View-Synthesis aus einem Bild ist mathematisch
 * unterbestimmt; ab etwa 60 Grad Blickwinkeländerung ist praktisch das gesamte
 * Zielbild erfunden. Kein Prompt und kein Modell heilt das.
 *
 * Die Lösung ist DIESELBE wie bei der Erfassung (CLAUDE.md Punkt 17): nicht die
 * Ergebnisqualität messen, sondern fragen, ob eine Fläche überhaupt je
 * fotografiert wurde. Ein Bild ohne diesen Beleg gehört nicht in ein echtes
 * Angebot — eBay verbietet ausdrücklich "photos that don't accurately represent
 * the item" und schreibt: "using these tools to alter a product in any way is
 * against eBay's policies". Kaufland verlangt FOTOS und verbietet Montagen.
 *
 * Dieses Modul beantwortet genau EINE Frage je Produkt:
 *   Welche Ansichten liegen als ECHTES Foto vor?
 * Es urteilt NICHT über die Schönheit eines Bildes und erfindet nichts.
 */

const { getGenAIClient } = require('./gemini3-client');
const { resolveModel } = require('./model-select');

// Vision-Klassifikation ist ein TEXT-Call (Bild rein, JSON raus), KEIN Bildgenerator
// — läuft deshalb bewusst durch die zentrale Modellpolitik aus model-select.js.
function resolveViewpointModel() {
  return resolveModel(process.env.VIEWPOINT_MODEL, 'VIEWPOINT_MODEL', 'gemini-2.5-flash');
}

const CALL_TIMEOUT_MS = parseInt(process.env.VIEWPOINT_CALL_TIMEOUT_MS || '30000', 10);
const MAX_CLASSIFY_IMAGES = parseInt(process.env.VIEWPOINT_MAX_IMAGES || '8', 10);

/**
 * Ansichts-Klassen. Bewusst grob: feiner unterscheiden zu wollen macht die
 * Klassifikation unzuverlässig, und wir brauchen nur die Frage "welche Seite?".
 */
const VIEWPOINTS = Object.freeze([
  'front',      // Vorderseite, frontal oder leicht schräg
  'back',       // Rückseite
  'side',       // Seitenansicht (links/rechts)
  'top',        // Draufsicht
  'bottom',     // Unteransicht (oft Typenschild)
  'detail',     // Nahaufnahme eines Teilbereichs
  'label',      // Etikett, Typenschild, Verpackungsaufdruck
  'packaging',  // Karton/Verpackung statt Produkt
  'unclear',    // nicht zuzuordnen
]);

const VIEWPOINT_LABELS_DE = Object.freeze({
  front: 'Vorderansicht',
  back: 'Rückansicht',
  side: 'Seitenansicht',
  top: 'Draufsicht',
  bottom: 'Unteransicht',
  detail: 'Detailaufnahme',
  label: 'Etikett',
  packaging: 'Verpackung',
  unclear: 'nicht zuzuordnen',
});

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: '0-basierte Position des Bildes in der Reihenfolge, in der es gezeigt wurde.' },
          viewpoint: { type: 'string', enum: [...VIEWPOINTS] },
          shows_product: { type: 'boolean', description: 'true wenn das eigentliche Produkt zu sehen ist (nicht nur Verpackung, Zubehör oder ein Katalogblatt).' },
          product_fully_visible: { type: 'boolean', description: 'true wenn das Produkt vollständig im Bild ist und nicht angeschnitten.' },
          usable_as_reference: { type: 'boolean', description: 'true wenn das Bild scharf und hell genug ist, um die Form und Farbe des Produkts zuverlässig zu zeigen.' },
          confidence: { type: 'number', description: '0..1 — wie sicher die Zuordnung ist.' },
          note: { type: 'string', description: 'Kurze Begründung, deutsch, maximal ein Satz.' },
        },
        required: ['index', 'viewpoint', 'shows_product', 'usable_as_reference', 'confidence'],
      },
    },
    same_product_throughout: {
      type: 'boolean',
      description: 'false wenn die Bilder erkennbar verschiedene Artikel zeigen.',
    },
  },
  required: ['images', 'same_product_throughout'],
};

const PROMPT = [
  'Du bekommst die Produktfotos EINES Artikels, in Reihenfolge nummeriert ab 0.',
  'Ordne JEDEM Bild zu, WELCHE SEITE des Artikels darauf zu sehen ist.',
  '',
  'Regeln:',
  '- Urteile ausschliesslich danach, was tatsaechlich abgebildet ist. Rate nicht.',
  '- "front" ist die Seite mit Bedienelementen, Marke oder Hauptansicht; "back" ist die',
  '  gegenueberliegende Seite. Bist du dir nicht sicher, welche Seite es ist, nimm "unclear".',
  '- Ein Bild, das ueberwiegend den Karton zeigt, ist "packaging", auch wenn das Produkt',
  '  darauf abgebildet ist.',
  '- Ein Bild eines Typenschilds, Aufklebers oder einer Beschriftung ist "label".',
  '- "usable_as_reference" ist nur dann true, wenn Form und Farbe des Artikels klar erkennbar',
  '  sind: nicht unscharf, nicht zu dunkel, nicht extrem angeschnitten.',
  '- Setze "confidence" ehrlich niedrig, wenn du dir nicht sicher bist. Eine niedrige',
  '  Sicherheit ist brauchbar, eine falsche Zuordnung nicht.',
  '',
  'Antworte ausschliesslich mit dem geforderten JSON.',
].join('\n');

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Klassifiziert bereits geladene Bild-Parts.
 * WIRFT NIE — bei jedem Fehler kommt `null` zurück und der Aufrufer behandelt das
 * als "kein Beleg" (fail-closed für die Erzeugung, fail-open für die Route).
 *
 * @param {Array<{inlineData:{data:string,mimeType:string}}>} imageParts
 * @returns {Promise<{views: Array, sameProductThroughout: boolean, model: string}|null>}
 */
async function classifyViewpointParts(imageParts, opts = {}) {
  if (!Array.isArray(imageParts) || !imageParts.length) return null;
  const parts = imageParts.slice(0, MAX_CLASSIFY_IMAGES);

  try {
    const ai = opts.aiClient || (await getGenAIClient());
    const model = resolveViewpointModel();
    const response = await Promise.race([
      ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: PROMPT }, ...parts] }],
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseJsonSchema: CLASSIFY_SCHEMA,
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('image-viewpoint timeout')), CALL_TIMEOUT_MS)
      ),
    ]);

    const text = typeof response?.text === 'string' ? response.text : '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn('[image-viewpoint] Antwort nicht lesbar');
      return null;
    }
    if (!parsed || !Array.isArray(parsed.images)) return null;

    const views = [];
    const vergeben = new Set();
    for (const row of parsed.images) {
      const index = Number.isInteger(row?.index) ? row.index : null;
      // Ein Index ausserhalb der gezeigten Bilder ist eine Halluzination und wird
      // verworfen — dieselbe Regel wie beim Duplikat-Urteil (erlaubteIds-Gate).
      if (index === null || index < 0 || index >= parts.length) continue;
      // Denselben Index zweimal zu vergeben hiesse, ein Foto gleichzeitig als
      // Vorder- UND Rueckansicht zu fuehren — die zweite Ansicht bekaeme dieselbe
      // Vorlage mit falscher Beschriftung. Der erste Treffer gewinnt.
      if (vergeben.has(index)) continue;
      vergeben.add(index);
      const viewpoint = VIEWPOINTS.includes(row?.viewpoint) ? row.viewpoint : 'unclear';
      views.push({
        index,
        viewpoint,
        showsProduct: row?.shows_product === true,
        fullyVisible: row?.product_fully_visible === true,
        usableAsReference: row?.usable_as_reference === true,
        confidence: clamp01(row?.confidence),
        note: typeof row?.note === 'string' ? row.note.slice(0, 200) : '',
      });
    }
    if (!views.length) return null;

    return {
      views,
      sameProductThroughout: parsed.same_product_throughout !== false,
      model,
    };
  } catch (err) {
    console.warn(`[image-viewpoint] Klassifikation fehlgeschlagen: ${err.message}`);
    return null;
  }
}

/**
 * Mindest-Sicherheit, ab der eine Ansicht als BELEGT gilt.
 * Bewusst hoch: die Kosten sind asymmetrisch. Eine verpasste Ansicht kostet ein
 * Bild, das der Bediener von Hand nachfotografieren kann — eine falsch als belegt
 * geltende Ansicht erzeugt genau das erfundene Bild, das der Umbau verhindern soll.
 */
function minViewpointConfidence() {
  const raw = parseFloat(process.env.VIEWPOINT_MIN_CONFIDENCE || '0.6');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.6;
}

/**
 * Reduziert die Klassifikation auf die eine Frage, um die es geht:
 * welche Ansichten sind durch ein brauchbares echtes Foto BELEGT?
 *
 * @returns {{byViewpoint: Object, belegt: string[], referenceIndexes: number[]}}
 */
function summarizeEvidence(classification) {
  const empty = { byViewpoint: {}, belegt: [], referenceIndexes: [] };
  if (!classification?.views?.length) return empty;

  const minConf = minViewpointConfidence();
  const byViewpoint = {};
  const referenceIndexes = [];

  for (const view of classification.views) {
    if (!view.showsProduct) continue;
    if (view.usableAsReference) referenceIndexes.push(view.index);
    if (view.confidence < minConf) continue;
    if (view.viewpoint === 'unclear' || view.viewpoint === 'packaging') continue;
    // Ein unscharfes oder zu dunkles Foto wird NICHT Vorlage: aus einer schlechten
    // Vorlage kann nur ein schlechter Packshot werden, und das Modell fuellt
    // Unschaerfe mit Erfindung auf. Es zaehlt auch nicht als Identitaetsanker
    // (`referenceIndexes` sammelt nur brauchbare Fotos) — ein Anker, auf dem man
    // nichts erkennt, ankert nichts.
    if (!view.usableAsReference) continue;
    if (!byViewpoint[view.viewpoint]) byViewpoint[view.viewpoint] = [];
    byViewpoint[view.viewpoint].push(view);
  }

  // Innerhalb einer Ansicht das beste Foto zuerst: sicher, vollständig, brauchbar.
  for (const key of Object.keys(byViewpoint)) {
    byViewpoint[key].sort((a, b) => {
      const score = (v) => v.confidence + (v.fullyVisible ? 0.5 : 0) + (v.usableAsReference ? 0.5 : 0);
      return score(b) - score(a);
    });
  }

  return {
    byViewpoint,
    belegt: Object.keys(byViewpoint),
    referenceIndexes,
  };
}

/**
 * Der Plan: EIN aufbereitetes Studio-Bild je BRAUCHBAREM ECHTEN FOTO,
 * bis zum Kontingent (Voreinstellung 4).
 *
 * Das ist die inhaltliche Kehrtwende gegenüber dem alten Verhalten. Vorher wurden
 * vier feste Perspektiven verlangt, egal was fotografiert war — drei davon musste
 * das Modell erfinden. Jetzt sitzt JEDE Ausgabe auf einer echten Aufnahme.
 *
 * VERGABE IN RUNDEN, nicht eine Ausgabe je Ansichts-Kategorie (Korrektur
 * 2026-09-03): Runde 1 nimmt das beste Foto JEDER Ansicht — so gewinnt die
 * Vielfalt, und Vorder-, Seiten- und Rückansicht stehen vorn. Sind danach noch
 * Plätze frei, füllen weitere Runden sie mit den nächstbesten Fotos derselben
 * Ansichten. Vorher blieben bei fünf Fotos derselben Seite vier davon ungenutzt
 * und der Bediener bekam ein einziges Bild, obwohl reichlich Material dalag.
 *
 * Weniger echte Fotos heissen weiterhin weniger Bilder — die Zahl 4 wird NICHT
 * mit erfundenen Ansichten aufgefüllt.
 *
 * @param {Object} evidence Ergebnis von summarizeEvidence
 * @param {Object} opts { maxVariants }
 * @returns {{plan: Array, skipped: Array}}
 */
function planFaithfulVariants(evidence, opts = {}) {
  // 0 muss 0 bedeuten. Vorher lieferte `maxVariants: 0` vier Varianten, weil die
  // Null in den Default fiel.
  const maxVariants = Number.isInteger(opts.maxVariants) && opts.maxVariants >= 0 ? opts.maxVariants : 4;
  // Reihenfolge der Nützlichkeit für ein Angebot: Hauptbild zuerst.
  const ORDER = ['front', 'side', 'back', 'top', 'detail', 'label', 'bottom'];

  // Nur diese Ansichten werden gemeldet, wenn ein Foto fehlt. Alle sieben zu
  // melden ergaebe bei EINEM vorhandenen Foto sechs Zeilen Rauschen — der
  // Bediener soll die Ansichten sehen, die ein Angebot wirklich braucht, nicht
  // eine Mangelliste. Draufsicht, Unteransicht, Detail und Etikett sind Kuer:
  // sie werden aufbereitet, wenn sie da sind, aber nie angemahnt.
  const GEMELDET_WENN_FEHLEND = new Set(['front', 'back', 'side']);

  const plan = [];
  const skipped = [];
  // Dieselbe Vorlage darf NIE zwei Ausgaben speisen — sonst entstuenden zwei
  // identische Bilder, womoeglich mit verschiedenen Etiketten.
  const belegteQuellen = new Set();
  // Wie oft eine Ansicht schon vergeben wurde: das zweite Frontfoto heisst
  // "Vorderansicht (2)" und bekommt einen eigenen Variantennamen, damit die
  // GCS-Adressen nicht kollidieren.
  const zaehler = {};

  // Vorhandene Ansichten in Nutzen-Reihenfolge, danach alles Unbekannte.
  const vorhanden = ORDER.filter((v) => evidence?.byViewpoint?.[v]?.length);
  for (const key of Object.keys(evidence?.byViewpoint || {})) {
    if (!vorhanden.includes(key)) vorhanden.push(key);
  }

  // Fehlende Pflicht-Ansichten einmalig melden.
  for (const viewpoint of ORDER) {
    if (GEMELDET_WENN_FEHLEND.has(viewpoint) && !evidence?.byViewpoint?.[viewpoint]?.length) {
      skipped.push({
        viewpoint,
        label: VIEWPOINT_LABELS_DE[viewpoint] || viewpoint,
        reason: 'kein_foto',
      });
    }
  }

  // RUNDEN: erst je Ansicht das beste Foto, dann die naechstbesten.
  let ungenutzt = 0;
  let runde = 0;
  let nachschub = true;
  while (nachschub) {
    nachschub = false;
    for (const viewpoint of vorhanden) {
      const kandidaten = evidence.byViewpoint[viewpoint];
      const quelle = kandidaten.find((c) => !belegteQuellen.has(c.index));
      if (!quelle) continue;
      nachschub = true;

      if (plan.length >= maxVariants) {
        ungenutzt += 1;
        belegteQuellen.add(quelle.index);
        continue;
      }

      belegteQuellen.add(quelle.index);
      zaehler[viewpoint] = (zaehler[viewpoint] || 0) + 1;
      const n = zaehler[viewpoint];
      const basis = VIEWPOINT_LABELS_DE[viewpoint] || viewpoint;
      plan.push({
        viewpoint,
        label: n === 1 ? basis : `${basis} (${n})`,
        sourceIndex: quelle.index,
        confidence: quelle.confidence,
        variant: n === 1 ? `studio_${viewpoint}` : `studio_${viewpoint}_${n}`,
      });
    }
    runde += 1;
    // Schutz gegen eine Endlosschleife, falls Kandidatenlisten unerwartet wachsen.
    if (runde > 50) break;
  }

  if (ungenutzt > 0) {
    skipped.push({
      viewpoint: 'weitere_fotos',
      label: `${ungenutzt} weitere${ungenutzt === 1 ? 's' : ''} Foto${ungenutzt === 1 ? '' : 's'}`,
      reason: 'kontingent_erschoepft',
    });
  }

  return { plan, skipped };
}

module.exports = {
  VIEWPOINTS,
  VIEWPOINT_LABELS_DE,
  classifyViewpointParts,
  summarizeEvidence,
  planFaithfulVariants,
  minViewpointConfidence,
  _internal: { CLASSIFY_SCHEMA, PROMPT },
};
