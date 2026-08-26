/**
 * Modell-Politik seit 2026-08-26 (Owner-Entscheid: Umstieg auf gemini-3.7-flash):
 * ALLE Text-Modellnamen loesen zentral auf 'gemini-3.7-flash' auf — 2.5-Pins aus
 * Cloud-Run-ENVs, Gemini-3/3.1/3.5/3.6-Namen aus Firestore-Scopes oder
 * Code-Literalen, Kurz-Aliase und Garbage gleichermassen.
 *
 * WICHTIG: Die fruehere Invariante vom 2026-08-01 ("nie 2.5 → 3.x aliasen",
 * Kosten-Downgrade) ist mit dem Owner-Entscheid 2026-08-26 BEWUSST AUFGEHOBEN.
 * Die neue Spiegel-Invariante lautet: unter der Default-Politik loest KEIN
 * Input je auf ein gemini-2.5-Textmodell auf.
 *
 * NOTBREMSE: MODEL_POLICY='gemini25' stellt die alte 2.5-Politik wieder her
 * (3.x-Namen → 2.5-Entsprechung, absoluter Fallback gemini-2.5-pro). Der Wert
 * wird im Code getrimmt+lowercased — 'GEMINI25' und ' gemini25 ' schalten also
 * AUCH (hier so getestet, wie es implementiert ist). Muell-Werte ('true', '1',
 * 'on', '') schalten NICHT.
 *
 * BILD-/TTS-/LIVE-GUARD: *-image/-tts/-live-Namen sind KEINE Textmodelle.
 * normalizeModel() loest sie zu null auf (nicht exportiert — hier ueber
 * resolveModel() getestet): egal an welcher Position der Kette (preferred,
 * ENV, fallback), sie fallen auf den absoluten Politik-Fallback durch und
 * werden NIE selbst zurueckgegeben und NIE auf 3.7 "normalisiert".
 */
const {
  resolveModel,
  supportsToolContextCirculation,
  PRIMARY_TEXT_MODEL,
} = require('../lib/model-select');

const POLICY_MODEL = 'gemini-3.7-flash';

// Jeder bekannte Text-Modellname, der je in ENVs, Firestore-Scopes oder
// Code-Literalen stand — sie ALLE muessen auf das Politik-Modell aufloesen.
const ALL_TEXT_MODEL_NAMES = [
  // 2.5-Aera (Cloud-Run-Pins)
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  // Gemini-3-Familie
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
  // Kurz-Aliase
  'mini',
  'nano',
  'standard',
  'thinking',
  'flash',
  'pro',
  'gemini-flash',
  'gemini-thinking',
  'gemini-pro',
  // Legacy-/Experimental-Namen
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-exp-1206',
  'gemini-1.5-pro-002',
];

// Die 10 Modell-Pins, die in Production (Cloud Run) als ENV-Vars stehen.
const PROD_ENV_PINS = [
  'IDENTIFY_MODEL',
  'GEMINI_TEXT_MODEL',
  'GEMINI_STRUCTURED_MODEL',
  'GEMINI_MULTIMODAL_MODEL',
  'CATEGORY_MODEL',
  'QUALITY_GATE_MODEL',
  'REVIEW_MODEL',
  'MARKETING_MODEL',
  'IDENTIFY_V4_MODEL',
  'GROUPING_MODEL',
];

const NON_TEXT_MODEL_NAMES = [
  'gemini-2.5-flash-image',
  'gemini-3-pro-image-preview',
  'gemini-3.1-flash-tts-preview',
  'gemini-3.1-flash-live-preview',
];

afterEach(() => {
  delete process.env.MODEL_POLICY;
  delete process.env.MODEL_SELECT_TEST_ENV;
  for (const key of PROD_ENV_PINS) delete process.env[key];
});

describe('model policy: gemini-3.7-flash everywhere (Owner-Entscheid 2026-08-26)', () => {
  it('exports the policy model as PRIMARY_TEXT_MODEL', () => {
    expect(PRIMARY_TEXT_MODEL).toBe(POLICY_MODEL);
  });

  it('passes gemini-3.7-flash through unchanged', () => {
    expect(resolveModel('gemini-3.7-flash', 'X_UNSET')).toBe(POLICY_MODEL);
  });

  it.each(ALL_TEXT_MODEL_NAMES)('resolves %s to gemini-3.7-flash', (name) => {
    expect(resolveModel(name, 'X_UNSET')).toBe(POLICY_MODEL);
  });

  it('is case- and whitespace-insensitive for known names', () => {
    expect(resolveModel('  GEMINI-2.5-PRO  ', 'X_UNSET')).toBe(POLICY_MODEL);
    expect(resolveModel('Gemini-3.1-Pro-Preview-Customtools', 'X_UNSET')).toBe(POLICY_MODEL);
  });

  it('garbage, null, undefined, empty, default and auto fall back to gemini-3.7-flash', () => {
    expect(resolveModel(undefined, 'X_UNSET', undefined)).toBe(POLICY_MODEL);
    expect(resolveModel(null, 'X_UNSET', null)).toBe(POLICY_MODEL);
    expect(resolveModel('', 'X_UNSET', '')).toBe(POLICY_MODEL);
    expect(resolveModel('default', 'X_UNSET')).toBe(POLICY_MODEL);
    expect(resolveModel('auto', 'X_UNSET')).toBe(POLICY_MODEL);
    expect(resolveModel('garbage-model-name', 'X_UNSET', 'also-garbage')).toBe(POLICY_MODEL);
    expect(resolveModel(42, 'X_UNSET', {})).toBe(POLICY_MODEL);
  });

  it('resolves fallback-position names through the policy too', () => {
    expect(resolveModel(undefined, 'X_UNSET', 'gemini-2.5-pro')).toBe(POLICY_MODEL);
    expect(resolveModel(undefined, 'X_UNSET', 'gemini-2.5-flash')).toBe(POLICY_MODEL);
  });
});

