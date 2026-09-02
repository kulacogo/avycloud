'use strict';

/**
 * vertex-ai.js — Anbindung an die Gemini-Bilderzeugung.
 *
 * UMBAU 2026-09-02. Vorher konnte diese Datei baulich nur EIN Referenzbild
 * transportieren (`referenceImageBase64`, Einzahl, ein inline_data-Part). Das war
 * die eigentliche Ursache dafür, dass erzeugte Perspektiven nicht originalgetreu
 * waren: der Aufrufer sammelte bis zu vier echte Produktfotos und konnte davon nur
 * eines abliefern — die restlichen Ansichten musste das Modell zwangsläufig erfinden.
 *
 * Die Gemini-API nimmt mehrere Bilder als mehrere inline_data-Parts in EINEM
 * contents[0].parts-Array entgegen; die Reihenfolge ist die Sehreihenfolge des
 * Modells. Dokumentierte Obergrenzen sind ROLLENBEZOGEN (Objekte/Personen/Stil)
 * und stehen in `lib/gemini-image-models.js`.
 *
 * Weiter behoben:
 *   - Eine Weigerung des Modells war unsichtbar. finishReason, promptFeedback und
 *     der Text-Anteil der Antwort wurden nie gelesen; ein blockierter Request kam
 *     als leeres Array zurück und der Aufrufer meldete stumm "keine Bilder".
 *   - Kein Timeout (Default war 0 = unbegrenzt) und keine Wiederholung bei 429/503.
 *   - `imageConfig.imageSize` wurde nie gesetzt — jedes Bild kam in 1K zurück,
 *     obwohl eBay die Zoomlupe erst ab 1.600 px freischaltet.
 *   - Modellname und API-Schlüssel wurden zur require-Zeit eingefroren.
 */

const {
  resolveImageModel,
  DEFAULT_QUALITY_MODEL,
  resolveImageSize,
} = require('./gemini-image-models');

const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// ENV zur LAUFZEIT lesen, nicht zur require-Zeit: Cloud Run kann Variablen ohne
// Neustart ändern, und Tests setzen sie nach dem require.
function apiKey() {
  return process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
}

function defaultModel() {
  return resolveImageModel(process.env.GEMINI_IMAGE_MODEL, DEFAULT_QUALITY_MODEL);
}

function buildEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function extractBase64Payload(dataUrl = '') {
  if (!dataUrl) return null;
  const dataUrlMatch = dataUrl.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
  if (dataUrlMatch?.groups?.data) {
    return {
      mimeType: dataUrlMatch.groups.mime || 'image/png',
      data: dataUrlMatch.groups.data,
    };
  }
  // Plain base64 ohne Schema.
  const stripped = dataUrl.trim();
  if (/^[a-z0-9+/]+=*$/i.test(stripped)) {
    return { mimeType: null, data: stripped };
  }
  return null;
}

function ensureGeminiConfig() {
  if (!apiKey()) {
    throw new Error('GEMINI_API_KEY (or GOOGLE_GENAI_API_KEY) is not configured');
  }
}

function normalizeInlineData(part = {}) {
  const inline = part.inlineData || part.inline_data;
  if (!inline?.data) return null;
  return {
    base64: inline.data,
    mimeType: inline.mimeType || inline.mime_type || 'image/png',
  };
}

/**
 * Fehler mit maschinenlesbarer Klasse. Der Aufrufer soll "das Modell hat sich
 * geweigert" von "das Netz war weg" unterscheiden können — ohne das sind beide
 * Fälle nur "keine Bilder" und keiner davon wird je behoben.
 */
