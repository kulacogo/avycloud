/* eslint-disable no-console */
'use strict';

/**
 * image-result-check.js — Prüfung erzeugter Produktbilder VOR dem Speichern.
 *
 * `services/image-generation.js` prüfte bis 2026-09-02 GAR NICHTS: was das Modell
 * zurückgab, wurde hochgeladen und an die Galerie gehängt. `services/image-studio.js`
 * prüfte nebenan schon seit Langem (dekodierbar, Mindestkante, heller oberer Rand) —
 * die beiden Pfade waren nur nie zusammengeführt. Diese Datei ist die gemeinsame
 * Prüfung, damit die Regel an EINER Stelle steht.
 *
 * ZWEI STUFEN, bewusst getrennt:
 *   1. DETERMINISTISCH (entscheidet) — dekodierbar, Grösse, Hintergrund, nicht leer.
 *      Reproduzierbar, kostenlos, keine Modellmeinung.
 *   2. VISION-URTEIL — Identität, Zustand, Material, Farbe, Text und Bildbelege.
 *      Sicher erkannte Veränderungen werden verworfen. Unsicherheit/Ausfälle
 *      bleiben sichtbar als Warnung, niemals als geprüfter Erfolg.
 *
 * EHRLICHE GRENZE, die dem Bediener gesagt werden muss: eine Ähnlichkeitsprüfung
 * vergleicht immer nur mit den EINGABEBILDERN. Sie kann eine erfundene Fläche, die
 * gut zum Produkt passt, gar nicht beanstanden. Sie schützt vor "falsches Produkt",
 * nicht vor "erfundenes Detail". Gegen Letzteres hilft ausschliesslich die
 * Beleg-Bilanz in `lib/image-viewpoint.js`.
 */

const sharp = require('sharp');

const MIN_EDGE_PX = parseInt(process.env.GENERATED_IMAGE_MIN_EDGE || '512', 10);

function minBackgroundBrightness() {
  const raw = parseInt(process.env.STUDIO_MIN_BG_BRIGHTNESS || '200', 10);
  return Number.isFinite(raw) ? raw : 200;
}

/**
 * Ein Bild, dessen Pixel sich kaum unterscheiden, ist eine leere Fläche — das
 * kommt vor, wenn das Modell abbricht oder eine reine Hintergrundfläche liefert.
 * Ohne diese Prüfung landet ein weisses Quadrat als "Produktfoto" im Angebot.
 */
const MIN_GLOBAL_STDDEV = parseFloat(process.env.GENERATED_IMAGE_MIN_STDDEV || '6');

/**
 * Beurteilt, ob der HINTERGRUND hell ist — über die vier ECKEN, nicht über einen
 * Randstreifen.
 *
 * WARUM (Vorfall 2026-09-03, Studio-Foto eines Moto-Guzzi-Sitzes): die alte
 * Prüfung mittelte den oberen Randstreifen über die VOLLE BREITE. Reicht das
 * Produkt in den oberen Bildrand — bei einem formatfüllenden Packshot der
 * Normalfall — sinkt der Mittelwert unter die Schwelle und ein völlig korrektes
 * Studio-Foto wird verworfen. Gemessen in Produktion: 5 von 5 Läufen scheiterten
 * mit `background_too_dark(149…197)` bei Schwelle 200, über DREI verschiedene
 * Modelle hinweg. Es landete also jedes Mal der hässliche Rückfall in der
 * Galerie, und niemand konnte sehen, dass die Modelle sauber geliefert hatten.
 *
 * Ecken sind in einem Packshot weit zuverlässiger Hintergrund als ein Streifen.
 * Akzeptiert wird, wenn MINDESTENS ZWEI der vier Ecken hell sind — so darf das
 * Produkt zwei Ecken berühren, ohne das Bild zu verlieren.
 *
 * @returns {Promise<{ok:boolean, corners:number[], bright:number}>}
 */