describe('mirror invariant: no input ever resolves to a gemini-2.5 text model (default policy)', () => {
  const inputs = [
    ...ALL_TEXT_MODEL_NAMES,
    ...NON_TEXT_MODEL_NAMES,
    'gemini-3.7-flash',
    'default',
    'auto',
    '',
    null,
    undefined,
    'garbage-model-name',
  ];

  it.each(inputs.map((i) => [String(i)]))('input %s never yields a 2.5 model', (label) => {
    const input = label === 'null' ? null : label === 'undefined' ? undefined : label;
    expect(resolveModel(input, 'X_UNSET')).not.toMatch(/^gemini-2\.5/);
  });

  it('every resolution result IS the policy model (single text model)', () => {
    for (const input of inputs) {
      expect(resolveModel(input, 'X_UNSET')).toBe(POLICY_MODEL);
    }
  });
});

describe('ENV path: stale gemini-2.5-flash prod pins resolve to 3.7', () => {
  it.each(PROD_ENV_PINS)('%s=gemini-2.5-flash resolves via the ENV path to gemini-3.7-flash', (envKey) => {
    process.env[envKey] = 'gemini-2.5-flash';
    expect(resolveModel(undefined, envKey)).toBe(POLICY_MODEL);
  });

  it('ENV values with Gemini-3 names are redirected too', () => {
    process.env.MODEL_SELECT_TEST_ENV = 'gemini-3-flash-preview';
    expect(resolveModel(undefined, 'MODEL_SELECT_TEST_ENV')).toBe(POLICY_MODEL);
  });

  it('preferred wins over ENV, both land on the policy model anyway', () => {
    process.env.MODEL_SELECT_TEST_ENV = 'gemini-2.5-pro';
    expect(resolveModel('gemini-3.1-pro-preview', 'MODEL_SELECT_TEST_ENV')).toBe(POLICY_MODEL);
  });
});