class GeminiImageError extends Error {
  constructor(message, { code, status = null, retryable = false, detail = null } = {}) {
    super(message);
    this.name = 'GeminiImageError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/**
 * Liest aus einer Antwort OHNE Bildanteil heraus, WARUM sie keines enthält.
 * Die API signalisiert das auf drei verschiedenen Wegen, je nach Ursache.
 */
function describeMissingImage(data) {
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    return {
      code: 'PROMPT_BLOCKED',
      message: `Gemini hat den Prompt blockiert (${blockReason})`,
      detail: data.promptFeedback,
    };
  }

  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const finishReason = candidate?.finishReason;
  const texts = (candidate?.content?.parts || [])
    .map((p) => (typeof p?.text === 'string' ? p.text.trim() : ''))
    .filter(Boolean);
  const spoken = texts.join(' ').slice(0, 400);

  if (finishReason && finishReason !== 'STOP') {
    return {
      code: `FINISH_${finishReason}`,
      message: spoken
        ? `Gemini lieferte kein Bild (${finishReason}): ${spoken}`
        : `Gemini lieferte kein Bild (${finishReason})`,
      detail: { finishReason, safetyRatings: candidate?.safetyRatings || null },
    };
  }

  if (spoken) {
    // Das Modell hat geantwortet — mit Worten statt mit einem Bild. Das ist die
    // häufigste stille Weigerung und war bisher komplett unsichtbar.
    return {
      code: 'TEXT_INSTEAD_OF_IMAGE',
      message: `Gemini antwortete mit Text statt mit einem Bild: ${spoken}`,
      detail: { finishReason: finishReason || null },
    };
  }

  return {
    code: 'NO_IMAGE',
    message: 'Gemini lieferte kein Bild und keine Begründung',
    detail: { finishReason: finishReason || null },
  };
}

async function callGeminiGenerateContent({ parts, aspectRatio, model, timeoutMs, imageSize }) {
  ensureGeminiConfig();
  const activeModel = resolveImageModel(model || defaultModel());
  const params = new URLSearchParams({ key: apiKey() });
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };

  const imageConfig = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  const size = resolveImageSize(activeModel, imageSize);
  if (size) imageConfig.imageSize = size;
  if (Object.keys(imageConfig).length) {
    body.generationConfig.imageConfig = imageConfig;
  }