async function assessBackgroundBrightness(buffer, schwelle) {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  const patch = Math.max(8, Math.round(Math.min(width, height) * 0.08));

  const ecken = [
    { left: 0, top: 0 },
    { left: width - patch, top: 0 },
    { left: 0, top: height - patch },
    { left: width - patch, top: height - patch },
  ];

  const werte = [];
  for (const ecke of ecken) {
    try {
      // ZWINGEND ueber toBuffer(): `sharp(x).extract(...).stats()` IGNORIERT den
      // Zuschnitt und misst das GANZE Bild (sharp 0.33.5, an dieser Stelle
      // nachgewiesen: obere Haelfte reinweiss, untere schwarz -> 128 statt 255).
      // Genau daran scheiterte das Studio-Foto: die Pruefung "heller oberer Rand"
      // hat nie den Rand gemessen, sondern die Durchschnittshelligkeit des ganzen
      // Bildes. Ein dunkles Produkt zog sie unter die Schwelle, und JEDES fertige
      // Studio-Foto wurde zugunsten des haesslichen Rueckfalls verworfen.
      const zuschnitt = await sharp(buffer)
        .extract({ left: Math.max(0, ecke.left), top: Math.max(0, ecke.top), width: patch, height: patch })
        .toBuffer();
      const stats = await sharp(zuschnitt).stats();
      const rgb = stats.channels.slice(0, 3);
      werte.push(rgb.reduce((sum, c) => sum + c.mean, 0) / (rgb.length || 1));
    } catch {
      // Eine nicht lesbare Ecke zaehlt nicht mit — sie darf das Bild nicht kippen.
    }
  }

  if (!werte.length) return { ok: true, corners: [], bright: 0 };
  const hell = werte.filter((w) => w >= schwelle).length;
  return { ok: hell >= 2, corners: werte.map((w) => Math.round(w)), bright: hell };
}

/**
 * Deterministische Prüfung. Wirft nie.
 *
 * @param {Buffer} buffer
 * @param {Object} opts { requireBrightBackground = true, minEdge }
 * @returns {Promise<{ok:boolean, reason?:string, width?:number, height?:number}>}
 */
async function validateGeneratedImage(buffer, opts = {}) {
  const requireBrightBackground = opts.requireBrightBackground !== false;
  const minEdge = Number.isInteger(opts.minEdge) ? opts.minEdge : MIN_EDGE_PX;

  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { ok: false, reason: 'leer' };
  }

  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;

    if (!width || !height) return { ok: false, reason: 'keine_masse' };
    if (Math.min(width, height) < minEdge) {
      return { ok: false, reason: `zu_klein(${width}x${height})` };
    }

    const stats = await sharp(buffer).stats();
    const rgb = stats.channels.slice(0, 3);
    const meanStdDev = rgb.reduce((sum, c) => sum + (c.stdev || 0), 0) / (rgb.length || 1);
    if (meanStdDev < MIN_GLOBAL_STDDEV) {
      return { ok: false, reason: `leere_flaeche(stdabw=${meanStdDev.toFixed(1)})` };
    }

    if (requireBrightBackground) {
      const hg = await assessBackgroundBrightness(buffer, minBackgroundBrightness());
      if (!hg.ok) {
        return { ok: false, reason: `hintergrund_zu_dunkel(Ecken ${hg.corners.join('/')})` };
      }
    }

    return { ok: true, width, height };
  } catch (err) {
    return { ok: false, reason: `nicht_dekodierbar: ${err.message}` };
  }
}

/**
 * Narrow deterministic guard for globally washed-out dark studio products.
 * It is not a general colour/identity proof. White studio/background pixels are
 * excluded; both the lower quartile and median must have shifted substantially.
 * Matching any supplied view is enough, so a genuinely brighter side is allowed.
 * Lifestyle surroundings make this measurement unreliable and are excluded.
 */
