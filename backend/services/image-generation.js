'use strict';

/* eslint-disable no-console */

/**
 * image-generation.js — Studio-Aufbereitung ECHTER Produktansichten.
 *
 * ============================================================================
 * UMBAU 2026-09-02 — Beschwerde: "erzeugt keine sauberen originalgetreuen
 * Produktbilder aus verschiedenen Perspektiven".
 *
 * Die Ursache war keine Prompt-Schwäche, sondern der Auftrag selbst. Der Dienst
 * verlangte vier feste Perspektiven — 3/4-Front, 45-Grad-Seite, Makro-Detail und
 * RÜCKANSICHT — und schickte dem Modell dazu genau EIN Foto: er sammelte bis zu
 * vier echte Bilder, lud alle herunter und benutzte davon `referenceDataUrls[0]`.
 * Drei der vier verlangten Ansichten hatte nie jemand fotografiert. Das Modell
 * konnte sie nicht reproduzieren, es konnte sie nur erfinden.
 *
 * Belegt und nicht verhandelbar:
 *   - Novel-View-Synthesis aus einem Bild ist mathematisch unterbestimmt; ab etwa
 *     60 Grad Blickwinkeländerung ist praktisch das gesamte Zielbild erfunden.
 *     Kein Modellwechsel und kein Prompt heilt das.
 *   - eBay-Bildrichtlinie: "Photos that don't accurately represent the item" sind
 *     verboten; zu den eigenen KI-Werkzeugen schreibt eBay ausdrücklich "using
 *     these tools to alter a product in any way is against eBay's policies".
 *     Die Nutzungsvereinbarung nennt generative KI beim Namen und weist die
 *     Verantwortung dem Verkäufer zu.
 *   - Kaufland-Guideline verlangt FOTOS und verbietet Collagen/Montagen.
 *   - TrendOcean verkauft Gebrauchtware aus Auktionslosen — dort verbietet eBay
 *     schon das echte Herstellerfoto. Ein erfundenes ist erst recht unzulässig.
 *
 * DIE NEUE AUFGABE: nicht Perspektiven erfinden, sondern die VORHANDENEN
 * Perspektiven sauber machen. Der Bediener fotografiert Vorderseite, Rückseite,
 * Typenschild — und bekommt genau diese Ansichten als saubere Packshots zurück,
 * Produkt pixelgetreu, nur Hintergrund und Licht ersetzt. Das ist exakt die
 * Klasse, die eBay mit seinem eigenen "Background Swap" vorlebt.
 * Fehlt eine Ansicht, entsteht sie NICHT — sie wird mit Begründung gemeldet.
 *
 * Kette je Ansicht: Modellkette (Qualität → schnell) → Ergebnisprüfung →
 * Identitäts-Zweitmeinung → Upload. Scheitert alles, fehlt die Ansicht ehrlich.
 * ============================================================================
 */

const sharp = require('sharp');
const { generateProductImagesWithReport, GeminiImageError } = require('../lib/vertex-ai');
const { uploadBase64Image } = require('../lib/storage');
const { buildViewPrompt, generateVisualDescriptions } = require('./prompt-engine');
const { fetchWithUnlocker } = require('../lib/web-unlocker');
const {
  classifyViewpointParts,
  summarizeEvidence,
  planFaithfulVariants,
  VIEWPOINT_LABELS_DE,
} = require('../lib/image-viewpoint');
const {
  validateGeneratedImage,
  judgeProductIdentity,
  classifyIdentityVerdict,
} = require('../lib/image-result-check');
const { variantImageModelChain, maxObjectReferences } = require('../lib/gemini-image-models');

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
 * Erzeugt EINE Ansicht: Vorlage zuerst, übrige Fotos als Identitätsanker.
 * Läuft die Modellkette durch, ohne ein gültiges Ergebnis, wird nichts geliefert.
 */
