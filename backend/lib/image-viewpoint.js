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
  // Produkt IN BENUTZUNG bzw. in einer Wohn-/Nutzungsumgebung (Lifestyle).
  // Eigene Klasse seit 2026-09-10: ohne sie galt ein Szenenfoto als normale
  // Produktansicht, wurde zur BESTEN Vorlage und speiste damit sowohl die
  // abgeleiteten Studio-Ansichten (Artikel schraeg, halb verdeckt, Bedienfeld
  // unlesbar -> das Modell erfindet es) als auch die "neue" Anwendungsszene,
  // die dadurch eine Kopie der vorhandenen wurde. Beides gemessen am
  // Heimtrainer Christopeit AL1000 (Produkt ddf4532e).
  'anwendung',
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
  anwendung: 'In Benutzung',
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
          verpackungsreste: {
            type: 'string',
            enum: ['keine', 'folie', 'unklar'],
            description:
              'BEOBACHTUNG, kein Urteil: klebt am PRODUKT SELBST noch Verpackungsmaterial? "folie" = Klarsichtfolie, Luftpolsterfolie, Schrumpffolie, Tüte, Kantenschutz aus Schaum oder Klebeband ist am Artikel zu sehen. "keine" = der Artikel ist ausgepackt. "unklar" = nicht erkennbar.',
          },
          note: { type: 'string', description: 'Kurze Begründung, deutsch, maximal ein Satz.' },
        },
        required: ['index', 'viewpoint', 'shows_product', 'usable_as_reference', 'confidence'],
      },
    },
    same_product_throughout: {
      type: 'boolean',
      description: 'false wenn die Bilder erkennbar verschiedene Artikel zeigen.',
    },
    produkt: {
      type: 'object',
      description: 'Was ist der Artikel und wie wird er benutzt — abgeleitet AUS DEN FOTOS.',
      properties: {
        was_es_ist: { type: 'string', description: 'Kurze sachliche Benennung auf ENGLISCH, z. B. "non-slip bathtub mat made of soft plastic with suction cups".' },
        material: { type: 'string', description: 'Sichtbares Hauptmaterial, ENGLISCH.' },
        wo_benutzt: { type: 'string', description: 'Der reale Ort, an dem der Artikel benutzt wird, ENGLISCH. z. B. "inside a bathtub or shower tray".' },
        wie_benutzt: { type: 'string', description: 'Wie ein Mensch ihn konkret benutzt, ENGLISCH. z. B. "laid flat on the tub floor, a person stands barefoot on it".' },
        wer_benutzt: { type: 'string', description: 'Wer ihn benutzt, ENGLISCH. z. B. "an adult, often an elderly person".' },
        schluesselbereich: { type: 'string', description: 'Der Bereich, den ein Kaeufer aus der Naehe sehen will, ENGLISCH. z. B. "the suction cups on the underside".' },
        szene_a: { type: 'string', description: 'KONKRETE Szene fuer ein Anwendungsfoto, ENGLISCH, ein Satz. Nah am Artikel, zeigt die Benutzung.' },
        szene_b: { type: 'string', description: 'ZWEITE, deutlich andere Szene, ENGLISCH, ein Satz. Weiter weg, zeigt die Umgebung.' },
        lifestyle_sinnvoll: { type: 'boolean', description: 'false bei Artikeln, die man nicht sinnvoll in Benutzung zeigen kann (reine Ersatzteile, Rohmaterial).' },
      },
      required: ['was_es_ist', 'wo_benutzt', 'wie_benutzt', 'schluesselbereich', 'szene_a', 'szene_b', 'lifestyle_sinnvoll'],
    },
  },
  required: ['images', 'same_product_throughout', 'produkt'],
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
  '- "anwendung" ist ein Foto, auf dem der Artikel BENUTZT wird oder in einer',
  '  Wohn-/Arbeits-/Aussenumgebung steht: ein Mensch bedient ihn, er steht in einem',
  '  eingerichteten Raum, auf einem Balkon, in einer Werkstatt. Das gilt AUCH DANN,',
  '  wenn der Artikel darauf gut zu sehen ist. Unterscheidungsfrage: wurde das Foto',
  '  vor neutralem Studiohintergrund gemacht (dann front/side/back/…) oder in einer',
  '  echten Umgebung (dann "anwendung")?',
  '- "verpackungsreste": sieh am ARTIKEL selbst nach, nicht auf den Hintergrund.',
  '  Ist noch Klarsichtfolie, Luftpolsterfolie, Schrumpffolie, eine Tüte, ein',
  '  Schaumstoff-Kantenschutz oder Klebeband am Artikel? Dann "folie". Ist der',
  '  Artikel ausgepackt, dann "keine". Ein Foto, das nur den geschlossenen Karton',
  '  zeigt, ist "packaging" — dort ist die Frage nach Verpackungsresten "unklar".',
  '- "usable_as_reference" ist nur dann true, wenn Form und Farbe des Artikels klar erkennbar',
  '  sind: nicht unscharf, nicht zu dunkel, nicht extrem angeschnitten.',
  '- Setze "confidence" ehrlich niedrig, wenn du dir nicht sicher bist. Eine niedrige',
  '  Sicherheit ist brauchbar, eine falsche Zuordnung nicht.',
  '',
  'ZWEITE AUFGABE — beschreibe den ARTIKEL und seine BENUTZUNG (Feld "produkt").',
  'Diese Angaben steuern spaeter die Bilderzeugung, deshalb muessen sie AUS DEN FOTOS',
  'kommen und konkret sein:',
  '- "was_es_ist": benenne den Artikel so, wie ein Fotograf ihn beschreiben wuerde.',
  '- "schluesselbereich": der eine Bereich, den ein Kaeufer aus der Naehe sehen will',
  '  (Saugnaepfe, Anschluss, Verschluss, Gewinde, Bedienfeld …).',
  '- "szene_a" und "szene_b": zwei DEUTLICH VERSCHIEDENE Anwendungsszenen. szene_a nah',
  '  am Artikel waehrend der Benutzung, szene_b weiter weg mit der Umgebung. Nenne den',
  '  Ort, die Tageszeit/Lichtstimmung und was der Mensch tut. Keine Marken, keine Schrift.',
  '- Erkennst du den Artikel nicht sicher, beschreibe NUR, was du siehst, und setze',
  '  "lifestyle_sinnvoll" auf false. Eine erfundene Benutzung ist schlimmer als keine.',
  '',
  'Alle Felder unter "produkt" auf ENGLISCH — sie gehen unveraendert in einen Bild-Prompt.',
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
        // Nur der ausdrueckliche Befund 'folie' sperrt. Fehlt das Feld (aeltere
        // Antwort, Modellwechsel), verhaelt sich alles wie vorher.
        verpackungsreste: row?.verpackungsreste === 'folie' ? 'folie' : (row?.verpackungsreste === 'keine' ? 'keine' : 'unklar'),
        note: typeof row?.note === 'string' ? row.note.slice(0, 200) : '',
      });
    }
    if (!views.length) return null;

    return {
      views,
      sameProductThroughout: parsed.same_product_throughout !== false,
      produkt: normalisiereProdukt(parsed.produkt),
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
  // `klassifiziert` unterscheidet ZWEI grundverschiedene Lagen, die vorher
  // gleich aussahen: (a) die Erkennung ist AUSGEFALLEN — dann darf sie den
  // Knopf nicht totlegen, es gilt fail-open auf die gewaehlte Vorlage; (b) die
  // Erkennung LIEF und hat kein brauchbares Foto gefunden — dann ist belegt,
  // dass es nur Kartons/Folie/Szenen gibt, und es wird fail-closed nichts
  // abgeleitet.
  const empty = {
    byViewpoint: {}, belegt: [], referenceIndexes: [], ankerIndexes: [],
    vorlageIndexes: [], anwendungIndexes: [], klassifiziert: false,
  };
  if (!classification?.views?.length) return empty;

  const minConf = minViewpointConfidence();
  const byViewpoint = {};
  const referenceIndexes = [];
  // Fotos, die als IDENTITAETSANKER an das Bildmodell gehen duerfen. Bewusst
  // eine EIGENE Liste (2026-09-10): bis dahin bekam der Render-Weg schlicht
  // ALLE geladenen Bilder als Anker, ungefiltert vom Urteil dieser Stelle.
  // Gemessen am Heimtrainer Christopeit AL1000: unter den Ankern waren Fotos
  // des KARTONS, auf dem ein kleines gruenes LCD mit "43.2" aufgedruckt ist —
  // genau dieses Display malte das Modell dem Artikel an, und die
  // Klarsichtfolie vom selben Foto gleich mit dazu.
  const ankerIndexes = [];
  // Vorhandene Anwendungs-/Lifestyle-Fotos. Sie sind KEINE Studio-Vorlage und
  // kein Anker, aber sie beantworten die Frage, ob ueberhaupt noch eine Szene
  // erzeugt werden muss.
  const anwendungIndexes = [];

  for (const view of classification.views) {
    if (!view.showsProduct) continue;
    if (view.viewpoint === 'anwendung') {
      if (view.confidence >= minConf) anwendungIndexes.push(view.index);
      // NICHT als Referenz, nicht als Anker, nicht als Vorlage: auf einer Szene
      // ist der Artikel schraeg, angeschnitten und halb von einem Menschen
      // verdeckt. Als Vorlage einer Studio-Ansicht zwingt sie das Modell zum
      // Erfinden; als Anker traegt sie einen fremden Raum in den Packshot.
      continue;
    }
    // Verpackungsmaterial AM ARTIKEL schliesst das Foto komplett aus. Ein
    // Angebotsbild mit Folie ist unbrauchbar, und als Anker faerbt die Folie
    // auf jede erzeugte Ansicht ab (gemessen 2026-09-10).
    if (view.verpackungsreste === 'folie') continue;
    if (view.usableAsReference) referenceIndexes.push(view);
    if (view.confidence < minConf) continue;
    if (view.viewpoint === 'unclear' || view.viewpoint === 'packaging') continue;
    if (view.usableAsReference) ankerIndexes.push(view);
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

  // `referenceIndexes` war bis 2026-09-10 UNSORTIERT — es stand schlicht die
  // Reihenfolge der Bilder am Produkt drin. Der Aufrufer nennt das erste
  // Element `besteVorlage`, was damit eine Behauptung ohne Grundlage war.
  // Jetzt wird nach derselben Kennzahl sortiert, die auch innerhalb einer
  // Ansicht gilt: sicher, vollstaendig, brauchbar.
  const guete = (v) => v.confidence + (v.fullyVisible ? 0.5 : 0) + (v.usableAsReference ? 0.5 : 0);
  referenceIndexes.sort((a, b) => guete(b) - guete(a));
  ankerIndexes.sort((a, b) => guete(b) - guete(a));

  return {
    byViewpoint,
    belegt: Object.keys(byViewpoint),
    referenceIndexes: referenceIndexes.map((v) => v.index),
    ankerIndexes: ankerIndexes.map((v) => v.index),
    // VORLAGEN fuer ABGELEITETE Ansichten und Szenen. Bewusst eine dritte Liste:
    // `referenceIndexes` darf weiterhin auch ein unsicheres oder ein
    // Verpackungsfoto fuehren — als IDENTITAETSANKER taugt es, und ein Test
    // haelt das ausdruecklich fest. Als VORLAGE taugt es nicht: aus einem
    // Kartonfoto laesst sich keine Produktansicht ableiten, nur erfinden.
    // Gemessen: bei einem Produkt mit ausschliesslich Karton-, Folien- und
    // Szenenfotos war `referenceIndexes[0]` das KARTONFOTO, und der Plan baute
    // daraus vier Studio-Ansichten und eine Szene.
    vorlageIndexes: ankerIndexes.map((v) => v.index),
    klassifiziert: true,
    anwendungIndexes,
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

// ---------------------------------------------------------------------------
// Galerie-Plan (Betreiber-Vorgabe 2026-09-10)
// ---------------------------------------------------------------------------

/**
 * Die feste Studio-Serie. Vier Ansichten, die zusammen ein Angebot tragen —
 * unabhängig davon, welche Seiten fotografiert wurden.
 *
 * BEWUSSTE KEHRTWENDE gegenüber dem Stand vom 02.09.: dort wurde NUR aufbereitet,
 * was belegt war. Der Betreiber hat das am 10.09. ausdrücklich widerrufen und
 * mindestens vier Studio-Fotos plus zwei Anwendungsszenen verlangt, mit einem
 * konkreten Beispiel. Die erzeugten Bilder sind ZUSATZbilder für die Galerie;
 * das Hauptbild bleibt ein echtes Foto (`hauptbildBleibtEcht`).
 */
const STUDIO_SERIE = Object.freeze([
  { key: 'hero', variant: 'studio_hero', label: 'Hero 3/4', winkel: 'three-quarter hero view from slightly above' },
  { key: 'front', variant: 'studio_front', label: 'Frontansicht', winkel: 'straight-on front view at eye level' },
  { key: 'top', variant: 'studio_top', label: 'Draufsicht', winkel: 'top-down view looking straight down' },
  { key: 'detail', variant: 'studio_detail', label: 'Detailaufnahme', winkel: 'tight macro close-up' },
  { key: 'side', variant: 'studio_side', label: 'Seitenansicht', winkel: 'side profile view' },
  { key: 'back', variant: 'studio_back', label: 'Rückansicht', winkel: 'rear view' },
]);

const LIFESTYLE_SERIE = Object.freeze([
  { key: 'inuse', variant: 'lifestyle_inuse', label: 'In Benutzung (nah)', szeneFeld: 'szeneA' },
  { key: 'scene', variant: 'lifestyle_scene', label: 'In Benutzung (Umgebung)', szeneFeld: 'szeneB' },
]);

function text(value, max = 300) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
}

/** Normalisiert den Produkt-Block der Vision-Antwort. Wirft nie. */
function normalisiereProdukt(roh) {
  if (!roh || typeof roh !== 'object') return null;
  const p = {
    wasEsIst: text(roh.was_es_ist),
    material: text(roh.material, 120),
    woBenutzt: text(roh.wo_benutzt),
    wieBenutzt: text(roh.wie_benutzt),
    werBenutzt: text(roh.wer_benutzt, 120),
    schluesselbereich: text(roh.schluesselbereich, 200),
    szeneA: text(roh.szene_a, 400),
    szeneB: text(roh.szene_b, 400),
    lifestyleSinnvoll: roh.lifestyle_sinnvoll === true,
  };
  // Ohne Benennung ist der Block wertlos — dann lieber gar keiner, als einen
  // leeren Satz in den Bild-Prompt zu schreiben.
  return p.wasEsIst ? p : null;
}

/**
 * Plant die komplette Angebotsgalerie: mindestens `studioAnzahl` Studio-Ansichten
 * plus bis zu zwei Anwendungsszenen.
 *
 * REIHENFOLGE IST ABSICHT: die Ansichten, für die ein ECHTES Foto vorliegt,
 * kommen zuerst und bekommen dieses Foto als Vorlage (`quelleIstEcht:true`).
 * Erst danach wird auf die übrigen Kanon-Ansichten aufgefüllt, die das Modell
 * aus dem vorhandenen Material ableiten muss. So ist die Serie vollständig, und
 * gleichzeitig sitzt jede Ansicht so nah wie möglich an einer echten Aufnahme.
 *
 * @param {Object} evidence Ergebnis von summarizeEvidence
 * @param {Object} opts { studioAnzahl = 4, lifestyle = true, produkt }
 * @returns {{plan: Array, skipped: Array, hauptbildBleibtEcht: boolean}}
 */
function planGalleryVariants(evidence, opts = {}) {
  /**
   * NUR-PIXELTREU-BETRIEB (seit 2026-09-10, additiv, Voreinstellung aus).
   *
   * Plant AUSSCHLIESSLICH Ansichten, fuer die ein echtes Foto derselben Seite
   * vorliegt — keine abgeleiteten Ansichten, keine Anwendungsszenen. Damit
   * kostet ein Produkt nur seine Masken (0,034 $ je Ansicht) statt eines vollen
   * Laufs, und jedes Ergebnis besteht aus ORIGINALPIXELN.
   *
   * Wofuer: die Massen-Bildbereinigung, die fremde Bild-Adressen durch eigene
   * Aufnahmen ersetzt. Dort waere eine ABGELEITETE Ansicht sinnlos — sie soll ja
   * gerade ein vorhandenes Foto ersetzen, nicht eines erfinden.
   *
   * Das ist NICHT der Galerie-Knopf. Dessen Vorgabe "mindestens 4 Studio-Fotos"
   * (Betreiber 2026-09-10) bleibt unberuehrt; dieser Betrieb wird nur von einem
   * anderen Aufrufer ausdruecklich angefordert.
   */
  const nurPixeltreu = opts.nurPixeltreu === true;
  const studioAnzahl = nurPixeltreu
    ? STUDIO_SERIE.length
    : Number.isInteger(opts.studioAnzahl) && opts.studioAnzahl >= 0
      ? opts.studioAnzahl
      : 4;
  const lifestyleGewuenscht = !nurPixeltreu && opts.lifestyle !== false;
  const produkt = opts.produkt || null;

  const plan = [];
  const skipped = [];
  const belegteQuellen = new Set();
  const vergebeneKeys = new Set();

  // Welche Kanon-Ansicht deckt welche fotografierte Ansicht ab.
  const AUS_FOTO = { front: 'front', side: 'side', back: 'back', top: 'top', detail: 'detail' };

  // --- Runde 1: Ansichten MIT echtem Foto -----------------------------------
  for (const eintrag of STUDIO_SERIE) {
    if (plan.length >= studioAnzahl) break;
    const fotoAnsicht = Object.keys(AUS_FOTO).find((k) => AUS_FOTO[k] === eintrag.key);
    const kandidaten = fotoAnsicht ? evidence?.byViewpoint?.[fotoAnsicht] : null;
    const quelle = kandidaten?.find((c) => !belegteQuellen.has(c.index));
    if (!quelle) continue;
    belegteQuellen.add(quelle.index);
    vergebeneKeys.add(eintrag.key);
    plan.push({
      ...eintrag,
      art: 'studio',
      sourceIndex: quelle.index,
      quelleIstEcht: true,
      viewpoint: eintrag.key,
      confidence: quelle.confidence,
    });
  }

  // --- Runde 2: restliche Kanon-Ansichten auffüllen --------------------------
  // KEIN `?? 0` MEHR (2026-09-10). Der Rueckfall auf Bild 0 war der Weg, auf dem
  // ein KARTONFOTO Vorlage von vier Studio-Ansichten und einer Anwendungsszene
  // wurde — nachgestellt und gemessen. Aus einem Karton laesst sich keine
  // Produktansicht ableiten, nur erfinden.
  // Fail-OPEN bei ausgefallener Erkennung (Bild 0 ist die vom Bediener
  // gewaehlte Vorlage), fail-CLOSED wenn die Erkennung lief und nichts
  // Brauchbares fand.
  const gelaufen = evidence?.klassifiziert === true;
  const besteVorlage = gelaufen ? evidence?.vorlageIndexes?.[0] : 0;
  const ohneVorlage = besteVorlage === undefined;
  if (ohneVorlage && !nurPixeltreu) {
    skipped.push({
      viewpoint: 'studio',
      label: 'Abgeleitete Studio-Ansichten',
      reason: 'keine_brauchbare_vorlage',
    });
  }
  // Im Nur-Pixeltreu-Betrieb ist ein leerer Plan die ehrliche Antwort "es gibt
  // kein brauchbares eigenes Foto" — und genau die braucht der Aufrufer.
  if (nurPixeltreu && plan.length === 0) {
    skipped.push({
      viewpoint: 'studio',
      label: 'Alle Ansichten',
      reason: 'keine_brauchbare_vorlage',
    });
  }
  for (const eintrag of STUDIO_SERIE) {
    // Im Nur-Pixeltreu-Betrieb wird GAR NICHTS abgeleitet.
    if (nurPixeltreu) break;
    if (ohneVorlage) break;
    if (plan.length >= studioAnzahl) break;
    if (vergebeneKeys.has(eintrag.key)) continue;
    // MAKROAUFNAHMEN WERDEN NIE ABGELEITET (seit 2026-09-10).
    // Eine Nahaufnahme ist die gefaehrlichste Kategorie: bei einer Totalen sind
    // erfundene Details wenige Pixel gross, bei einer Makroaufnahme fuellen sie
    // das Bild — und der Schluesselbereich eines Artikels ist typischerweise
    // genau das, was ein Modell nicht kann: Bedienfeld, Display, Typenschild,
    // Kleindruck. Gemessen am Heimtrainer: das erfundene Bedienfeld war die
    // Haupt-Beschwerde. Liegt ein ECHTES Foto der Stelle vor, entsteht die
    // Detailansicht in Runde 1 pixeltreu — genau so soll es sein.
    if (eintrag.key === 'detail') {
      skipped.push({
        viewpoint: 'detail',
        label: eintrag.label,
        reason: 'kein_foto_makro_wird_nicht_erfunden',
      });
      vergebeneKeys.add(eintrag.key);
      continue;
    }
    vergebeneKeys.add(eintrag.key);
    plan.push({
      ...eintrag,
      art: 'studio',
      sourceIndex: besteVorlage,
      quelleIstEcht: false,
      viewpoint: eintrag.key,
      confidence: 0,
    });
  }

  // Ohne Vorlage ist der Grund bereits gemeldet — "Kanon erschoepft" waere
  // daneben nur Rauschen und wuerde die eigentliche Ursache verdecken.
  if (!nurPixeltreu && !ohneVorlage && plan.length < studioAnzahl) {
    skipped.push({
      viewpoint: 'studio',
      label: `${studioAnzahl - plan.length} weitere Studio-Ansichten`,
      reason: 'kanon_erschoepft',
    });
  }

  // --- Anwendungsszenen ------------------------------------------------------
  if (!lifestyleGewuenscht) {
    // Nicht angefragt — kein Hinweis, das wäre Rauschen.
  } else if (ohneVorlage) {
    skipped.push({
      viewpoint: 'lifestyle',
      label: 'Anwendungsszenen',
      reason: 'keine_brauchbare_vorlage',
    });
  } else if (!produkt || !produkt.lifestyleSinnvoll) {
    skipped.push({
      viewpoint: 'lifestyle',
      label: 'Anwendungsszenen',
      reason: produkt ? 'nicht_sinnvoll_darstellbar' : 'produkt_nicht_erkannt',
    });
  } else {
    // SCHON VORHANDENE SZENEN ZAEHLEN (seit 2026-09-10). Der Betreiber bekam
    // eine erzeugte Szene, die eine Beinah-Kopie eines bereits vorhandenen
    // Web-Lifestyle-Fotos war — sie hat Geld gekostet und nichts hinzugefuegt.
    // Zwei echte Szenen decken die Galerie ab; bei einer wird noch EINE
    // ergaenzt (die zweite, deutlich andere), bei zweien gar keine.
    const vorhandeneSzenen = Array.isArray(evidence?.anwendungIndexes) ? evidence.anwendungIndexes.length : 0;
    const nochOffen = Math.max(0, LIFESTYLE_SERIE.length - vorhandeneSzenen);
    if (nochOffen < LIFESTYLE_SERIE.length) {
      skipped.push({
        viewpoint: 'lifestyle',
        label: `${LIFESTYLE_SERIE.length - nochOffen} Anwendungsszene(n)`,
        reason: `bereits_vorhanden(${vorhandeneSzenen} echte)`,
      });
    }
    // Von hinten nehmen: liegt schon eine Szene vor, entsteht die WEITERE
    // (szene_b, mit Umgebung) statt einer zweiten Nahaufnahme.
    const zuErzeugen = LIFESTYLE_SERIE.slice(LIFESTYLE_SERIE.length - nochOffen);
    for (const eintrag of zuErzeugen) {
      const szene = produkt[eintrag.szeneFeld];
      if (!szene) {
        skipped.push({ viewpoint: eintrag.key, label: eintrag.label, reason: 'keine_szene_beschrieben' });
        continue;
      }
      plan.push({
        ...eintrag,
        art: 'lifestyle',
        szene,
        sourceIndex: besteVorlage,
        quelleIstEcht: false,
        viewpoint: eintrag.key,
        confidence: 0,
      });
    }
  }

  return { plan, skipped, hauptbildBleibtEcht: true };
}

module.exports = {
  VIEWPOINTS,
  VIEWPOINT_LABELS_DE,
  STUDIO_SERIE,
  LIFESTYLE_SERIE,
  planGalleryVariants,
  normalisiereProdukt,
  classifyViewpointParts,
  summarizeEvidence,
  planFaithfulVariants,
  minViewpointConfidence,
  _internal: { CLASSIFY_SCHEMA, PROMPT },
};