async function validateDarkMaterialColor(referenceBuffers, candidateBuffer) {
  async function profile(buffer) {
    const { data, info } = await sharp(buffer).rotate().resize(128, 128, { fit: 'inside' })
      .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const values = [];
    for (let i = 0; i < data.length; i += info.channels) {
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (brightness < 170) values.push(brightness);
    }
    if (values.length < info.width * info.height * 0.1) return null;
    values.sort((a, b) => a - b);
    return { q25: values[Math.floor((values.length - 1) * 0.25)], median: values[Math.floor((values.length - 1) * 0.5)],
      q75: values[Math.floor((values.length - 1) * 0.75)] };
  }
  try {
    const references = await Promise.all(referenceBuffers.map(profile));
    if (!references.length || references.some(p => !p || p.median > 45 || p.q75 > 70)) {
      return { ok: true, checked: false };
    }
    const result = await profile(candidateBuffer);
    if (!result) return { ok: false, checked: true, reason: 'Dunkles Produktmaterial fehlt im Ergebnis' };
    const drift = references.every(p => result.median - p.median >= 15 &&
      result.median / Math.max(1, p.median) >= 1.4 && result.q25 - p.q25 >= 12);
    return { ok: !drift, checked: true,
      ...(drift ? { reason: 'Dunkles Produktmaterial wurde flächig aufgehellt; Farbeindruck verändert' } : {}),
      referenceMedians: references.map(p => p.median), resultMedian: result.median };
  } catch {
    return { ok: false, checked: false, reason: 'Farbvergleich konnte nicht ausgeführt werden' };
  }
}

const { RELIGHTING_REVIEW } = require('./product-photo-policy');
const STUDIO_PRESENTATION_SCHEMA = {
  studio_lighting: { type: 'boolean', description: 'Professionelle gerichtete Beleuchtung mit sichtbarer Form und Materialtiefe, keine flache, stumpfe Freistellung; keine ausgebrannten Flaechen.' },
  grounded: { type: 'boolean', description: 'Physikalisch plausibler, sichtbarer weicher Kontakt-/Bodenschatten an den Auflagepunkten. Kein schwebender Ausschnitt. Bei echter Detailaufnahme ohne Boden: true wenn die Beleuchtung natuerlich ist.' },
  composition_good: { type: 'boolean', description: 'Bewusst komponiert, passende Groesse und Raender, korrekt ausgerichtet, Hauptmotiv vollstaendig (ausser bewusstem Detailausschnitt), kein unbeabsichtigtes Kippen.' },
};
const STUDIO_PRESENTATION_REVIEW = 'Beurteile ZUSAETZLICH die fertige Werbefotografie: studio_lighting, grounded und composition_good. Ein sauber freigestellter, aber flacher, schief stehender oder schwebender Ausschnitt besteht NICHT. Verlange sichtbare weiche Bodenkontaktschatten (bei Flatlay entsprechend flach), gerichtetes weiches Licht mit Materialtiefe und bewusstes Framing. Perspektivische Verkuerzung ist kein Kippen. Kleine Korrektur des Kamerarolls ist erlaubt, Geometrieveraenderung nicht. Nenne konkrete Gestaltungsmaengel in problems. Bewerte die Ausgabe absolut, nicht nur als Verbesserung des Originals.';
const IDENTITY_SCHEMA = {
  type: 'object',
  properties: {
    visual_comparison: { type: 'string', description: 'ZUERST unabhaengig beschreiben: Farbe grosser Materialflaechen, Bauform und Anzahl/Position von Schlaufen, Gurten, Haken und Etiketten in Original UND Ergebnis. Dann konkrete Unterschiede. Nicht vom gleichen Logo auf gleichen Artikel schliessen.' },
    reference_color: { type: 'string', description: 'Farbeindruck des dominanten Produktmaterials im Original.' },
    result_color: { type: 'string', description: 'Farbeindruck desselben Materials im Ergebnis, ohne Annahme gleicher Farbe.' },
    problems: { type: 'array', items: { type: 'string' }, description: 'Sichtbare Abweichungen aus dem Vergleich, VOR der Entscheidung erfassen.' },
    same_item: {
      type: 'boolean',
      description: 'true nur wenn das bearbeitete Bild denselben physischen Artikel zeigt wie die Originalfotos.',
    },
    perspective_kept: {
      type: 'boolean',
      description: 'true wenn der Blickwinkel unveraendert gegenueber dem ersten Originalfoto ist.',
    },
    markings_kept: {
      type: 'boolean',
      description: 'true wenn Beschriftungen, Logos und Typenschilder erhalten und unveraendert sind.',
    },
    condition_kept: { type: 'boolean', description: 'Tatsaechlicher Zustand und sichtbare Maengel unveraendert.' },
    material_kept: { type: 'boolean', description: 'Material, Struktur und matt/glaenzend unveraendert.' },
    color_kept: { type: 'boolean', description: 'Echte Produktfarbe erhalten, Lichtkorrektur ist erlaubt.' },
    evidence_kept: { type: 'boolean', description: 'Keine Details ohne Bildbeleg erfunden.' },
    background_clean: { type: 'boolean', description: 'Sauberer neutraler Studiohintergrund ohne urspruengliche Wand, Tisch, Fugen, Horizont, Schmutz, Haende oder fremde Objekte. Bei expliziter Anwendungsszene true.' },
    confidence: { type: 'number', description: '0..1' },
  },
  required: ['visual_comparison', 'problems', 'same_item', 'perspective_kept', 'markings_kept', 'condition_kept', 'material_kept', 'color_kept', 'evidence_kept', 'background_clean', 'reference_color', 'result_color', 'confidence'],
};