async function renderOneView({ product, planEntry, references, sourceIndex, deadline }) {
  const chain = variantImageModelChain();
  const attempts = [];

  // NUR DIE VORLAGE (Korrektur 2026-09-04, Betreiber: "Produkt weicht vom
  // Original ab"). Bis dahin gingen ALLE geladenen Fotos als "Identitaetsanker"
  // mit — bis zu sechs Bilder fuer EINE Ansicht. Das Modell mischte sie, obwohl
  // der Prompt es verbot, und das Ergebnis zeigte ein Produkt, das keinem der
  // Fotos entsprach.
  //
  // Der Denkfehler: Anker helfen, wenn eine Ansicht ERFUNDEN werden muss. Seit
  // der Umstellung wird jede Ansicht aus GENAU EINEM echten Foto aufbereitet —
  // alles Noetige steckt darin. Weitere Bilder koennen nur Drift erzeugen.
  const ankerErlaubt = String(process.env.VARIANT_SIBLING_ANCHORS || '').trim() === 'on';
  const ordered = ankerErlaubt
    ? [references[sourceIndex], ...references.filter((_, i) => i !== sourceIndex)].filter(Boolean)
    : [references[sourceIndex]].filter(Boolean);

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

    const limit = Math.max(1, maxObjectReferences(model));
    const used = ordered.slice(0, limit);
    const prompt = buildViewPrompt(product, planEntry, used.length);

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
        imageSize: VARIANT_IMAGE_SIZE,
        // Die MODELLKETTE ist bereits die Wiederholung. Zusaetzlich drei
        // Versuche je Modell ergaeben bis zu sechs bezahlte Bildaufrufe pro
        // Ansicht — und dieselbe Vervielfachung im Studio-Pfad.
        maxAttempts: 1,
      });

      const candidate = report.images?.[0];
      if (!candidate?.base64) {
        attempts.push({ model, reason: 'kein_bild_in_antwort' });
        continue;
      }

      const buffer = Buffer.from(candidate.base64, 'base64');
      const verdict = await validateGeneratedImage(buffer);
      if (!verdict.ok) {
        attempts.push({ model, reason: verdict.reason });
        continue;
      }

      // Zweitmeinung: zeigt das Ergebnis noch denselben Artikel?
      const identity = await judgeProductIdentity(used.map((r) => r.part), {
        data: candidate.base64,
        mimeType: candidate.mimeType || 'image/png',
      });
      const identityVerdict = classifyIdentityVerdict(identity);
      if (identityVerdict.action === 'verwerfen') {
        attempts.push({
          model,
          reason: `identitaet_abweichend: ${identityVerdict.warnings.join('; ') || 'anderer Artikel'}`,
        });
        continue;
      }

      return {
        buffer,
        mimeType: candidate.mimeType || 'image/png',
        model: report.model || model,
        width: verdict.width,
        height: verdict.height,
        referenceCount: used.length,
        warnings: identityVerdict.warnings,
        identityChecked: identityVerdict.action !== 'ungeprueft',
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

  // --- Beleg-Bilanz: welche Ansichten sind FOTOGRAFIERT? ---------------------
  const classification = await classifyViewpointParts(references.map((r) => r.part));
  const evidence = summarizeEvidence(classification);

  let plan;
  let skipped;
  if (!evidence.belegt.length) {
    // Kein Urteil möglich (Klassifikation gescheitert oder alle Fotos unklar).
    // Fail-closed für das Erfinden, fail-open für den Nutzen: die vom Bediener
    // GEWÄHLTE Vorlage wird aufbereitet, aber keine weitere Ansicht erfunden.
    plan = [
      {
        viewpoint: 'unclear',
        label: 'Gewähltes Foto',
        sourceIndex: 0,
        confidence: 0,
        variant: 'studio_source',
      },
    ];
    skipped = [
      { viewpoint: 'alle_weiteren', label: 'Weitere Ansichten', reason: 'keine_ansichtserkennung' },
    ];
  } else {
    const planned = planFaithfulVariants(evidence, {
      maxVariants: Number.isInteger(maxVariants) && maxVariants > 0 ? maxVariants : 4,
    });
    plan = planned.plan;
    skipped = planned.skipped;
  }

  // --- Ansichten rendern (parallel, mit Gesamt-Zeitbudget) ------------------
  const images = [];
  const failures = [];
  const deadline = startedAt + totalBudgetMs();

  const ergebnisse = await runLimited(
    plan.map((entry) => async () => {
      const sourceIndex = Math.min(Math.max(0, entry.sourceIndex || 0), references.length - 1);
      try {
        return {
          entry,
          sourceIndex,
          result: await renderOneView({ product, planEntry: entry, references, sourceIndex, deadline }),
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
        source: 'generated',
        // EINDEUTIGE Kennzeichnung: hält das Bild aus der Referenzliste künftiger
        // Läufe heraus und macht es für den Publish-Pfad erkennbar.
        generatedByAi: true,
        derivedFrom: references[sourceIndex]?.image?.url_or_base64 || null,
        notes:
          `Studio-Aufbereitung der ${entry.label} aus einem echten Foto ` +
          `(${result.model}, ${result.referenceCount} Referenzbilder)`,
        identityChecked: result.identityChecked === true,
        width: uploaded.width || result.width || null,
        height: uploaded.height || result.height || null,
        mimeType: uploaded.mimeType || result.mimeType,
      };
      // KEIN `undefined` in das Objekt schreiben: es landet über details.images in
      // Firestore, und der Client läuft OHNE ignoreUndefinedProperties — ein
      // undefined-Feld lässt den gesamten Produkt-Schreibvorgang scheitern.
      if (result.warnings?.length) eintrag.warnings = result.warnings;
      images.push(eintrag);
    } catch (err) {
      failures.push({
        viewpoint: entry.viewpoint,
        label: entry.label,
        reason: `upload_fehlgeschlagen: ${err.message}`,
      });
    }
  }

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
    },
    report: {
      mode: variantsMode(),
      requestedVariants: plan.length,
      producedVariants: images.length,
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
