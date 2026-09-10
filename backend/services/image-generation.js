'use strict';

/* eslint-disable no-console */

/**
 * image-generation.js — Angebotsgalerie aus den vorhandenen Produktfotos.
 *
 * ============================================================================
 * AUFTRAG (Betreiber 2026-09-10, mit Beispiel-Vorlage):
 *   "die funktion muss alle vorhandenen bilder im produktdatenblatt analysieren
 *    und logisch und plausibel dann mindestens 4 studio fotos generiert und
 *    2 optionale lifestyle scene bilder."
 *
 * Ablauf:
 *   1. ALLE echten Produktfotos laden (erzeugte sind ausgeschlossen).
 *   2. EIN Vision-Call beantwortet zwei Fragen: welche Seite zeigt jedes Foto,
 *      und WAS ist der Artikel / wie wird er benutzt (`lib/image-viewpoint.js`).
 *      Das Zweite traegt die Anwendungsszenen — ohne es waeren sie geraten.
 *   3. `planGalleryVariants` plant mindestens vier Studio-Ansichten plus zwei
 *      Szenen. Ansichten MIT echtem Foto kommen zuerst und bekommen dieses Foto
 *      als Vorlage; erst danach wird auf den Kanon aufgefuellt.
 *   4. Je Ansicht ein Bildaufruf mit ALLEN echten Fotos als Referenz, danach
 *      Ergebnispruefung und Identitaets-Zweitmeinung.
 *
 * ============================================================================
 * WIDERRUFENE VORGABE — bitte nicht wiederbeleben, ohne den Betreiber zu fragen.
 *
 * Vom 02.09. bis 10.09. galt hier das Gegenteil: es wurde NUR aufbereitet, was
 * als echtes Foto belegt war, und eine fehlende Ansicht entstand NICHT. Der
 * Grund war die Beschwerde "nicht originalgetreu" plus die Marktplatz-Regeln
 * (eBay: "using these tools to alter a product in any way is against eBay's
 * policies"; Kaufland verlangt Fotos, keine Montagen).
 *
 * Der Betreiber hat das am 10.09. ausdruecklich widerrufen und die Serie mit
 * einem konkreten Beispiel bestellt. Die Abwaegung dahinter, damit sie nicht
 * verloren geht: die erzeugten Bilder sind ZUSATZbilder fuer die Galerie, das
 * HAUPTBILD bleibt ein echtes Foto. Supplementaere Studio- und Anwendungsbilder
 * sind im Handel ueblich; die Regeln zielen auf die irrefuehrende Darstellung
 * des Artikels, nicht auf jede erzeugte Ansicht. Verantwortlich bleibt laut
 * eBay-Nutzungsvereinbarung ausdruecklich der Verkaeufer.
 *
 * Was aus der alten Fassung BLEIBT, weil es unabhaengig davon richtig ist:
 *   - Erzeugte Bilder sind als solche gekennzeichnet (`generatedByAi`) und
 *     koennen NIE Referenz eines Folgelaufs werden ("Kopie einer Kopie").
 *   - Jede Ausgabe traegt `ausEchtemFoto`: sitzt sie auf einer echten Aufnahme
 *     derselben Seite, oder wurde sie abgeleitet? Der Bediener sieht das.
 *   - Der Prompt verlangt, Beschriftungen als FORMEN zu kopieren statt sie zu
 *     lesen und neu zu setzen — gemessen am 04.09. ueber 21 Laeufe die einzige
 *     Formulierung, die den Kleindruck halbwegs haelt.
 *   - Ergebnispruefung, Zeitbudget, Nebenlaeufigkeit, Modellkette bleiben.
 * ============================================================================
 */

const sharp = require('sharp');
const { generateProductImagesWithReport, GeminiImageError } = require('../lib/vertex-ai');
const { uploadBase64Image } = require('../lib/storage');
const { buildGalleryPrompt, buildMaskPrompt, generateVisualDescriptions } = require('./prompt-engine');
const { fetchWithUnlocker } = require('../lib/web-unlocker');
const {
  classifyViewpointParts,
  summarizeEvidence,
  planGalleryVariants,
  VIEWPOINT_LABELS_DE,
} = require('../lib/image-viewpoint');
const {
  validateGeneratedImage,
  judgeProductIdentity,
  classifyIdentityVerdict,
  MIN_EDGE_PX,
} = require('../lib/image-result-check');
const {
  variantImageModelChain,
  maskImageModelChain,
  maxObjectReferences,
} = require('../lib/gemini-image-models');
const { neuerZaehler, schaetzePosten } = require('../lib/image-cost');
const { bauePackshot, compositeEnabled } = require('../lib/packshot-composite');

const GENERATED_IMAGE_PATTERN =
  /(generated|gpt|gemini|vertex|ai[-\s]?image|ai[-\s]?render|background_removal|studio_)/i;
const MAX_REFERENCE_BYTES = parseInt(process.env.VERTEX_REFERENCE_MAX_BYTES || '12000000', 10);
const SUPPORTED_REFERENCE_MIME_TYPES = new Set(['image/png', 'image/jpeg']);
const VERTEX_REFERENCE_TIMEOUT_MS = parseInt(process.env.VERTEX_REFERENCE_TIMEOUT_MS || '20000', 10);

// Kante, auf die Referenzbilder vor dem Modell begrenzt werden. Identisch zum
// Studio-Pfad — ein unbegrenzt grosses Foto kostet nur Bandbreite und Zeit.
const PRE_MAX_EDGE_PX = parseInt(process.env.VARIANT_PRE_MAX_EDGE || '1600', 10);
// Zielauflösung des Ergebnisses. eBay schaltet die Zoomlupe erst ab 1.600 px frei;
// '2K' liegt darüber. Führt ein Modell die Grösse nicht, wird das Feld gar nicht
// gesendet (resolveImageSize) — ein unbekanntes Feld ignoriert Gemini stillschweigend.
const VARIANT_IMAGE_SIZE = process.env.VARIANT_IMAGE_SIZE || '2K';

/**
 * Zielgroesse je Bildart — der groesste Einzelhebel bei den Kosten.
 *
 * STUDIO bleibt auf 2K (2048 px): eBay schaltet die Zoomlupe erst ab 1.600 px
 * frei, 1K waeren nur 1024 px und damit unter der Schwelle.
 * SZENEN brauchen keine Zoomlupe — ein Umgebungsbild wird nicht herangezoomt.
 * Preisliste: 0,101 $ (2K) gegen 0,067 $ (1K) je Bild auf gemini-3.1-flash-image
 * — 34 % gespart, ohne dass es jemand sieht.
 */
const LIFESTYLE_IMAGE_SIZE = process.env.LIFESTYLE_IMAGE_SIZE || '1K';

/**
 * Zielgroesse der MASKEN-Aufnahme. Bewusst klein: von ihr wird nur die
 * Silhouette gelesen, und die wird intern ohnehin auf 1.200 px gerechnet
 * (packshot-composite.js MASKEN_KANTE). Mehr Pixel waeren bezahlte Pixel, die
 * niemand ansieht — das Endbild besteht aus ORIGINALPIXELN.
 */
const MASK_IMAGE_SIZE = process.env.VARIANT_MASK_IMAGE_SIZE || '1K';

