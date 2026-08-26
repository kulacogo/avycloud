/**
 * Modellpolitik-Kompatibilität (seit 2026-08-26: gemini-3.7-flash als
 * EINZIGES Textmodell, Notbremse MODEL_POLICY='gemini25').
 *
 * Historie (Prod-Vorfall 2026-08-02): 2.5 erlaubt KEINE Kombination aus Tools
 * (googleSearch/urlContext) und erzwungenem JSON (responseMimeType/
 * responseJsonSchema) im selben Request — Fehler: "Tool use with a response
 * mime type: 'application/json' is unsupported". Der Helfer entfernt den
 * JSON-Zwang bei 2.5+Tools; die Prompts verlangen ohnehin JSON-only und die
 * Parser verkraften Freitext-JSON. Auf gemini-3.7-flash ist die Kombination
 * live verifiziert (26.08.2026) — der Helfer ist dort ein No-op und wird
 * unter der Notbremse automatisch wieder aktiv.
 */
const { _stripJsonForceWhenToolsUnsupported } = require('../../lib/gemini3-client');

describe('_stripJsonForceWhenToolsUnsupported', () => {
  const baseConfig = () => ({
    tools: [{ googleSearch: {} }, { urlContext: {} }],
    temperature: 0.6,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
    responseJsonSchema: { type: 'object' },
  });

  it('strips responseMimeType + responseJsonSchema on gemini-2.5 with tools', () => {
    const out = _stripJsonForceWhenToolsUnsupported('gemini-2.5-pro', baseConfig());
    expect(out.responseMimeType).toBeUndefined();
    expect(out.responseJsonSchema).toBeUndefined();
    expect(out.tools).toHaveLength(2);
    expect(out.temperature).toBe(0.6);
    expect(out.maxOutputTokens).toBe(8192);
  });

  it('leaves config untouched when no tools are present (JSON mode alone is fine on 2.5)', () => {
    const cfg = { temperature: 0.1, responseMimeType: 'application/json', responseJsonSchema: {} };
    const out = _stripJsonForceWhenToolsUnsupported('gemini-2.5-flash', cfg);
    expect(out.responseMimeType).toBe('application/json');
    expect(out.responseJsonSchema).toEqual({});
  });

  it('leaves config untouched on non-2.x models', () => {
    const out = _stripJsonForceWhenToolsUnsupported('gemini-3.1-pro-preview-customtools', baseConfig());
    expect(out.responseMimeType).toBe('application/json');
  });

  it('gemini-3.7-flash + Tools: JSON-Zwang bleibt STEHEN (googleSearch+responseJsonSchema live verifiziert 26.08.2026)', () => {
    const out = _stripJsonForceWhenToolsUnsupported('gemini-3.7-flash', baseConfig());
    expect(out.responseMimeType).toBe('application/json');
    expect(out.responseJsonSchema).toEqual({ type: 'object' });
    expect(out.tools).toHaveLength(2);
  });

  it('does not mutate the input config object', () => {
    const cfg = baseConfig();
    _stripJsonForceWhenToolsUnsupported('gemini-2.5-pro', cfg);
    expect(cfg.responseMimeType).toBe('application/json');
  });
});

describe('chatV2ModelSupported (Fähigkeits-Gate statt Namenssuffix)', () => {
  let originalEnv;
  beforeEach(() => {
    originalEnv = {
      MODEL_POLICY: process.env.MODEL_POLICY,
      CHAT_V2_SPLIT_GROUNDING: process.env.CHAT_V2_SPLIT_GROUNDING,
      CHAT_MODEL: process.env.CHAT_MODEL,
    };
    delete process.env.MODEL_POLICY;
    delete process.env.CHAT_V2_SPLIT_GROUNDING;
    delete process.env.CHAT_MODEL;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is true under the 3.7-Politik (resolveChatModel → gemini-3.7-flash, Context Circulation vorhanden)', () => {
    const { chatV2ModelSupported } = require('../../services/product-chat-v2');
    expect(chatV2ModelSupported()).toBe(true);
  });

  it('3.7-Politik: bleibt true AUCH mit CHAT_V2_SPLIT_GROUNDING=off (Fähigkeit statt Namenssuffix)', () => {
    process.env.CHAT_V2_SPLIT_GROUNDING = 'off';
    const { chatV2ModelSupported } = require('../../services/product-chat-v2');
    expect(chatV2ModelSupported()).toBe(true);
  });

  it('Notbremse MODEL_POLICY=gemini25 + SPLIT off: false (Legacy-Direktstart wie vor 2026-08-04)', () => {
    process.env.MODEL_POLICY = 'gemini25';
    process.env.CHAT_V2_SPLIT_GROUNDING = 'off';
    const { chatV2ModelSupported } = require('../../services/product-chat-v2');
    expect(chatV2ModelSupported()).toBe(false);
  });

  it('Notbremse MODEL_POLICY=gemini25 + SPLIT on (default): true — Zwei-Request-Modus trägt V2 auf 2.5', () => {
    process.env.MODEL_POLICY = 'gemini25';
    const { chatV2ModelSupported } = require('../../services/product-chat-v2');
    expect(chatV2ModelSupported()).toBe(true);
  });
});

describe('isAgenticEnabled model gate (context circulation via supportsToolContextCirculation)', () => {
  const MOD = '../../lib/identify-v3-stage3-agentic';
  let originalEnv;
  beforeEach(() => {
    originalEnv = {
      MODEL_POLICY: process.env.MODEL_POLICY,
      STAGE3_AGENTIC: process.env.STAGE3_AGENTIC,
      STAGE3_AGENTIC_SAMPLE: process.env.STAGE3_AGENTIC_SAMPLE,
      IDENTIFY_MODEL: process.env.IDENTIFY_MODEL,
      GEMINI_IDENTIFY_MODEL: process.env.GEMINI_IDENTIFY_MODEL,
    };
    delete process.env.MODEL_POLICY;
    delete process.env.STAGE3_AGENTIC;
    delete process.env.STAGE3_AGENTIC_SAMPLE;
    delete process.env.IDENTIFY_MODEL;
    delete process.env.GEMINI_IDENTIFY_MODEL;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is ON by default under the 3.7-Politik (Modell-Gate offen, STAGE3_AGENTIC default on)', () => {
    const { isAgenticEnabled } = require(MOD);
    expect(isAgenticEnabled()).toBe(true);
  });

  it('3.7-Politik: STAGE3_AGENTIC=false schaltet weiterhin ab (expliziter Opt-out gewinnt)', () => {
    process.env.STAGE3_AGENTIC = 'false';
    const { isAgenticEnabled } = require(MOD);
    expect(isAgenticEnabled()).toBe(false);
  });

  it('Notbremse MODEL_POLICY=gemini25: OFF (würde mit 400 "context circulation not enabled" scheitern)', () => {
    process.env.MODEL_POLICY = 'gemini25';
    const { isAgenticEnabled } = require(MOD);
    expect(isAgenticEnabled()).toBe(false);
  });

  it('Notbremse: bleibt OFF selbst mit explizitem STAGE3_AGENTIC=true (Modell-Gate gewinnt)', () => {
    process.env.MODEL_POLICY = 'gemini25';
    process.env.STAGE3_AGENTIC = 'true';
    const { isAgenticEnabled } = require(MOD);
    expect(isAgenticEnabled()).toBe(false);
  });
});