describe('Notbremse MODEL_POLICY=gemini25 (alte 2.5-Politik)', () => {
  it('restores the 2.5 policy: 3.x pro names map to gemini-2.5-pro', () => {
    process.env.MODEL_POLICY = 'gemini25';
    expect(resolveModel('gemini-3-pro-preview', 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('gemini-3.1-pro-preview', 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('gemini-3.1-pro-preview-customtools', 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('pro', 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('thinking', 'X_UNSET')).toBe('gemini-2.5-pro');
  });

  it('restores the 2.5 policy: 3.x flash names (incl. 3.7) map to gemini-2.5-flash', () => {
    process.env.MODEL_POLICY = 'gemini25';
    expect(resolveModel('gemini-3-flash-preview', 'X_UNSET')).toBe('gemini-2.5-flash');
    expect(resolveModel('gemini-3.1-flash-lite', 'X_UNSET')).toBe('gemini-2.5-flash');
    expect(resolveModel('gemini-3.7-flash', 'X_UNSET')).toBe('gemini-2.5-flash');
    expect(resolveModel('flash', 'X_UNSET')).toBe('gemini-2.5-flash');
    expect(resolveModel('mini', 'X_UNSET')).toBe('gemini-2.5-flash');
  });

  it('passes 2.5 models through unchanged and falls back to gemini-2.5-pro', () => {
    process.env.MODEL_POLICY = 'gemini25';
    expect(resolveModel('gemini-2.5-pro', 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('gemini-2.5-flash', 'X_UNSET')).toBe('gemini-2.5-flash');
    expect(resolveModel(undefined, 'X_UNSET')).toBe('gemini-2.5-pro');
    expect(resolveModel('garbage-model-name', 'X_UNSET', 'also-garbage')).toBe('gemini-2.5-pro');
  });

  it('no input resolves to a gemini-3 model under the Notbremse', () => {
    process.env.MODEL_POLICY = 'gemini25';
    for (const input of [...ALL_TEXT_MODEL_NAMES, 'gemini-3.7-flash', null, undefined, '']) {
      expect(resolveModel(input, 'X_UNSET')).not.toMatch(/^gemini-3/);
    }
  });

  it.each([['true'], ['1'], ['on'], [''], ['gemini2.5'], ['gemini-25']])(
    'garbage value %s does NOT flip the policy (stays on 3.7)',
    (value) => {
      process.env.MODEL_POLICY = value;
      expect(resolveModel('gemini-3-flash-preview', 'X_UNSET')).toBe(POLICY_MODEL);
      expect(resolveModel(undefined, 'X_UNSET')).toBe(POLICY_MODEL);
    }
  );

  // Implementierungs-Realitaet (Wert wird getrimmt + lowercased): 'GEMINI25'
  // und ' gemini25 ' schalten die Notbremse AUCH. Bewusst so getestet, wie es
  // implementiert ist — schaerfer als der Code-Kommentar ("nur exakt dieser
  // Wert") behauptet; siehe Report an den Owner.
  it.each([['GEMINI25'], [' gemini25 '], ['Gemini25']])(
    'case/whitespace variant %s DOES flip the policy (trim+lowercase behavior as implemented)',
    (value) => {
      process.env.MODEL_POLICY = value;
      expect(resolveModel(undefined, 'X_UNSET')).toBe('gemini-2.5-pro');
      expect(resolveModel('gemini-3-flash-preview', 'X_UNSET')).toBe('gemini-2.5-flash');
    }
  );
});

describe('image/tts/live guard: non-text models are never touched by the text policy', () => {
  it.each(NON_TEXT_MODEL_NAMES)('%s as preferred is never returned and never "normalized" to 3.7-as-its-alias', (name) => {
    const resolved = resolveModel(name, 'X_UNSET', null);
    // Der Bild-/TTS-/Live-Name selbst darf NIE als Ergebnis herauskommen ...
    expect(resolved).not.toBe(name);
    expect(resolved).not.toMatch(/-(image|tts|live)\b|-image-|-tts-|-live-/);
    // ... normalizeModel loest ihn zu null auf, also greift der absolute
    // Politik-Fallback (ein TEXT-Modell — der Name wurde uebersprungen, nicht gemappt).
    expect(resolved).toBe(POLICY_MODEL);
  });

  it.each(NON_TEXT_MODEL_NAMES)('%s in the ENV position is skipped, not returned', (name) => {
    process.env.MODEL_SELECT_TEST_ENV = name;
    expect(resolveModel(undefined, 'MODEL_SELECT_TEST_ENV')).toBe(POLICY_MODEL);
  });

  it.each(NON_TEXT_MODEL_NAMES)('%s in the fallback position is skipped, not returned', (name) => {
    expect(resolveModel(undefined, 'X_UNSET', name)).toBe(POLICY_MODEL);
  });

  it('a valid text name still wins when an image name sits earlier in the chain', () => {
    process.env.MODEL_SELECT_TEST_ENV = 'gemini-2.5-flash';
    expect(resolveModel('gemini-3-pro-image-preview', 'MODEL_SELECT_TEST_ENV')).toBe(POLICY_MODEL);
  });

  it('under the Notbremse image names fall through to gemini-2.5-pro, never the image name', () => {
    process.env.MODEL_POLICY = 'gemini25';
    for (const name of NON_TEXT_MODEL_NAMES) {
      expect(resolveModel(name, 'X_UNSET', null)).toBe('gemini-2.5-pro');
    }
  });
});

describe('supportsToolContextCirculation', () => {
  it.each([
    ['gemini-3.7-flash'],
    ['gemini-3.1-pro-preview-customtools'],
    ['gemini-3-flash-preview'],
  ])('%s supports tool context circulation', (name) => {
    expect(supportsToolContextCirculation(name)).toBe(true);
  });

  it.each([
    ['gemini-2.5-pro'],
    ['gemini-2.5-flash'],
    [''],
    [null],
    [undefined],
    ['gemini-3-pro-image-preview'],
  ])('%s does NOT support tool context circulation', (name) => {
    expect(supportsToolContextCirculation(name)).toBe(false);
  });

  it('is case/whitespace tolerant', () => {
    expect(supportsToolContextCirculation('  GEMINI-3.7-FLASH  ')).toBe(true);
  });

  it('composed with resolveModel: default policy yields a circulation-capable model, Notbremse does not', () => {
    const resolvedDefault = resolveModel('gemini-3.1-pro-preview-customtools', 'X_UNSET');
    expect(supportsToolContextCirculation(resolvedDefault)).toBe(true);

    process.env.MODEL_POLICY = 'gemini25';
    const resolvedLegacy = resolveModel('gemini-3.1-pro-preview-customtools', 'X_UNSET');
    expect(resolvedLegacy).toBe('gemini-2.5-pro');
    expect(supportsToolContextCirculation(resolvedLegacy)).toBe(false);
  });
});