/**
 * Der pixeltreue Weg ist AN, solange nicht ausdruecklich abgeschaltet
 * (Hausregel: nur der exakte Wert 'off'). Zusaetzlich gilt der gemeinsame
 * Schalter `STUDIO_COMPOSITE` — wer den Composite global abschaltet, schaltet
 * ihn auch hier ab.
 */
function pixeltreuAktiv() {
  return compositeEnabled() && String(process.env.GALLERY_PIXEL_FAITHFUL || '').trim() !== 'off';
}

/**
 * Wie viele Referenzbilder hoechstens mitgehen. Jedes Eingabebild kostet Token,
 * und der Nutzen saettigt: die ersten Ansichten legen Form und Farbe fest, das
 * sechste Foto aendert daran nichts mehr. Das modellabhaengige Limit bleibt
 * zusaetzlich in Kraft (`maxObjectReferences`), es gilt der kleinere Wert.
 */
function maxReferenzen() {
  const raw = parseInt(process.env.VARIANT_MAX_REFERENCES || '4', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
}

function variantTimeoutMs() {
  const raw = parseInt(process.env.VARIANT_IMAGE_TIMEOUT_MS || '90000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 90000;
}

/**
 * GESAMT-Zeitbudget der Route. Cloud Run bricht bei 600 s ab; danach sieht der
 * Bediener nur eine tote Verbindung — genau das Schadensbild aus CLAUDE.md
 * Punkt 17d ("Produkt wird analysiert…" bis zu 20 Minuten). 300 s laesst
 * reichlich Luft und beendet den Lauf mit einem EHRLICHEN Bericht statt mit
 * einem Verbindungsabbruch.
 */
function totalBudgetMs() {
  const raw = parseInt(process.env.IMAGE_VARIANTS_TOTAL_TIMEOUT_MS || '300000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

/**
 * Wie viele Ansichten gleichzeitig gerendert werden. Sequenziell summierten sich
 * bei vier Ansichten und zwei Modellen in der Kette bis zu 14 Minuten — mehr als
 * Cloud Run zulaesst. Die Ansichten sind voneinander unabhaengig (eigene Vorlage,
 * eigener Variantenname), also duerfen sie parallel laufen. Nicht hoeher als
 * noetig: jede Spur ist ein teurer Bildaufruf.
 */
function renderConcurrency() {
  const raw = parseInt(process.env.IMAGE_VARIANTS_CONCURRENCY || '2', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 4) : 2;
}

/**
 * Fuehrt die Aufgaben mit begrenzter Nebenlaeufigkeit aus und haelt dabei die
 * Reihenfolge der Ergebnisse ein. Eine Aufgabe, die nach Ablauf des Budgets an
 * die Reihe kaeme, wird gar nicht erst gestartet.
 */
async function runLimited(tasks, limit, deadline) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= tasks.length) return;
      if (Date.now() > deadline) {
        results[i] = { zeitbudget: true };
        continue;
      }
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * ES GIBT KEINEN WEG ZURUECK ZUM ALTEN VERHALTEN — bewusst.
 *
 * Ein `IMAGE_VARIANTS_MODE='legacy'` war kurzzeitig eingebaut und wurde wieder
 * entfernt: mit den neuen Erhaltungs-Prompts ("Perspektive von Bild 1 behalten")
 * haette er VIER IDENTISCHE Bilder erzeugt und sie als Vorder-, Seiten-, Detail-
 * und Rueckansicht ETIKETTIERT — schlechter als das alte Verhalten und schlechter
 * als gar nichts. Das alte Verhalten liesse sich nur durch Wiederbeleben der
 * Erfindungs-Prompts herstellen, und genau die verstossen gegen die
 * Bildrichtlinien von eBay und Kaufland.
 *
 * Der Rueckfall fuer den Stoerungsfall ist ein anderer und bereits eingebaut:
 * scheitert die Ansichtserkennung, wird die vom Bediener GEWAEHLTE Vorlage
 * aufbereitet — eine Ansicht statt keiner, ohne etwas zu erfinden.
 */
function variantsMode() {
  return 'faithful';
}

/**
 * Wie viele STUDIO-Ansichten die Serie hat. Betreiber-Vorgabe 2026-09-10:
 * mindestens vier. Der Aufrufer darf hochsetzen, aber nicht unter vier fallen —
 * eine dreiteilige Serie war ausdruecklich nicht gewuenscht.
 */
function studioCount(maxVariants) {
  const gewuenscht = Number.isInteger(maxVariants) && maxVariants > 0 ? maxVariants : 4;
  const min = parseInt(process.env.IMAGE_STUDIO_MIN || '4', 10);
  return Math.max(Number.isFinite(min) && min > 0 ? min : 4, gewuenscht);
}

/**
 * Anwendungsszenen sind OPTIONAL (Betreiber: "2 optionale lifestyle scene bilder").
 * Der Aufrufer entscheidet je Lauf; ohne Angabe sind sie an.
 * Notbremse fuer den Betrieb: `IMAGE_LIFESTYLE_SCENES='off'`.
 */
function lifestyleGewuenscht(options = {}) {
  if (String(process.env.IMAGE_LIFESTYLE_SCENES || '').trim() === 'off') return false;
  if (typeof options.lifestyle === 'boolean') return options.lifestyle;
  return true;
}

function isLikelyAiImage(image = {}) {
  // `generatedByAi` ist die verlässliche Kennzeichnung; die Textmuster bleiben
  // als Netz für Altbestände ohne dieses Feld.
  if (image.generatedByAi === true) return true;
  const source = String(image.source || '').toLowerCase();
  const notes = String(image.notes || '').toLowerCase();
  const variant = String(image.variant || '').toLowerCase();
  return (
    GENERATED_IMAGE_PATTERN.test(source) ||
    GENERATED_IMAGE_PATTERN.test(notes) ||
    GENERATED_IMAGE_PATTERN.test(variant)
  );
}

async function normalizeReferenceBuffer(buffer, mimeType = 'image/png') {
  let targetBuffer = buffer;
  let targetMime = (mimeType || '').toLowerCase();

  if (!SUPPORTED_REFERENCE_MIME_TYPES.has(targetMime)) {
    targetBuffer = await sharp(buffer).png({ quality: 92 }).toBuffer();
    targetMime = 'image/png';
  }

  if (targetBuffer.length > MAX_REFERENCE_BYTES) {
    throw new Error(`Reference image exceeds ${Math.floor(MAX_REFERENCE_BYTES / (1024 * 1024))} MB limit`);
  }

  return `data:${targetMime};base64,${targetBuffer.toString('base64')}`;
}

/**
 * EXIF-Rotation anwenden und die Kante begrenzen, bevor das Bild ans Modell geht.
 * Ohne `.rotate()` bekommt das Modell ein hochkant aufgenommenes Handyfoto
 * seitwärts vorgelegt und dreht das Produkt im Ergebnis mit — der Studio-Pfad
 * machte das längst, der Varianten-Pfad nicht. WIRFT NIE.
 */
async function preprocessReference(buffer) {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({
        width: PRE_MAX_EDGE_PX,
        height: PRE_MAX_EDGE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn(`[image-generation] Vorverarbeitung fehlgeschlagen: ${err.message}`);
    return buffer;
  }
}

async function fetchReferenceDirect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERTEX_REFERENCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'avystock-vertex-ref/1.0',
        Accept: 'image/*,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new Error(`unexpected content-type ${mimeType || 'unknown'}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('empty response body');
    return normalizeReferenceBuffer(buffer, mimeType);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImageAsDataUrl(image) {
  const value = image?.url_or_base64;
  if (!value) throw new Error('Reference image payload is missing.');

  if (value.startsWith('data:')) {
    const match = value.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
    if (!match?.groups?.data) throw new Error('Invalid data URL reference image.');
    const buffer = Buffer.from(match.groups.data, 'base64');
    return normalizeReferenceBuffer(buffer, match.groups.mime);
  }

  if (/^https?:\/\//i.test(value)) {
    // Eigene/öffentliche Bilder (GCS, CDN) sind direkt ladbar. Der teure
    // Scraping-Proxy bleibt der Sonderfall für Hosts, die Rechenzentrums-IPs sperren.
    try {
      return await fetchReferenceDirect(value);
    } catch (directErr) {
      console.warn(`Direct reference download failed (${directErr.message}); trying Web Unlocker: ${value}`);
    }

    const result = await fetchWithUnlocker({
      url: value,
      method: 'GET',
      format: 'raw',
      timeoutMs: VERTEX_REFERENCE_TIMEOUT_MS,
      headers: {
        'User-Agent': 'avystock-vertex-ref/1.0',
        Accept: 'image/*,*/*;q=0.8',
        Referer: '',
      },
    });
    if (!result.success) throw new Error(result.error || 'Failed to download reference image');
    const mimeType = result.contentType || 'image/jpeg';
    if (!mimeType.startsWith('image/')) {
      throw new Error(`Unexpected reference content-type ${mimeType}`);
    }
    const buffer = result.body_base64
      ? Buffer.from(result.body_base64, 'base64')
      : Buffer.from(result.body || '', 'binary');
    return normalizeReferenceBuffer(buffer, mimeType);
  }

  throw new Error('Unsupported reference image format.');
}

function normalizeImageKey(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\s+/g, '').toLowerCase();
}

/**
 * Sammelt ECHTE Fotos des Produkts. Erzeugte Bilder sind ausgeschlossen — sonst
 * dient die Ausgabe eines Laufs als Eingabe des nächsten und die Abweichung
 * schaukelt sich über Generationen auf ("Kopie einer Kopie").
 *
 * Das vom Bediener gewählte Bild steht vorn: es ist die Vorlage, alle übrigen
 * sind nur Identitätsanker.
 */
function collectReferenceCandidates(product, primaryReference, limit = 8) {
  const out = [];
  const seen = new Set();

  const push = (img) => {
    const url = img?.url_or_base64;
    if (!url || typeof url !== 'string') return;
    const key = normalizeImageKey(url);
    if (!key || seen.has(key)) return;
    if (isLikelyAiImage(img)) return;
    seen.add(key);
    out.push(img);
  };

  if (primaryReference && typeof primaryReference === 'object') push(primaryReference);

  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  for (const img of images) {
    if (out.length >= limit) break;
    push(img);
  }

  return out.slice(0, limit);
}

function dataUrlToParts(dataUrl) {
  const match = /^data:(?<mime>[^;]+);base64,(?<data>.+)$/.exec(dataUrl || '');
  if (!match?.groups?.data) return null;
  return { data: match.groups.data, mimeType: match.groups.mime };
}

/**
 * Lädt alle Kandidaten und bereitet sie auf.
 * @returns {Promise<Array<{image:Object, dataUrl:string, part:Object}>>}
 */
async function loadReferences(candidates) {
  // PARALLEL: sequenziell konnten acht Downloads (jeder mit bis zu 20 s Timeout
  // und Web-Unlocker-Rueckfall) das Gesamtbudget aufbrauchen, bevor die erste
  // Ansicht ueberhaupt startete. Die Reihenfolge bleibt erhalten — von ihr
  // haengen alle spaeteren Indizes ab.
  const ergebnisse = await Promise.all(
    candidates.map(async (img) => {
      try {
        const raw = await fetchImageAsDataUrl(img);
        const parsed = dataUrlToParts(raw);
        if (!parsed) return null;
        const pre = await preprocessReference(Buffer.from(parsed.data, 'base64'));
        const b64 = pre.toString('base64');
        return {
          image: img,
          dataUrl: `data:image/jpeg;base64,${b64}`,
          part: { inlineData: { data: b64, mimeType: 'image/jpeg' } },
          // Die ENTSCHLUESSELTEN Pixel. Der pixeltreue Weg legt genau sie ins
          // Endbild — nicht das, was ein Bildmodell daraus macht. Kostet nichts
          // extra: der Puffer liegt hier ohnehin schon aufbereitet vor.
          buffer: pre,
        };
      } catch (err) {
        // Best-effort, aber die Ursache muss sichtbar bleiben (Incident 2026-07-09:
        // ein still verschluckter Web-Unlocker-Fehler kostete Tage).
        console.warn(`Reference download failed for ${img?.url_or_base64 || 'unknown'}: ${err.message}`);
        return null;
      }
    })
  );
  return ergebnisse.filter(Boolean);
}

/**
 * PIXELTREUER WEG — nur fuer Studio-Ansichten, die ein ECHTES Foto haben.
 *
 * ============================================================================
 * WARUM (gemessen 2026-09-10 am Marstek-Speicher, sechs erzeugte Galeriebilder):
 * ein Bildmodell rendert IMMER alles neu, auch wenn es nur den Hintergrund
 * tauschen soll. Grosse Schrift uebersteht das ("MARSTEK" blieb korrekt),
 * KLEINDRUCK nicht. Auf der Rueckansicht wurde aus "DO NOT CONNECT SOLAR
 * PANELS" ein "CUT CONT CONNECT SPLAR PANLS", aus den Anschluessen OUT1/OUT2
 * wurden "LUT0"/"2 UT2", und die Hero-Ansicht erfand einen Anschluss "OUT3",
 * den das Geraet nicht hat. Das ist dieselbe Klasse wie im Studio-Pfad
 * (CLAUDE.md 2026-09-04) und dort steht auch das Urteil: ein erfundener Text
 * auf einem Angebotsbild ist eine falsche Produktangabe.
 *
 * Kein Prompt heilt das — 21 Laeufe ueber 6 Prompt-Fassungen haben es im
 * Studio-Pfad nicht geschafft. Die Loesung ist, das Modell gar nicht erst
 * malen zu lassen: es liefert nur die SILHOUETTE, seine Pixel werden
 * weggeworfen, ins Endbild gehen ORIGINALPIXEL. Der Kleindruck bleibt damit
 * BAUARTBEDINGT unversehrt.
 *
 * DAS GILT NUR, WO ES EIN FOTO GIBT. Eine Ansicht, die nie fotografiert wurde
 * (Hero, Draufsicht ohne Vorlage), MUSS gerendert werden — dort ist die
 * Textnaeherung der Preis fuer eine Ansicht, die es sonst gar nicht gaebe.
 * Der Betreiber hat diese Ableitung am 2026-09-10 ausdruecklich bestellt.
 *
 * UND ER IST BILLIGER, nicht teurer: die Maske kommt vom guenstigsten Modell
 * in 1K (0,034 $) statt eines 2K-Renders (0,101 $), und die Zweitmeinung
 * "zeigt das noch denselben Artikel?" entfaellt — bei Originalpixeln ist die
 * Frage bauartbedingt beantwortet. Das spart je echter Ansicht rund 66 %.
 *
 * FAIL-CLOSED: greift eine der Waechter in packshot-composite.js (Deckung,
 * groesste Flaeche, Seitenverhaeltnis, Randberuehrung, Kompaktheit, Rand), wird
 * KEIN Packshot geliefert und der normale Render-Weg uebernimmt. Lieber ein
 * gerendertes Bild als ein zerfallenes Produkt (Incident 2026-07-18).
 * ============================================================================
 *
 * @returns {Promise<Object|null>} Ergebnis wie renderOneView, oder null wenn
 *          dieser Weg gar nicht in Frage kommt (dann still weiter zum Render).
 */
async function renderPixeltreu({ planEntry, references, sourceIndex, deadline, kosten }) {
  const quelle = references[sourceIndex];
  if (!quelle?.buffer || !quelle?.dataUrl) return null;

  const attempts = [];


  for (const model of maskImageModelChain()) {
    const rest = typeof deadline === 'number' ? deadline - Date.now() : Infinity;
    if (rest < 5000) {
      attempts.push({ model, reason: 'zeitbudget_erschoepft' });
      break;
    }
    if (kosten && !kosten.darfNoch(model, MASK_IMAGE_SIZE)) {
      attempts.push({
        model,
        reason: `kostendeckel_erreicht(${kosten.usd.toFixed(2)}/${kosten.deckel.toFixed(2)} USD)`,
      });
      break;
    }

    try {
      const report = await generateProductImagesWithReport({
        prompt: buildMaskPrompt(),
        count: 1,
        // Kein erzwungenes Seitenverhaeltnis: der Composite vergleicht die
        // Seitenverhaeltnisse von Foto und Maske und verwirft bei Abweichung.
        aspectRatio: null,
        // NUR die Vorlage. Weitere Fotos koennten das Modell dazu bringen, eine
        // andere Ansicht zu zeichnen — dann passt die Maske nicht mehr auf das
        // Originalfoto und der Composite baut Unsinn.
        referenceImages: [quelle.dataUrl],
        model,
        timeoutMs: Math.min(variantTimeoutMs(), rest),
        imageSize: MASK_IMAGE_SIZE,
        maxAttempts: 1,
      });

      if (kosten) kosten.buche(report.model || model, MASK_IMAGE_SIZE, `${planEntry?.variant}:maske`);

      const candidate = report.images?.[0];
      if (!candidate?.base64) {
        attempts.push({ model, reason: 'maske_kein_bild' });
        continue;
      }

      const packshot = await bauePackshot(quelle.buffer, Buffer.from(candidate.base64, 'base64'), {
        // Derselbe helle Verlauf wie bei den gerenderten Ansichten — sonst
        // stuende ein reinweisser Packshot neben grau verlaufenden Bildern und
        // die Galerie saehe zusammengewuerfelt aus.
        hintergrund: 'verlauf',
      });
      if (!packshot.ok) {
        attempts.push({ model, reason: `packshot_verworfen: ${packshot.gruende.join(', ')}` });
        continue;
      }

      return {
        buffer: packshot.buffer,
        mimeType: 'image/jpeg',
        model: report.model || model,
        width: packshot.width,
        height: packshot.height,
        referenceCount: 1,
        warnings: [],
        // KEINE Vision-Zweitmeinung, und das ist kein Versaeumnis: das Ergebnis
        // besteht aus den Pixeln des Referenzfotos. "Zeigt es denselben
        // Artikel?" ist damit staerker beantwortet, als ein Modellurteil es
        // je koennte — und ein gesparter Aufruf.
        identityChecked: false,
        pixeltreu: true,
        packshotInfo: packshot.info,
        attempts,
      };
    } catch (err) {
      const code = err instanceof GeminiImageError ? err.code : 'UNKNOWN';
      attempts.push({ model, reason: `maske ${code}: ${err.message}` });
    }
  }

  return { failed: true, attempts };
}

/**
 * Ist der Weg zur EINHEITLICHEN Leinwand aktiv? Nur der exakte Wert 'off'
 * schaltet ab; zusaetzlich gilt der gemeinsame `STUDIO_COMPOSITE`.
 */
function einheitlicheLeinwandAktiv() {
  return compositeEnabled() && String(process.env.GALLERY_UNIFORM_CANVAS || '').trim() !== 'off';
}

/**
 * EINHEITLICHE LEINWAND fuer GERENDERTE Studio-Ansichten.
 *
 * ============================================================================
 * WARUM (Betreiber 2026-09-10): "die oberen 4 bilder wurden generiert und
 * grundsaetzlich sehr gut! aber... der hintergrund aller 4 bilder ist
 * unterschiedlich!"
 *
 * Ursache waren ZWEI Quellen fuer denselben Bildteil. Der pixeltreue Weg legt
 * seinen Grund deterministisch an (`baueVerlaufsgrund`), der Render-Weg liess
 * ihn das Modell malen — und ein Modell malt ihn jedes Mal anders. Gemessen an
 * einer echten Galerie (Abgasrohr, Produkt 6c764467), Helligkeit der vier
 * Bildecken:
 *     pixeltreu   237 / 237 / 230 / 230   (zwei Bilder, exakt gleich)
 *     gerendert   220 / 221 / 219 / 218   (17 Stufen daneben)
 * Ueber mehrere Renderlaeufe schwankte der Grund zwischen 196 und 221.
 *
 * PROMPT ALLEIN REICHT NICHT — gemessen. Eine Fassung, die ausdruecklich
 * "seamless PURE WHITE, edge to edge, no gradient, no vignette" verlangt,
 * lieferte trotzdem einen Verlauf mit Eckenspanne 24,6. Und eine Selbst-
 * maskierung des Renders scheitert daran zu Recht: die Waechter meldeten
 * "kein_hintergrund_erkannt(99,9 %)", weil ein grauer Grund unter der
 * Produktschwelle liegt und damit als Produkt gilt.
 *
 * WAS FUNKTIONIERT, ebenfalls gemessen: ein eigener MASKEN-Aufruf auf das
 * fertige Renderbild. Der MASKEN_PROMPT liefert dort verlaesslich Weiss
 * (Ecken 254/255/255/255), und der anschliessende Composite trifft die Zielwerte
 * auf den Punkt: 237/237/230/230, Eckenspanne 7,7 — Zeichen fuer Zeichen wie die
 * pixeltreuen Bilder.
 *
 * ES VEREINHEITLICHT MEHR ALS DEN HINTERGRUND: Leinwandformat, Fuellgrad,
 * senkrechte Platzierung und Kontaktschatten kommen danach fuer JEDES
 * Studio-Bild aus derselben Stelle. Auf dem Screenshot des Betreibers schwankte
 * auch die Produktgroesse sichtbar.
 *
 * KOSTEN, ehrlich: ein Maskenaufruf je gerenderter Studio-Ansicht,
 * 0,034 $ auf dem guenstigsten Modell in 1K. Bei einer typischen Serie mit zwei
 * abgeleiteten Studio-Ansichten sind das 0,068 $ je Knopfdruck. Notbremse
 * `GALLERY_UNIFORM_CANVAS='off'`.
 *
 * ANWENDUNGSSZENEN BLEIBEN UNANGETASTET — sie zeigen eine echte Umgebung, die
 * gerade nicht wegmaskiert werden soll.
 * ============================================================================
 *
 * @returns {Promise<{buffer:Buffer, mimeType:string, width:number, height:number,
 *                    info:Object}|null>} null = unveraendert lassen.
 */
async function vereinheitlicheLeinwand({ bild, planEntry, deadline, kosten, attempts }) {
  const [model] = maskImageModelChain();
  const rest = typeof deadline === 'number' ? deadline - Date.now() : Infinity;
  if (rest < 5000) {
    attempts.push({ model, reason: 'leinwand_zeitbudget_erschoepft' });
    return null;
  }
  if (kosten && !kosten.darfNoch(model, MASK_IMAGE_SIZE)) {
    attempts.push({ model, reason: 'leinwand_kostendeckel_erreicht' });
    return null;
  }

  try {
    const report = await generateProductImagesWithReport({
      prompt: buildMaskPrompt(),
      count: 1,
      aspectRatio: null,
      referenceImages: [`data:image/png;base64,${bild.toString('base64')}`],
      model,
      timeoutMs: Math.min(variantTimeoutMs(), rest),
      imageSize: MASK_IMAGE_SIZE,
      maxAttempts: 1,
    });
    if (kosten) kosten.buche(report.model || model, MASK_IMAGE_SIZE, `${planEntry?.variant}:leinwand`);

    const candidate = report.images?.[0];
    if (!candidate?.base64) {
      attempts.push({ model, reason: 'leinwand_maske_kein_bild' });
      return null;
    }

    const packshot = await bauePackshot(bild, Buffer.from(candidate.base64, 'base64'), {
      hintergrund: 'verlauf',
      // KEIN Weissabgleich: der Hintergrund eines Renders ist keine Graukarte,
      // sondern ein frei gewaehlter Ton. Ein daraus abgeleiteter Faktor haette
      // die Produkthelligkeit von Bild zu Bild verschoben — genau die
      // Uneinheitlichkeit, die hier beseitigt wird. Die Schattenaufhellung
      // bleibt: sie misst am PRODUKT und zielt auf einen festen Wert.
      weissabgleich: false,
    });
    if (!packshot.ok) {
      attempts.push({ model, reason: `leinwand_verworfen: ${packshot.gruende.join(', ')}` });
      return null;
    }
    // AUFLOESUNGS-WACHE. `validateGeneratedImage` hat den RENDER geprueft; hier
    // wird der Puffer ausgetauscht, und danach schaut niemand mehr hin. Die
    // Leinwand richtet sich nach dem PRODUKT und wird nie vergroessert — ein
    // klein gerenderter Artikel ergaebe eine kleine Leinwand, die `lib/storage.js`
    // anschliessend wieder auf 1200 px hochrechnet. Dann lieber das rohe,
    // bereits geprueste Renderbild behalten. Dieselbe Quelle wie die
    // Eingangspruefung, keine zweite Zahl.
    if (Math.min(packshot.width, packshot.height) < MIN_EDGE_PX) {
      attempts.push({
        model,
        reason: `leinwand_zu_klein(${packshot.width}x${packshot.height}, min ${MIN_EDGE_PX})`,
      });
      return null;
    }
    return {
      buffer: packshot.buffer,
      mimeType: 'image/jpeg',
      width: packshot.width,
      height: packshot.height,
      info: packshot.info,
    };
  } catch (err) {
    const code = err instanceof GeminiImageError ? err.code : 'UNKNOWN';
    attempts.push({ model, reason: `leinwand ${code}: ${err.message}` });
    return null;
  }
}

/**
 * Erzeugt EINE Ansicht: Vorlage zuerst, übrige Fotos als Identitätsanker.
 * Läuft die Modellkette durch, ohne ein gültiges Ergebnis, wird nichts geliefert.
 */
async function renderOneView({ product, produktInfo, planEntry, references, sourceIndex, deadline, kosten, ankerErlaubt, nurPixeltreu }) {
  const chain = variantImageModelChain();
  const attempts = [];

  // --- PIXELTREU ZUERST, wo es ein echtes Foto gibt -------------------------
  // Nur Studio-Ansichten mit echter Vorlage: eine Anwendungsszene MUSS gemalt
  // werden (sie zeigt eine Umgebung, die es auf keinem Foto gibt), und eine
  // abgeleitete Ansicht hat definitionsgemaess kein Foto, dessen Pixel man
  // uebernehmen koennte.
  const kommtInFrage =
    pixeltreuAktiv() && planEntry?.art === 'studio' && planEntry?.quelleIstEcht === true;
  if (kommtInFrage) {
    const treu = await renderPixeltreu({ planEntry, references, sourceIndex, deadline, kosten });
    if (treu && !treu.failed) return treu;
    // MAKROAUFNAHMEN FALLEN NICHT AUF DEN RENDER ZURUECK (seit 2026-09-10).
    // Bei jeder anderen Ansicht ist ein gerendertes Bild besser als keines.
    // Bei einer Nahaufnahme nicht: dort fuellt genau das, was das Modell nicht
    // kann — Display, Bedienfeld, Typenschild, Kleindruck — das ganze Bild.
    // Lieber die Detailansicht weglassen und den Grund melden.
    if (planEntry?.key === 'detail') {
      return { failed: true, attempts: [...attempts, ...(treu?.attempts || [])] };
    }
    // Im NUR-PIXELTREU-Betrieb gibt es keinen Render-Rueckfall: der Aufrufer hat
    // ausdruecklich Originalpixel bestellt und rechnet mit Maskenkosten. Ein
    // stiller Render waere dreimal so teuer und inhaltlich das Gegenteil.
    if (nurPixeltreu) {
      return { failed: true, attempts: [...attempts, ...(treu?.attempts || [])] };
    }
    // Gescheitert ist kein Beinbruch — der Render-Weg uebernimmt. Die Gruende
    // wandern aber mit in den Bericht, sonst bliebe unsichtbar, dass der
    // billigere und treuere Weg gar nicht durchkam.
    if (treu?.attempts?.length) attempts.push(...treu.attempts);
  }

  // NUR DIE VORLAGE (Korrektur 2026-09-04, Betreiber: "Produkt weicht vom
  // Original ab"). Bis dahin gingen ALLE geladenen Fotos als "Identitaetsanker"
  // mit — bis zu sechs Bilder fuer EINE Ansicht. Das Modell mischte sie, obwohl
  // der Prompt es verbot, und das Ergebnis zeigte ein Produkt, das keinem der
  // Fotos entsprach.
  //
  // Der Denkfehler: Anker helfen, wenn eine Ansicht ERFUNDEN werden muss. Seit
  // der Umstellung wird jede Ansicht aus GENAU EINEM echten Foto aufbereitet —
  // alles Noetige steckt darin. Weitere Bilder koennen nur Drift erzeugen.
  // ALLE echten Fotos gehen mit (Betreiber-Vorgabe 2026-09-10). Die Vorlage der
  // geplanten Ansicht steht vorn, die uebrigen folgen als Identitaetsanker.
  //
  // KEHRTWENDE gegenueber dem 04.09.: damals wurden die Anker abgeschaltet, weil
  // das Modell die Vorlagen vermischte — richtig, SOLANGE nur EIN vorhandenes
  // Foto geputzt wurde. Jetzt wird eine Ansicht ABGELEITET, die es nicht als
  // Foto gibt; dafuer braucht das Modell alle Seiten, sonst erfindet es sie.
  // Notbremse: `VARIANT_SIBLING_ANCHORS='off'`.
  const ankerAus = String(process.env.VARIANT_SIBLING_ANCHORS || '').trim() === 'off';

  // ANKER SIND GEFILTERT (seit 2026-09-10) — vorher gingen ALLE geladenen Bilder
  // mit, ungefiltert vom Urteil der Ansichtserkennung. Gemessen am Heimtrainer
  // Christopeit AL1000 (Produkt ddf4532e) war das die Ursache der beiden
  // schwersten Beschwerden:
  //   - Unter den Ankern lagen Fotos des KARTONS. Auf dessen Aufdruck sitzt ein
  //     kleines gruenes LCD mit "43.2" — genau dieses Display malte das Modell
  //     dem Artikel an, statt des echten blauen Displays mit TIME/PULSE/LEVEL.
  //   - Dasselbe Kartonfoto zeigt Klarsichtfolie. Sie landete im erzeugten
  //     Anwendungsbild AM PRODUKT: der Artikel wirkte noch eingetuetet.
  // `ankerIndexes` enthaelt nur Fotos, die den Artikel ausgepackt, brauchbar und
  // vor neutralem Grund zeigen (kein Karton, keine Szene, keine Folie).
  const erlaubteAnker = Array.isArray(ankerErlaubt) ? new Set(ankerErlaubt) : null;
  const weitere = references.filter((_, i) => {
    if (i === sourceIndex) return false;
    // Ohne Klassifikation (Vision-Call gescheitert) bleibt es beim alten
    // Verhalten — fail-open, sonst faellt der ganze Lauf auf ein Bild zurueck.
    return erlaubteAnker ? erlaubteAnker.has(i) : true;
  });
  const ordered = ankerAus
    ? [references[sourceIndex]].filter(Boolean)
    : [references[sourceIndex], ...weitere].filter(Boolean);

  for (const model of chain) {
    // Der Einzel-Timeout wird aus der VERBLEIBENDEN Gesamtfrist abgeleitet. Eine
    // feste Obergrenze je Aufruf bindet die Gesamtlaufzeit nicht: bei zwei
    // Modellen in der Kette und mehreren Ansichten summierte sie sich weit ueber
    // Cloud Runs 600 s, und der Bediener sah nur eine tote Verbindung.
    const rest = typeof deadline === 'number' ? deadline - Date.now() : Infinity;
    // Unter 5 s lohnt kein Bildaufruf mehr — er liefe garantiert in den Abbruch.
    if (rest < 5000) {
      attempts.push({ model, reason: 'zeitbudget_erschoepft' });
      break;
    }
    const callTimeout = Math.min(variantTimeoutMs(), rest);

    // Zielgroesse haengt an der Bildart — Szenen brauchen keine Zoom-Aufloesung.
    const zielGroesse = planEntry?.art === 'lifestyle' ? LIFESTYLE_IMAGE_SIZE : VARIANT_IMAGE_SIZE;

    // KOSTENDECKEL: passt dieses Bild noch ins Budget? Ein Deckel, der erst
    // nach dem Bezahlen greift, spart nichts — deshalb VOR dem Aufruf.
    if (kosten && !kosten.darfNoch(model, zielGroesse)) {
      attempts.push({
        model,
        reason: `kostendeckel_erreicht(${kosten.usd.toFixed(2)}/${kosten.deckel.toFixed(2)} USD)`,
      });
      break;
    }

    const limit = Math.min(maxReferenzen(), Math.max(1, maxObjectReferences(model)));
    const used = ordered.slice(0, limit);
    const prompt = buildGalleryPrompt({
      product,
      produkt: produktInfo,
      planEntry,
      referenceCount: used.length,
    });

    try {
      const report = await generateProductImagesWithReport({
        prompt,
        count: 1,
        // KEIN erzwungenes Seitenverhaeltnis — siehe image-studio.js: '1:1'
        // zwang das Modell zur Neukomposition und damit zum Neuzeichnen des
        // Kleindrucks (gemessen 2026-09-04).
        aspectRatio: null,
        referenceImages: used.map((r) => r.dataUrl),
        model,
        timeoutMs: callTimeout,
        imageSize: zielGroesse,
        // Die MODELLKETTE ist bereits die Wiederholung. Zusaetzlich drei
        // Versuche je Modell ergaeben bis zu sechs bezahlte Bildaufrufe pro
        // Ansicht — und dieselbe Vervielfachung im Studio-Pfad.
        maxAttempts: 1,
      });

      // Gebucht wird SOFORT nach dem Aufruf: auch ein Bild, das gleich an einer
      // Pruefung scheitert, ist bereits bezahlt. Erst nach der Pruefung zu
      // buchen wuerde den Deckel systematisch unterlaufen.
      if (kosten) kosten.buche(report.model || model, zielGroesse, planEntry?.variant);

      const candidate = report.images?.[0];
      if (!candidate?.base64) {
        attempts.push({ model, reason: 'kein_bild_in_antwort' });
        continue;
      }

      const buffer = Buffer.from(candidate.base64, 'base64');
      // Eine ANWENDUNGSSZENE hat keinen weissen Hintergrund — ein Balkon oder
      // ein Badezimmer ist keine Studiowand. Die Hintergrundpruefung gilt nur
      // fuer Packshots; sonst faellt jede Szene durch (gemessen 10.09.: 2 von 2).
      const istSzene = planEntry?.art === 'lifestyle';
      const verdict = await validateGeneratedImage(buffer, {
        requireBrightBackground: !istSzene,
      });
      if (!verdict.ok) {
        attempts.push({ model, reason: verdict.reason });
        continue;
      }

      // Zweitmeinung: zeigt das Ergebnis noch denselben Artikel?
      // GALERIE-Modus: der Blickwinkel weicht hier ABSICHTLICH ab. Mit dem
      // Retusche-Prompt verwarf der Richter 5 von 6 guten Bildern, weil ihm
      // gesagt wurde, es haetten nur Hintergrund und Licht wechseln duerfen.
      // Fuer die Zweitmeinung reichen ZWEI Referenzen (Vorlage + eine weitere
      // Ansicht). Jedes Eingabebild kostet Token; ein dritter Blickwinkel
      // aendert am Urteil "derselbe Artikel?" praktisch nichts.
      const identity = await judgeProductIdentity(
        used.slice(0, 2).map((r) => r.part),
        { data: candidate.base64, mimeType: candidate.mimeType || 'image/png' },
        { modus: 'galerie' }
      );
      const identityVerdict = classifyIdentityVerdict(identity, {
        perspektiveDarfAbweichen: true,
      });
      if (identityVerdict.action === 'verwerfen') {
        attempts.push({
          model,
          reason: `identitaet_abweichend: ${identityVerdict.warnings.join('; ') || 'anderer Artikel'}`,
        });
        continue;
      }

      // EINHEITLICHE LEINWAND — erst JETZT, nach allen Pruefungen: fuer ein
      // Bild, das gleich verworfen wird, soll kein Maskenaufruf bezahlt werden.
      // Nur Studio-Ansichten; eine Anwendungsszene zeigt eine echte Umgebung,
      // die gerade nicht wegmaskiert werden soll.
      let ausgabe = { buffer, mimeType: candidate.mimeType || 'image/png', width: verdict.width, height: verdict.height };
      let leinwandVereinheitlicht = false;
      if (!istSzene && einheitlicheLeinwandAktiv()) {
        const einheitlich = await vereinheitlicheLeinwand({
          bild: buffer,
          planEntry,
          deadline,
          kosten,
          attempts,
        });
        if (einheitlich) {
          ausgabe = einheitlich;
          leinwandVereinheitlicht = true;
        }
      }

      return {
        buffer: ausgabe.buffer,
        mimeType: ausgabe.mimeType,
        model: report.model || model,
        width: ausgabe.width,
        height: ausgabe.height,
        referenceCount: used.length,
        warnings: identityVerdict.warnings,
        identityChecked: identityVerdict.action !== 'ungeprueft',
        leinwandVereinheitlicht,
        attempts,
      };
    } catch (err) {
      const code = err instanceof GeminiImageError ? err.code : 'UNKNOWN';
      attempts.push({ model, reason: `${code}: ${err.message}` });
    }
  }

  return { failed: true, attempts };
}

/**
 * Hauptweg.
 *
 * @returns {Promise<{images: Array, plan: Array, skipped: Array, evidence: Object,
 *                    report: Object, prompts: Object}>}
 */
async function generateImagesForProduct(product, options = {}) {
  if (!product?.id) throw new Error('Product ID is required');

  const startedAt = Date.now();
  const { referenceImage, maxVariants } = options;
  const candidates = collectReferenceCandidates(product, referenceImage);
  if (!candidates.length) {
    throw new Error('At least one real reference image is required');
  }

  const references = await loadReferences(candidates);
  if (!references.length) {
    throw new Error('Reference images could not be downloaded');
  }

  // --- ALLE Bilder analysieren: Ansichten UND was der Artikel ist -----------
  // Ein Vision-Call, zwei Antworten: welche Seite zeigt jedes Foto, und was ist
  // das ueberhaupt fuer ein Gegenstand / wie wird er benutzt. Letzteres traegt
  // die Anwendungsszenen — ohne es waeren sie geraten.
  const classification = await classifyViewpointParts(references.map((r) => r.part));
  const evidence = summarizeEvidence(classification);
  const produkt = classification?.produkt || null;

  // NUR-PIXELTREU: ausschliesslich Ansichten mit echtem Foto, keine
  // abgeleiteten, keine Szenen. Additiv, Voreinstellung aus — der
  // Galerie-Knopf verhaelt sich unveraendert.
  const nurPixeltreu = options.nurPixeltreu === true;
  const planned = planGalleryVariants(evidence, {
    studioAnzahl: studioCount(maxVariants),
    lifestyle: lifestyleGewuenscht(options),
    produkt,
    nurPixeltreu,
  });
  const plan = planned.plan;
  const skipped = planned.skipped;

  // --- Ansichten rendern (parallel, mit Gesamt-Zeitbudget) ------------------
  const images = [];
  const failures = [];
  const deadline = startedAt + totalBudgetMs();
  const kosten = neuerZaehler({ deckel: options.kostendeckelUsd });

  // Jeder Posten wird so bepreist, wie er tatsaechlich laufen wird: billige
  // Maske fuer Ansichten mit echtem Foto, voller Render fuer abgeleitete,
  // kleinerer Render fuer Szenen.
  const [erstesModell] = variantImageModelChain();
  const [erstesMaskenModell] = maskImageModelChain();
  const posten = plan.flatMap((entry) => {
    if (nurPixeltreu || (pixeltreuAktiv() && entry.art === 'studio' && entry.quelleIstEcht === true)) {
      return [{ model: erstesMaskenModell, imageSize: MASK_IMAGE_SIZE }];
    }
    const render = {
      model: erstesModell,
      imageSize: entry.art === 'lifestyle' ? LIFESTYLE_IMAGE_SIZE : VARIANT_IMAGE_SIZE,
    };
    // Eine ABGELEITETE Studio-Ansicht kostet Render UND Leinwand-Maske. Der
    // zweite Posten fehlte hier, obwohl er real gebucht wird — die Schaetzung
    // lag dadurch systematisch unter dem eigenen Schlimmstfall (gemessen:
    // geschaetzt 0,471-0,572, abgerechnet 0,573).
    if (entry.art === 'studio' && einheitlicheLeinwandAktiv()) {
      return [render, { model: erstesMaskenModell, imageSize: MASK_IMAGE_SIZE }];
    }
    return [render];
  });
  // Die Schaetzung ist eine SPANNE, keine Punktzahl. Der pixeltreue Weg kann an
  // den Composite-Wachen scheitern; dann kommt zur bezahlten Maske noch der
  // volle Render. Eine Punktschaetzung lag deshalb systematisch zu niedrig
  // (gemessen: geschaetzt 0,337, abgerechnet 0,505) — und eine Zahl, die
  // regelmaessig danebenliegt, liest bald niemand mehr.
  // Schlimmstfall: jede pixeltreu geplante Ansicht faellt auf den Render zurueck
  // (Maske ist bezahlt, Render kommt obendrauf) und bekommt dann ihrerseits eine
  // Leinwand-Maske.
  const postenSchlimmst = nurPixeltreu
    ? posten // ohne Render-Rueckfall gibt es keinen teureren Fall
    : posten.flatMap((p) =>
        p.model === erstesMaskenModell
          ? [p, { model: erstesModell, imageSize: VARIANT_IMAGE_SIZE }]
          : [p]
      );
  const bestenfalls = schaetzePosten(posten);
  const schlimmstenfalls = nurPixeltreu ? bestenfalls : schaetzePosten(postenSchlimmst);
  console.log(
    `[image-generation] ${product.id}: ${plan.length} Bilder geplant, ` +
      `geschaetzt ${bestenfalls.toFixed(3)}–${schlimmstenfalls.toFixed(3)} USD, ` +
      `Deckel ${kosten.deckel.toFixed(2)} USD`
  );

  const ergebnisse = await runLimited(
    plan.map((entry) => async () => {
      const sourceIndex = Math.min(Math.max(0, entry.sourceIndex || 0), references.length - 1);
      try {
        return {
          entry,
          sourceIndex,
          result: await renderOneView({ product, produktInfo: produkt, planEntry: entry, references, sourceIndex, deadline, kosten, ankerErlaubt: classification ? evidence.ankerIndexes : null, nurPixeltreu }),
        };
      } catch (err) {
        // Eine einzelne Ansicht darf den GANZEN Lauf nicht killen. renderOneView
        // faengt intern schon, aber der Prompt-Bau davor nicht — und ein 500er
        // haette den Bediener um alle uebrigen Ansichten gebracht.
        return {
          entry,
          sourceIndex,
          result: { failed: true, attempts: [{ model: '-', reason: `unerwartet: ${err.message}` }] },
        };
      }
    }),
    renderConcurrency(),
    deadline
  );

  for (let i = 0; i < ergebnisse.length; i += 1) {
    const eintragErgebnis = ergebnisse[i];
    const entry = plan[i];

    if (!eintragErgebnis || eintragErgebnis.zeitbudget) {
      failures.push({ viewpoint: entry.viewpoint, label: entry.label, reason: 'zeitbudget_erschoepft' });
      continue;
    }

    const { result, sourceIndex } = eintragErgebnis;

    if (result.failed) {
      failures.push({
        viewpoint: entry.viewpoint,
        label: entry.label,
        reason: 'erzeugung_fehlgeschlagen',
        attempts: result.attempts,
      });
      continue;
    }

    try {
      const dataUrl = `data:${result.mimeType};base64,${result.buffer.toString('base64')}`;
      const uploaded = await uploadBase64Image(dataUrl, product.id, entry.variant);
      const eintrag = {
        url_or_base64: uploaded.url,
        variant: entry.variant,
        viewpoint: entry.viewpoint,
        // 'studio' oder 'lifestyle' — die Oberflaeche und der Publish-Pfad
        // sollen eine Anwendungsszene von einem Packshot unterscheiden koennen.
        art: entry.art || 'studio',
        // true, wenn diese Ansicht auf einem ECHTEN Foto derselben Seite sitzt.
        // false heisst: aus dem vorhandenen Material ABGELEITET.
        ausEchtemFoto: entry.quelleIstEcht === true,
        source: 'generated',
        // EINDEUTIGE Kennzeichnung: hält das Bild aus der Referenzliste künftiger
        // Läufe heraus und macht es für den Publish-Pfad erkennbar.
        generatedByAi: true,
        derivedFrom: references[sourceIndex]?.image?.url_or_base64 || null,
        // Die Notiz muss sagen, WAS das Bild ist. Bis 2026-09-10 stand auf JEDER
        // gerenderten Ansicht "aus einem echten Foto" — auch auf den
        // abgeleiteten, die es gerade nicht sind, und auf Anwendungsszenen, die
        // gar keine Studio-Aufbereitung sind.
        notes: result.pixeltreu
          ? `${entry.label} aus ORIGINALPIXELN des echten Fotos freigestellt ` +
            `(Silhouette via ${result.model}, Kleindruck unveraendert)`
          : entry.art === 'lifestyle'
            ? `Anwendungsszene "${entry.label}", vom Modell erzeugt ` +
              `(${result.model}, ${result.referenceCount} Referenzfotos)`
            : entry.quelleIstEcht === true
              ? `Studio-Aufbereitung der ${entry.label} aus einem echten Foto ` +
                `(${result.model}, ${result.referenceCount} Referenzfotos)`
              : `${entry.label} ABGELEITET — es gibt kein Foto dieser Seite ` +
                `(${result.model}, ${result.referenceCount} Referenzfotos)`,
        identityChecked: result.identityChecked === true,
        // true = das Bild besteht aus den Pixeln des Referenzfotos; jede
        // Beschriftung darauf ist echt. false = vom Modell neu gezeichnet,
        // Kleindruck ist dort nur angenaehert.
        pixeltreu: result.pixeltreu === true,
        // true = Hintergrund, Fuellgrad und Kontaktschatten kommen aus der
        // deterministischen Stelle. Pixeltreue Bilder haben das bauartbedingt.
        einheitlicheLeinwand: result.pixeltreu === true || result.leinwandVereinheitlicht === true,
        width: uploaded.width || result.width || null,
        height: uploaded.height || result.height || null,
        mimeType: uploaded.mimeType || result.mimeType,
      };
      // KEIN `undefined` in das Objekt schreiben: es landet über details.images in
      // Firestore, und der Client läuft OHNE ignoreUndefinedProperties — ein
      // undefined-Feld lässt den gesamten Produkt-Schreibvorgang scheitern.
      if (result.warnings?.length) eintrag.warnings = result.warnings;
      images.push(eintrag);

      // Ein Bild, das ENTSTANDEN ist, dessen Leinwand aber nicht vereinheitlicht
      // werden konnte, faellt in der Galerie auf — bisher stand der Grund nur in
      // `attempts`, und die werden ausschliesslich im Fehlerfall gelesen. Der
      // Bediener sah eine abweichende Zahl und nicht, warum.
      if (entry.art === 'studio' && !eintrag.einheitlicheLeinwand) {
        const grund = (result.attempts || [])
          .map((a) => a.reason)
          .filter((r) => typeof r === 'string' && r.startsWith('leinwand'))
          .join(' · ');
        if (grund) {
          failures.push({
            viewpoint: entry.viewpoint,
            label: entry.label,
            reason: 'leinwand_nicht_vereinheitlicht',
            attempts: [{ model: '-', reason: grund }],
          });
        }
      }
    } catch (err) {
      failures.push({
        viewpoint: entry.viewpoint,
        label: entry.label,
        reason: `upload_fehlgeschlagen: ${err.message}`,
      });
    }
  }

  console.log(
    `[image-generation] ${product.id}: ${images.length} Bilder erzeugt, ` +
      `${kosten.anzahl} Bildaufrufe, ${kosten.usd.toFixed(3)} USD` +
      (kosten.erschoepft ? ' — KOSTENDECKEL ERREICHT' : '')
  );

  return {
    images,
    plan,
    skipped: [...skipped, ...failures],
    evidence: {
      belegt: evidence.belegt,
      belegtLabels: evidence.belegt.map((v) => VIEWPOINT_LABELS_DE[v] || v),
      referenceCount: references.length,
      classified: Boolean(classification),
      sameProductThroughout: classification?.sameProductThroughout !== false,
      // Was die Bildanalyse im Artikel erkannt hat — steuert die Szenen und
      // gehoert in den Bericht, damit der Bediener eine falsche Erkennung sieht.
      produkt: produkt
        ? { wasEsIst: produkt.wasEsIst, woBenutzt: produkt.woBenutzt, lifestyleSinnvoll: produkt.lifestyleSinnvoll }
        : null,
    },
    report: {
      mode: variantsMode(),
      requestedVariants: plan.length,
      producedVariants: images.length,
      kosten: kosten.bericht(),
      studioProduced: images.filter((i) => i.art === 'studio').length,
      lifestyleProduced: images.filter((i) => i.art === 'lifestyle').length,
      ausEchtemFoto: images.filter((i) => i.ausEchtemFoto).length,
      // Wie viele Bilder aus ORIGINALPIXELN bestehen und damit garantiert
      // echten Kleindruck tragen. Der Rest ist neu gezeichnet.
      pixeltreu: images.filter((i) => i.pixeltreu).length,
      // Wie viele Studio-Bilder dieselbe Leinwand tragen. Weicht die Zahl von
      // studioProduced ab, sieht der Bediener eine uneinheitliche Galerie.
      einheitlicheLeinwand: images.filter((i) => i.art === 'studio' && i.einheitlicheLeinwand).length,
      durationMs: Date.now() - startedAt,
    },
    // Rückwärtskompatibel: die Route reicht `prompts` an die Oberfläche durch.
    prompts: await generateVisualDescriptions(product),
  };
}

module.exports = {
  generateImagesForProduct,
  fetchImageAsDataUrl,
  isLikelyAiImage,
  collectReferenceCandidates,
  variantsMode,
  _internal: { preprocessReference, renderOneView, loadReferences },
};
