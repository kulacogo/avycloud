// Modell-Politik seit 2026-08-01 (Owner-Entscheid: Kostenexplosion Gemini 3):
// ALLE Aufrufe laufen auf Gemini 2.5. Gemini-3-Namen (aus alten ENV-Pins,
// Firestore-Scopes oder Code-Literalen) werden hier ZENTRAL auf ihre
// 2.5-Entsprechung umgeleitet. Die frühere Alias-Falle (2.5 → 3.1) ist
// entfernt — 2.5-Namen laufen unverändert durch.
const PRO_MODEL = 'gemini-2.5-pro';
const FLASH_MODEL = 'gemini-2.5-flash';

const ALLOWED_MODELS = new Set([
  PRO_MODEL,
  FLASH_MODEL,
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-exp-1206',
  'gemini-1.5-pro-002',
]);

const MODEL_ALIASES = {
  mini: FLASH_MODEL,
  nano: FLASH_MODEL,
  standard: PRO_MODEL,
  default: PRO_MODEL,
  thinking: PRO_MODEL,
  flash: FLASH_MODEL,
  pro: PRO_MODEL,
  'gemini-flash': FLASH_MODEL,
  'gemini-thinking': PRO_MODEL,
  'gemini-pro': PRO_MODEL,
  // Gemini-3-Familie → 2.5-Entsprechung (Kosten-Downgrade, nicht entfernen:
  // Cloud-Run-ENVs und Firestore-Scopes können die alten Namen noch tragen)
  'gemini-3-pro': PRO_MODEL,
  'gemini-3-flash': FLASH_MODEL,
  'gemini-3-pro-preview': PRO_MODEL,
  'gemini-3-flash-preview': FLASH_MODEL,
  'gemini-3.1-pro-preview': PRO_MODEL,
  'gemini-3.1-pro-preview-customtools': PRO_MODEL,
  'gemini-3.1-flash-lite': FLASH_MODEL,
};

function normalize(input) {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

function normalizeModel(input) {
  const normalized = normalize(input);
  if (!normalized || normalized === 'default' || normalized === 'auto') {
    return null;
  }
  if (MODEL_ALIASES[normalized]) {
    return MODEL_ALIASES[normalized];
  }
  if (normalized && ALLOWED_MODELS.has(normalized)) {
    return normalized;
  }
  return null;
}

function resolveModel(preferred, envKey, fallback = PRO_MODEL) {
  const absoluteFallback = fallback || PRO_MODEL;
  const envRaw = process.env[envKey];
  const chain = [preferred, envRaw, absoluteFallback, PRO_MODEL];

  for (const candidate of chain) {
    const normalized = normalizeModel(candidate);
    if (normalized && ALLOWED_MODELS.has(normalized)) {
      return normalized;
    }
  }

  return PRO_MODEL;
}

module.exports = {
  resolveModel,
};