  const effectiveTimeout = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  // Der Timeout muss AUCH das Lesen des Antwort-Bodys bewachen: ein Bild sind
  // mehrere MB Base64, und die kommen erst nach den Headern. Ein Timer, der nur
  // fetch() umschliesst, lässt genau diese Phase unbewacht hängen.
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    let response;
    try {
      response = await fetch(`${buildEndpoint(activeModel)}?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new GeminiImageError(
          `Gemini-Bildaufruf nach ${effectiveTimeout} ms abgebrochen (${activeModel})`,
          { code: 'TIMEOUT', retryable: true }
        );
      }
      throw new GeminiImageError(`Gemini-Bildaufruf fehlgeschlagen: ${err.message}`, {
        code: 'NETWORK',
        retryable: true,
      });
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      let reason = errorText;
      try {
        const parsed = JSON.parse(errorText);
        reason = parsed.error?.message || JSON.stringify(parsed.error) || reason;
      } catch {
        // Rohtext behalten.
      }
      throw new GeminiImageError(
        `Gemini image API failed (${response.status}): ${reason}`,
        {
          code: `HTTP_${response.status}`,
          status: response.status,
          retryable: RETRYABLE_STATUS.has(response.status),
        }
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new GeminiImageError(
          `Gemini-Antwort nach ${effectiveTimeout} ms abgebrochen (${activeModel})`,
          { code: 'TIMEOUT', retryable: true }
        );
      }
      throw new GeminiImageError(`Gemini-Antwort unlesbar: ${err.message}`, {
        code: 'BAD_RESPONSE',
        retryable: true,
      });
    }

    if (!Array.isArray(data?.candidates)) {
      const why = describeMissingImage(data);
      throw new GeminiImageError(why.message, { code: why.code, detail: why.detail });
    }

    const images = [];
    for (const candidate of data.candidates) {
      for (const part of candidate?.content?.parts || []) {
        const normalized = normalizeInlineData(part);
        if (normalized) images.push(normalized);
      }
    }

    if (!images.length) {
      const why = describeMissingImage(data);
      throw new GeminiImageError(why.message, { code: why.code, detail: why.detail });
    }

    return { images, model: activeModel };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Baut das parts-Array. Referenzbilder ZUERST, Text zuletzt: die Reihenfolge ist
 * die Sehreihenfolge des Modells, und der Text bezieht sich auf die davor
 * gezeigten Bilder ("Bild 1 zeigt …").
 */
function buildParts({ prompt, references }) {
  const parts = [];
  for (const ref of references) {
    const payload = extractBase64Payload(ref);
    if (!payload?.data) {
      throw new GeminiImageError('Invalid reference image payload provided', {
        code: 'BAD_REFERENCE',
      });
    }
    parts.push({
      inline_data: {
        mime_type: payload.mimeType || 'image/png',
        data: payload.data,
      },
    });
  }
  parts.push({ text: prompt.trim() });
  return parts;
}

function collectReferences({ referenceImages, referenceImageBase64 }) {
  const list = [];
  if (Array.isArray(referenceImages)) {
    for (const entry of referenceImages) {
      if (typeof entry === 'string' && entry.trim()) list.push(entry);
    }
  }
  // Rückwärtskompatibel: der alte Einzelparameter zählt weiter, aber nur wenn er
  // nicht ohnehin schon in der Liste steht.
  if (typeof referenceImageBase64 === 'string' && referenceImageBase64.trim()) {
    if (!list.includes(referenceImageBase64)) list.unshift(referenceImageBase64);
  }
  return list;
}

/**
 * Erzeugt Bilder und liefert einen VOLLSTÄNDIGEN Bericht — auch über Fehlschläge.
 * Der Aufrufer soll dem Bediener sagen können, warum eine Ansicht fehlt.
 *
 * @returns {Promise<{images: Array, model: string, attempts: Array, referenceCount: number}>}
 */
async function generateProductImagesWithReport({
  prompt,
  count = 1,
  aspectRatio = '1:1',
  referenceImageBase64 = null,
  referenceImages = null,
  model = null,
  timeoutMs = 0,
  imageSize = null,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (!prompt?.trim()) {
    throw new GeminiImageError('Prompt is required for Gemini image generation', {
      code: 'NO_PROMPT',
    });
  }

  const references = collectReferences({ referenceImages, referenceImageBase64 });
  const parts = buildParts({ prompt, references });
  const attempts = [];
  const results = [];
  let usedModel = resolveImageModel(model || defaultModel());
  let lastError = null;

  const budget = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= budget && results.length < count; attempt += 1) {
    try {
      const batch = await callGeminiGenerateContent({
        parts,
        aspectRatio,
        model,
        timeoutMs,
        imageSize,
      });
      usedModel = batch.model;
      results.push(...batch.images);
      attempts.push({ attempt, model: batch.model, ok: true, images: batch.images.length });
    } catch (err) {
      lastError = err;
      attempts.push({
        attempt,
        model: usedModel,
        ok: false,
        code: err.code || 'UNKNOWN',
        reason: err.message,
      });
      if (!err.retryable || attempt >= budget) break;
      // Exponentiell, klein gehalten: der Aufrufer hat selbst ein Zeitbudget.
      await sleep(Math.min(4000, 500 * 2 ** (attempt - 1)));
    }
  }

  if (!results.length && lastError) throw lastError;

  return {
    images: results.slice(0, count),
    model: usedModel,
    attempts,
    referenceCount: references.length,
  };
}

/**
 * Rückwärtskompatible Fassade: liefert weiterhin ein reines Array.
 * Bestehende Aufrufer (services/image-studio.js) bleiben unverändert lauffähig.
 */
async function generateProductImages(options) {
  const report = await generateProductImagesWithReport(options);
  return report.images;
}

module.exports = {
  generateProductImages,
  generateProductImagesWithReport,
  GeminiImageError,
  _internal: { describeMissingImage, collectReferences, buildParts },
};
