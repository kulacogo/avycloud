/**
 * Gemini-2.5-Kompatibilität (Prod-Vorfall 2026-08-02):
 * 2.5 erlaubt KEINE Kombination aus Tools (googleSearch/urlContext) und
 * erzwungenem JSON (responseMimeType/responseJsonSchema) im selben Request —
 * Fehler: "Tool use with a response mime type: 'application/json' is
 * unsupported". Der Helfer entfernt den JSON-Zwang bei 2.5+Tools; die Prompts
 * verlangen ohnehin JSON-only und die Parser verkraften Freitext-JSON.
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

  it('does not mutate the input config object', () => {
    const cfg = baseConfig();
    _stripJsonForceWhenToolsUnsupported('gemini-2.5-pro', cfg);
    expect(cfg.responseMimeType).toBe('application/json');
  });
});

describe('chatV2ModelSupported (Zwei-Request-Modus seit 2026-08-04)', () => {
  it('is true under the 2.5 policy — V2 läuft im Split-Modus (Grounding + Functions getrennt)', () => {
    const { chatV2ModelSupported } = require('../../services/product-chat-v2');
    expect(chatV2ModelSupported()).toBe(true);
  });

  it('CHAT_V2_SPLIT_GROUNDING=off restores the legacy-direct-start gate', () => {
    process.env.CHAT_V2_SPLIT_GROUNDING = 'off';
    try {
      const { chatV2ModelSupported } = require('../../services/product-chat-v2');
      expect(chatV2ModelSupported()).toBe(false);
    } finally {
      delete process.env.CHAT_V2_SPLIT_GROUNDING;
    }
  });
});

describe('isAgenticEnabled model gate (context circulation is Gemini-3-only)', () => {
  const MOD = '../../lib/identify-v3-stage3-agentic';
  let originalEnv;
  beforeEach(() => {
    originalEnv = { STAGE3_AGENTIC: process.env.STAGE3_AGENTIC, GEMINI_IDENTIFY_MODEL: process.env.GEMINI_IDENTIFY_MODEL };
    delete process.env.STAGE3_AGENTIC;
    delete process.env.GEMINI_IDENTIFY_MODEL;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is OFF under the 2.5 policy (would 400 with "context circulation not enabled")', () => {
    const { isAgenticEnabled } = require(MOD);
    expect(isAgenticEnabled()).toBe(false);
  });

  it('stays OFF even with explicit STAGE3_AGENTIC=true (model gate wins)', () => {
    process.env.STAGE3_AGENTIC = 'true';
    const { isAgenticEnabled } = require(MOD);
    expect(isAgenticEnabled()).toBe(false);
  });
});