/**
 * Prompt fuer die GALERIE-Aufgabe (seit 2026-09-10): das Ergebnis zeigt den
 * Artikel ABSICHTLICH aus einem anderen Blickwinkel oder in einer Anwendungs-
 * szene. Der Retusche-Prompt darunter taugt dafuer NICHT — er sagt dem Richter,
 * es haetten nur Hintergrund und Licht geaendert werden duerfen, und fragt nach
 * unveraendertem Blickwinkel. Gemessen am 10.09.: damit verwarf die Pruefung
 * 5 von 6 erzeugten Bildern, obwohl sie gut waren.
 *
 * Hier zaehlt NUR: ist es derselbe physische Artikel, und stimmen die Merkmale.
 */
const IDENTITY_PROMPT_GALERIE = [
  RELIGHTING_REVIEW,
  'Die ersten Bilder sind ORIGINALFOTOS eines Artikels.',
  'Das LETZTE Bild wurde daraus erzeugt und zeigt denselben Artikel ABSICHTLICH aus',
  'einem anderen Blickwinkel oder in einer Anwendungssituation.',
  'Ein anderer Blickwinkel, ein anderer Hintergrund und eine Umgebung sind ERWUENSCHT',
  'und KEIN Fehler.',
  '',
  'Pruefe nur diese Fragen:',
  '- Ist es derselbe physische Artikel? Achte auf Bauform, Proportionen, Farbe, Material,',
  '  Anordnung der Bauteile. Ein aehnliches Produkt derselben Art ist NICHT derselbe Artikel.',
  '- Vergleiche Anzahl, Position und Verbindung jedes sichtbaren Gurts, Hakens, Etiketts, jeder Schlaufe und Naht. Neue Perspektive erlaubt keine neuen Bauteile oder umgebauten Artikel.',
  '- Nicht fotografierte Innenflaechen duerfen keine erfundenen Taschen, Verschluesse, Netze oder Zubehoerteile enthalten. Fehlender Beleg bedeutet evidence_kept=false.',
  '- Sind Marken- und Modellbeschriftungen erhalten, wo sie sichtbar sind?',
  '  Ein neu erfundener Marken- oder Modellname ist ein schwerer Fehler.',
  '  Kleindruck, der im Original schon unlesbar war, darf unlesbar bleiben.',
  '',
  'Setze "perspective_kept" IMMER auf true — der Blickwinkel darf hier abweichen.',
  'Nenne unter "problems" nur konkrete, sichtbare Abweichungen am ARTIKEL. Erfinde keine.',
  'Antworte ausschliesslich mit dem geforderten JSON.',
].join('\n');

