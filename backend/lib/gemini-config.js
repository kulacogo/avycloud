// CommonJS. 2 Spaces. Single Quotes.
// Zentrale Konfigurations-Helfer für Gemini 3 Pro / 3.1 Pro Calls.

const { resolveModel } = require('./model-select');

const DEFAULT_MODEL = 'gemini-3.1-pro-preview-customtools';
const FLASH_MODEL = 'gemini-3-flash-preview';
const IMAGE_MODEL = 'gemini-3-pro-image-preview';

/**
 * Standard thinking-Config für Agentic Use Cases (Chat + Identify).
 * Gemini 3 Pro benötigt HIGH für tiefe Recherche.
 * includeThoughts macht Thought-Parts im Response verfügbar (Frontend "Thinking…"-Panel).
 */
function defaultThinkingConfig({ includeThoughts = true, level = 'high' } = {}) {
  return { thinkingLevel: level, includeThoughts };
}

/**
 * Gemini 3 empfiehlt explizit Temperature 1.0 für agentic chat.
 * Niedrigere Temp (0.2-0.5) triggert Looping.
 */
const DEFAULT_CHAT_TEMPERATURE = 1.0;

/**
 * Für strenge Structured-Output-Calls (identify-v3 Stage 3) wo JSON schema erzwungen wird.
 */
const DEFAULT_STRUCTURED_TEMPERATURE = 0.4;

/**
 * Standard-Safety-Settings: nur hate/harassment auf medium, Rest niedrig.
 * E-Commerce-Produktrecherche ist meist unproblematisch.
 */
function defaultSafetySettings() {
  return [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  ];
}

/**
 * Per-Part Media Resolution für Bilder. ULTRA_HIGH für Etiketten/OCR.
 */
const MEDIA_RESOLUTION = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  ULTRA_HIGH: 'ULTRA_HIGH',
});

/**
 * Baut ein Standard-Generation-Config-Objekt für den @google/genai SDK.
 * Kompatibel mit ai.models.generateContent + ai.chats.create.
 */
function buildGenerationConfig(overrides = {}) {
  return {
    temperature: DEFAULT_CHAT_TEMPERATURE,
    maxOutputTokens: 8192,
    ...overrides,
  };
}

/**
 * Prüft via ENV ob wir auf customtools-Variant (stabileres function calling) gehen.
 * Fallback: gemini-3.1-pro-preview (kein -customtools).
 */
function resolveChatModel() {
  const envKey = process.env.CHAT_MODEL;
  return resolveModel(envKey, 'CHAT_MODEL', DEFAULT_MODEL);
}

function resolveIdentifyModel() {
  const envKey = process.env.IDENTIFY_MODEL;
  return resolveModel(envKey, 'IDENTIFY_MODEL', DEFAULT_MODEL);
}

function resolveIntentModel() {
  const envKey = process.env.INTENT_MODEL;
  return resolveModel(envKey, 'INTENT_MODEL', FLASH_MODEL);
}

/**
 * Identify-V4 Haupt-Modell (Multi-Stage Pipeline).
 * Default: DEFAULT_MODEL (gemini-3.1-pro-preview-customtools).
 * Override via IDENTIFY_V4_MODEL ENV.
 */
function resolveIdentifyV4Model() {
  return resolveModel(process.env.IDENTIFY_V4_MODEL, 'IDENTIFY_V4_MODEL', DEFAULT_MODEL);
}

/**
 * Identify-V4 Image-Enhance-Modell (Hintergrund-Entfernung, Cleanup).
 * Default: IMAGE_MODEL (gemini-3-pro-image-preview). Das Image-Modell steht
 * nicht in ALLOWED_MODELS von model-select.js (bewusst — es ist ein Spezial-
 * Modell), daher kurzer Direkt-Lookup statt resolveModel().
 * Override via IDENTIFY_V4_IMAGE_MODEL ENV.
 */
function resolveImageEnhanceModel() {
  const raw = process.env.IDENTIFY_V4_IMAGE_MODEL;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim();
  }
  return IMAGE_MODEL;
}

module.exports = {
  DEFAULT_MODEL,
  FLASH_MODEL,
  IMAGE_MODEL,
  DEFAULT_CHAT_TEMPERATURE,
  DEFAULT_STRUCTURED_TEMPERATURE,
  MEDIA_RESOLUTION,
  defaultThinkingConfig,
  defaultSafetySettings,
  buildGenerationConfig,
  resolveChatModel,
  resolveIdentifyModel,
  resolveIntentModel,
  resolveIdentifyV4Model,
  resolveImageEnhanceModel,
};
