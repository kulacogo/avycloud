// Modell-Politik seit 2026-08-26 (Owner-Entscheid: Umstieg auf gemini-3.7-flash):
// ALLE Text-Modellnamen (2.5-Pins aus Cloud-Run-ENVs, Gemini-3-Namen aus
// Firestore-Scopes oder Code-Literalen) werden hier ZENTRAL auf gemini-3.7-flash
// geleitet. Live gegen die echte API verifiziert (26.08.2026, Prod-Key):
//   - googleSearch + urlContext + functionDeclarations kombiniert funktioniert
//     (verlangt toolConfig.includeServerSideToolInvocations=true, sonst 400)
//   - googleSearch + responseJsonSchema (JSON-Zwang) funktioniert
//   - thinkingBudget UND thinkingLevel (low|medium|high) werden akzeptiert;
//     thinkingLevel 'minimal' nicht, Thinking ist NICHT komplett abschaltbar
// NOTBREMSE: MODEL_POLICY='gemini25' (getrimmt + case-insensitiv — BEWUSST
// grosszuegiger als die AUTO_INVOICE-Klasse: eine BREMSE soll auch mit
// 'Gemini25' greifen, sie kann nur das aeltere/sichere Verhalten herstellen,
// nie etwas Teures einschalten; jeder ANDERE Wert schaltet NICHTS) stellt die
// vorherige 2.5-Politik wieder her; supportsToolContextCirculation() kippt dann
// automatisch mit, damit Chat-V3/Ein-Request-V2/Agentic konsistent zurueckfallen
// (Split-Modus, JSON-Strip, Agentic-Sperre).
// WICHTIG: Die Alias-Tabellen sind EXPLIZITE Listen, NIE Catch-All-Regexe —
// Bild-/TTS-/Live-Modelle ('gemini-3-pro-image-preview', 'gemini-2.5-flash-image',
// '*-tts*', '*-live*') duerfen hier niemals auf ein Textmodell gemappt werden.
const PRIMARY_TEXT_MODEL = 'gemini-3.7-flash';
const LEGACY_PRO_MODEL = 'gemini-2.5-pro';
const LEGACY_FLASH_MODEL = 'gemini-2.5-flash';

function legacyPolicyActive() {
  return (process.env.MODEL_POLICY || '').toString().trim().toLowerCase() === 'gemini25';
}

// Gemeinsame Kurz-Aliase (Bedeutung haengt von der aktiven Politik ab).
const GENERIC_ALIASES = [
  'mini',
  'nano',
  'standard',
  'thinking',
  'flash',
  'pro',
  'gemini-flash',
  'gemini-thinking',
  'gemini-pro',
];

// Alle bekannten Gemini-3-TEXT-Namen (aus alten ENV-Pins, Firestore-Scopes,
// Code-Literalen). Bewusst OHNE *-image/-tts/-live-Varianten.
const GEMINI3_TEXT_NAMES = [
  'gemini-3-pro',
  'gemini-3-flash',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
];

// Aeltere erlaubte Experimental-/Legacy-Textnamen aus der 2.5-Aera.
const LEGACY_EXTRA_TEXT_NAMES = [
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-exp-1206',
  'gemini-1.5-pro-002',
];