const IDENTITY_PROMPT = [
  RELIGHTING_REVIEW,
  'Die ersten Bilder sind ORIGINALFOTOS eines Artikels.',
  'Das LETZTE Bild ist eine bearbeitete Fassung, bei der nur Hintergrund und Beleuchtung',
  'geaendert werden durften.',
  '',
  'Pruefe streng:',
  '- Ist auf dem letzten Bild derselbe physische Artikel zu sehen? Achte auf Form, Proportionen,',
  '  Farbe, Material und jedes Detail. Ein aehnliches Produkt derselben Art ist NICHT derselbe Artikel.',
  '- Ist der Blickwinkel gegenueber dem ERSTEN Originalfoto unveraendert?',
  '- Sind alle Beschriftungen, Logos, Typenschilder und Aufdrucke noch da und unveraendert lesbar?',
  '  Entfernter oder neu erfundener Text ist ein schwerer Fehler.',
  '',
  'Nenne unter "problems" nur konkrete, sichtbare Abweichungen. Erfinde keine.',
  'Antworte ausschliesslich mit dem geforderten JSON.',
].join('\n');

function identityCheckEnabled() {
  // Nur der exakte Wert 'off' schaltet ab (Hausregel). Default an: die Pruefung
  // kostet einen billigen Vision-Call und verhindert, dass ein abgedriftetes Bild
  // unbemerkt in ein echtes Angebot wandert.
  return String(process.env.GENERATED_IMAGE_IDENTITY_CHECK || '').trim() !== 'off';
}

function minIdentityConfidence() {
  const raw = parseFloat(process.env.GENERATED_IMAGE_IDENTITY_MIN_CONFIDENCE || '0.6');
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.6;
}

/**
 * Zweitmeinung: zeigt das erzeugte Bild noch denselben Artikel?
 * WIRFT NIE. Liefert null, wenn kein Urteil möglich war — der Aufrufer behandelt
 * das als "nicht geprüft", NICHT als "in Ordnung" und NICHT als "verworfen".
 *
 * @param {Array} referenceParts inlineData-Parts der Originalfotos
 * @param {{data:string, mimeType:string}} candidate erzeugtes Bild
 * @returns {Promise<{sameItem:boolean, perspectiveKept:boolean, markingsKept:boolean,
 *                    confidence:number, problems:string[], model:string}|null>}
 */
