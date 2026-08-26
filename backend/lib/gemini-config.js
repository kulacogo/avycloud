// CommonJS. 2 Spaces. Single Quotes.
// Zentrale Konfigurations-Helfer für Gemini-Calls.
// Seit 2026-08-26 (Owner-Entscheid): Politik-Modell ist gemini-3.7-flash —
// die Konstanten hier sind nur noch FALLBACK-Eingaben, model-select.js
// normalisiert jeden Text-Modellnamen zentral (Notbremse MODEL_POLICY='gemini25').

const { resolveModel } = require('./model-select');

const DEFAULT_MODEL = 'gemini-2.5-pro';
const FLASH_MODEL = 'gemini-2.5-flash';
const IMAGE_MODEL = 'gemini-2.5-flash-image';

/**
 * Standard thinking-Config für Agentic Use Cases (Chat + Identify).
 * thinkingBudget (Token) ist die familienübergreifend sichere Syntax:
 * Gemini 2.5 kennt NUR thinkingBudget (thinkingLevel → 400), und
 * gemini-3.7-flash akzeptiert BEIDE Knöpfe (live gegen die echte API
 * gemessen am 26.08.2026: thinkingBudget 512 → 58 Denk-Tokens, thinkingLevel
 * low/medium/high ok, 'minimal' → 400). Deshalb bleibt thinkingBudget der
 * Default — er funktioniert auch unter der Notbremse MODEL_POLICY='gemini25'.
 * Die Budgets sind bewusst moderat: Denk-Tokens kosten Geld.
 * includeThoughts macht Thought-Parts im Response verfügbar (Frontend "Thinking…"-Panel).
 */
const THINKING_BUDGETS = { low: 1024, medium: 2048, high: 4096 };

function defaultThinkingConfig({ includeThoughts = true, level = 'high' } = {}) {
  const thinkingBudget = THINKING_BUDGETS[level] || THINKING_BUDGETS.high;
  return { thinkingBudget, includeThoughts };
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
 * Chat-Modell — läuft durch die zentrale Politik (heute: gemini-3.7-flash).
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
 * Identify-V4 Haupt-Modell (Multi-Stage Pipeline) — zentrale Politik.
 * Override via IDENTIFY_V4_MODEL ENV.
 */
function resolveIdentifyV4Model() {
  return resolveModel(process.env.IDENTIFY_V4_MODEL, 'IDENTIFY_V4_MODEL', DEFAULT_MODEL);
}

/**
 * Identify-V4 Image-Enhance-Modell (Hintergrund-Entfernung, Cleanup).
 * Default: IMAGE_MODEL. BILD-Modelle sind von der Text-Modellpolitik
 * AUSGENOMMEN (model-select normalisiert *-image/-tts/-live-Namen nie),
 * daher bewusst Direkt-Lookup statt resolveModel().
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