function buildPolicy() {
  if (legacyPolicyActive()) {
    // Exakt die Politik vom 2026-08-01 (Kosten-Downgrade auf 2.5).
    const aliases = {
      mini: LEGACY_FLASH_MODEL,
      nano: LEGACY_FLASH_MODEL,
      standard: LEGACY_PRO_MODEL,
      thinking: LEGACY_PRO_MODEL,
      flash: LEGACY_FLASH_MODEL,
      pro: LEGACY_PRO_MODEL,
      'gemini-flash': LEGACY_FLASH_MODEL,
      'gemini-thinking': LEGACY_PRO_MODEL,
      'gemini-pro': LEGACY_PRO_MODEL,
      'gemini-3-pro': LEGACY_PRO_MODEL,
      'gemini-3-flash': LEGACY_FLASH_MODEL,
      'gemini-3-pro-preview': LEGACY_PRO_MODEL,
      'gemini-3-flash-preview': LEGACY_FLASH_MODEL,
      'gemini-3.1-pro-preview': LEGACY_PRO_MODEL,
      'gemini-3.1-pro-preview-customtools': LEGACY_PRO_MODEL,
      'gemini-3.1-flash-lite': LEGACY_FLASH_MODEL,
      'gemini-3.5-flash': LEGACY_FLASH_MODEL,
      'gemini-3.5-flash-lite': LEGACY_FLASH_MODEL,
      'gemini-3.6-flash': LEGACY_FLASH_MODEL,
      'gemini-3.7-flash': LEGACY_FLASH_MODEL,
    };
    const allowed = new Set([LEGACY_PRO_MODEL, LEGACY_FLASH_MODEL, ...LEGACY_EXTRA_TEXT_NAMES]);
    return { aliases, allowed, absoluteFallback: LEGACY_PRO_MODEL };
  }

  // Standard-Politik: EIN Textmodell fuer alles.
  const aliases = {};
  for (const name of GENERIC_ALIASES) aliases[name] = PRIMARY_TEXT_MODEL;
  for (const name of GEMINI3_TEXT_NAMES) aliases[name] = PRIMARY_TEXT_MODEL;
  for (const name of LEGACY_EXTRA_TEXT_NAMES) aliases[name] = PRIMARY_TEXT_MODEL;
  aliases[LEGACY_PRO_MODEL] = PRIMARY_TEXT_MODEL;
  aliases[LEGACY_FLASH_MODEL] = PRIMARY_TEXT_MODEL;
  const allowed = new Set([PRIMARY_TEXT_MODEL]);
  return { aliases, allowed, absoluteFallback: PRIMARY_TEXT_MODEL };
}

function normalize(input) {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

// Bild-/Audio-/Live-Modelle sind KEINE Textmodelle und werden von dieser
// Politik grundsaetzlich nicht angefasst (sie loesen hier zu null auf und
// duerfen resolveModel gar nicht erst erreichen — ihre Aufrufer machen
// bewusst Direkt-Lookups, siehe gemini-config.resolveImageEnhanceModel).
function isNonTextModelName(normalized) {
  return /-(image|tts|live)\b|-image-|-tts-|-live-/.test(normalized) || normalized.endsWith('-image');
}

function normalizeModel(input) {
  const normalized = normalize(input);
  if (!normalized || normalized === 'default' || normalized === 'auto') {
    return null;
  }
  if (isNonTextModelName(normalized)) {
    return null;
  }
  const { aliases, allowed } = buildPolicy();
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  if (allowed.has(normalized)) {
    return normalized;
  }
  return null;
}

function resolveModel(preferred, envKey, fallback = null) {
  const { allowed, absoluteFallback } = buildPolicy();
  const envRaw = process.env[envKey];
  const chain = [preferred, envRaw, fallback, absoluteFallback];

  for (const candidate of chain) {
    const normalized = normalizeModel(candidate);
    if (normalized && allowed.has(normalized)) {
      return normalized;
    }
  }

  return absoluteFallback;
}

/**
 * EINE Quelle fuer die Frage "kann das Modell Server-Tools (googleSearch/
 * urlContext) mit Custom-Functions und erzwungenem JSON kombinieren?"
 * (Lehre aus CLAUDE.md Punkt 16c: eine Quelle statt vier handgepflegter
 * String-Checks in gemini3-client/product-chat-v2/product-chat-v3/stage3-agentic.)
 * Unter der Notbremse MODEL_POLICY='gemini25' loesen alle Namen zu 2.5 auf
 * und diese Funktion liefert automatisch false — Split-Modus, JSON-Strip und
 * Agentic-Sperre kehren konsistent zurueck.
 */
function supportsToolContextCirculation(modelName) {
  const normalized = normalize(modelName);
  if (!normalized || isNonTextModelName(normalized)) return false;
  return normalized.startsWith('gemini-3') || normalized.includes('customtools');
}

module.exports = {
  resolveModel,
  supportsToolContextCirculation,
  PRIMARY_TEXT_MODEL,
};