async function judgeProductIdentity(referenceParts, candidate, opts = {}) {
  // `modus:'galerie'` fuer absichtlich neue Blickwinkel/Szenen, sonst Retusche.
  const prompt = (opts.modus === 'galerie' ? IDENTITY_PROMPT_GALERIE : IDENTITY_PROMPT) + '\n' +
    (opts.requireCleanBackground === false
      ? 'Dieses Ergebnis ist eine Anwendungsszene; die Umgebung ist erlaubt. Produktfarbe und Zustand muessen trotzdem stimmen.'
      : 'Dieses Ergebnis MUSS ein freigestelltes Studiofoto sein. Uebernommene Wand-/Tischflaechen, Fugen, Horizontlinien, Haende und Requisiten sind Fehler: background_clean=false. Ein heller Originalhintergrund ist KEINE Freistellung.') +
    '\nErstelle zuerst visual_comparison: Beschreibe Original und Ergebnis getrennt, dann ihre Unterschiede. Benenne zuerst reference_color und result_color anhand der sichtbaren Flaechen. Wenn das Produkt als andere Farbe angeboten wirken wuerde, setze color_kept=false. Im Zweifel kein positives Qualitaetsurteil.';
  if (!identityCheckEnabled()) return null;
  if (!Array.isArray(referenceParts) || !referenceParts.length) return null;
  if (!candidate?.data) return null;

  try {
    if (opts.requireCleanBackground === true) {
      const color = await validateDarkMaterialColor(
        referenceParts.slice(0, 4).map(p => Buffer.from(p.inlineData?.data || '', 'base64')),
        Buffer.from(candidate.data, 'base64'),
      );
      if (!color.ok) return { sameItem: true, colorKept: false, confidence: 1, problems: [color.reason], model: 'deterministic-dark-material' };
    }
    // Lazy require: hält die Datei in Tests billig und vermeidet einen Zyklus.
    const { getGenAIClient } = require('./gemini3-client');
    const { resolveModel } = require('./model-select');
    const model = resolveModel(
      process.env.GENERATED_IMAGE_IDENTITY_MODEL,
      'GENERATED_IMAGE_IDENTITY_MODEL',
      'gemini-2.5-flash'
    );
    const timeoutMs = parseInt(process.env.GENERATED_IMAGE_IDENTITY_TIMEOUT_MS || '30000', 10);

    const ai = opts.aiClient || (await getGenAIClient());
    const parts = [
      { text: prompt + (opts.requireStudioPresentation ? '\n' + STUDIO_PRESENTATION_REVIEW : '') },
      ...referenceParts.slice(0, 4),
      { inlineData: { data: candidate.data, mimeType: candidate.mimeType || 'image/png' } },
    ];

    let timer;
    const response = await Promise.race([
      ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseJsonSchema: opts.requireStudioPresentation ? {
            ...IDENTITY_SCHEMA,
            properties: { ...IDENTITY_SCHEMA.properties, ...STUDIO_PRESENTATION_SCHEMA },
            required: [...IDENTITY_SCHEMA.required, ...Object.keys(STUDIO_PRESENTATION_SCHEMA)],
          } : IDENTITY_SCHEMA,
        },
      }),
      new Promise((_, reject) =>
        timer = setTimeout(() => reject(new Error('identity-check timeout')), timeoutMs)
      ),
    ]).finally(() => clearTimeout(timer));

    const text = typeof response?.text === 'string' ? response.text : '';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed.same_item !== 'boolean') return null;

    const confidence = Number.isFinite(Number(parsed.confidence))
      ? Math.min(1, Math.max(0, Number(parsed.confidence)))
      : 0;

    return {
      visualComparison: typeof parsed.visual_comparison === 'string' ? parsed.visual_comparison : undefined,
      sameItem: parsed.same_item === true,
      perspectiveKept: typeof parsed.perspective_kept === 'boolean' ? parsed.perspective_kept : undefined,
      markingsKept: typeof parsed.markings_kept === 'boolean' ? parsed.markings_kept : undefined,
      conditionKept: typeof parsed.condition_kept === 'boolean' ? parsed.condition_kept : undefined,
      materialKept: typeof parsed.material_kept === 'boolean' ? parsed.material_kept : undefined,
      colorKept: typeof parsed.color_kept === 'boolean' ? parsed.color_kept : undefined,
      evidenceKept: typeof parsed.evidence_kept === 'boolean' ? parsed.evidence_kept : undefined,
      backgroundClean: typeof parsed.background_clean === 'boolean' ? parsed.background_clean : undefined,
      referenceColor: typeof parsed.reference_color === 'string' ? parsed.reference_color : undefined,
      resultColor: typeof parsed.result_color === 'string' ? parsed.result_color : undefined,
      studioLighting: typeof parsed.studio_lighting === 'boolean' ? parsed.studio_lighting : undefined,
      grounded: typeof parsed.grounded === 'boolean' ? parsed.grounded : undefined,
      compositionGood: typeof parsed.composition_good === 'boolean' ? parsed.composition_good : undefined,
      confidence,
      problems: Array.isArray(parsed.problems)
        ? parsed.problems.filter((p) => typeof p === 'string' && p.trim()).slice(0, 6)
        : [],
      model,
    };
  } catch (err) {
    console.warn(`[image-result-check] Identitätsprüfung fehlgeschlagen: ${err.message}`);
    return null;
  }
}

/**
 * Fasst das Urteil zu einer Handlungsempfehlung zusammen.
 *
 * Verwirft sicher erkannte Produktveränderungen einschließlich entfernten
 * Gebrauchsspuren. Fehlende/unsichere Urteile bleiben sichtbar prüfbedürftig.
 */
function classifyIdentityVerdict(verdict, opts = {}) {
  if (opts.requireApproval) {
    const required = ['sameItem', 'markingsKept', 'conditionKept', 'materialKept', 'colorKept', 'evidenceKept'];
    if (!opts.perspektiveDarfAbweichen) required.push('perspectiveKept');
    if (opts.requireCleanBackground !== false) required.push('backgroundClean');
    if (opts.requireStudioPresentation) required.push('studioLighting', 'grounded', 'compositionGood');
    const failed = required.filter(field => verdict?.[field] !== true);
    if (!verdict || !Number.isFinite(verdict.confidence) || verdict.confidence < minIdentityConfidence() || failed.length || verdict.problems?.length) {
      return { action: 'verwerfen', reason: 'qualitaet_nicht_bestaetigt', warnings: [
        ...(failed.some(f => ['studioLighting', 'grounded', 'compositionGood'].includes(f)) ? ['Studio-Licht, Bodenschatten oder Bildgestaltung nicht bestätigt'] : []),
        ...(failed.includes('backgroundClean') ? ['Hintergrund nicht sauber freigestellt'] : []),
        ...(failed.includes('colorKept') ? ['Produktfarbe verändert oder unklar'] : []),
        ...(verdict?.problems || []),
        ...(!verdict || failed.length ? ['Produkttreue nicht vollständig bestätigt'] : []),
      ] };
    }
    return { action: 'ok', warnings: [] };
  }
  if (!verdict) return { action: 'ungeprueft', warnings: [] };

  const warnings = [];
  const preserved = [
    ['conditionKept', 'Zustand oder Gebrauchsspuren verändert'],
    ['materialKept', 'Material oder Oberflächenwirkung verändert'],
    ['colorKept', 'Tatsächliche Produktfarbe verändert'],
    ['evidenceKept', 'Bilddetails ohne Referenzbeleg ergänzt'],
  ];
  for (const [field, message] of preserved) {
    if (verdict[field] === false) warnings.push(message);
  }
  if ([...preserved.map(([field]) => field), 'markingsKept', 'perspectiveKept'].some(field => typeof verdict[field] !== 'boolean')) {
    warnings.push('Produkttreue und Zustand nicht vollständig geprüft');
  }
  // In der Galerie ist ein anderer Blickwinkel der ZWECK, keine Abweichung.
  if (verdict.perspectiveKept === false && opts.perspektiveDarfAbweichen !== true) {
    warnings.push('Blickwinkel wurde verändert');
  }
  if (verdict.markingsKept === false) warnings.push('Beschriftungen wurden verändert oder entfernt');
  for (const problem of verdict.problems || []) warnings.push(problem);

  if (!verdict.sameItem && verdict.confidence >= minIdentityConfidence()) {
    return { action: 'verwerfen', warnings, reason: 'anderer_artikel' };
  }
  if (verdict.confidence >= minIdentityConfidence() && (
    verdict.markingsKept === false || preserved.some(([field]) => verdict[field] === false)
  )) {
    return { action: 'verwerfen', warnings, reason: 'produkt_veraendert' };
  }
  if (verdict.confidence < minIdentityConfidence()) warnings.push('Qualitätsurteil unsicher');
  if (!verdict.sameItem) {
    warnings.unshift('Verdacht auf abweichenden Artikel (unsicher)');
    return { action: 'warnen', warnings };
  }
  return { action: warnings.length ? 'warnen' : 'ok', warnings };
}

module.exports = {
  // EINE Quelle fuer die Mindestkante — wer sie sonst braucht, importiert sie
  // hier, statt eine zweite Zahl zu pflegen (Lehre aus CLAUDE.md 16c).
  MIN_EDGE_PX,
  validateGeneratedImage,
  validateDarkMaterialColor,
  assessBackgroundBrightness,
  judgeProductIdentity,
  classifyIdentityVerdict,
  identityCheckEnabled,
  _internal: { IDENTITY_SCHEMA, IDENTITY_PROMPT, IDENTITY_PROMPT_GALERIE },
};
