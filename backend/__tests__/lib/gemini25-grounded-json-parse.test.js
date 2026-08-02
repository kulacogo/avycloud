/**
 * Prod-Vorfall 2026-08-02 (zweiter Lauf nach 2.5-Downgrade): grounded 2.5-
 * Antworten kommen als Prosa + JSON + Quellenanhang. Der alte Parser
 * akzeptierte JSON nur in den ersten 200 Zeichen und schnitt Text NACH dem
 * JSON nie ab → 'Failed to parse focused grounding JSON (even after repair)'.
 */
const { _extractBalancedJson, _jsonFormatterFallback } = require('../../lib/gemini3-client');

describe('_extractBalancedJson', () => {
  it('extracts JSON preceded by long prose (>200 chars) and followed by sources', () => {
    const prose = 'Ich habe das Produkt gründlich recherchiert. '.repeat(10);
    const text = `${prose}\n\`\`\`json\n{"brand":"Dyson","model":"WashG1"}\n\`\`\`\nQuellen: [1] dyson.de [2] idealo.de`;
    expect(JSON.parse(_extractBalancedJson(text))).toEqual({ brand: 'Dyson', model: 'WashG1' });
  });

  it('handles braces inside string values', () => {
    const text = 'Vorwort {nicht das} nein — hier: {"desc":"Größe {L} mit } Zeichen","ok":true} Nachwort';
    // Erste öffnende Klammer gehört zu "{nicht das}" — kein gültiges JSON;
    // der Scanner muss die NÄCHSTE balancierte Struktur finden, die parsebar ist.
    const out = _extractBalancedJson(text);
    expect(JSON.parse(out)).toEqual({ desc: 'Größe {L} mit } Zeichen', ok: true });
  });

  it('returns tail from first brace when JSON is truncated (repair can close it)', () => {
    const text = 'Analyse:\n{"brand":"Bosch","model":"GSR 12V';
    expect(_extractBalancedJson(text)).toBe('{"brand":"Bosch","model":"GSR 12V');
  });

  it('returns null when no object exists', () => {
    expect(_extractBalancedJson('kein json hier')).toBeNull();
  });

  it('plain valid JSON passes through unchanged', () => {
    const j = '{"a":1,"b":{"c":[1,2]}}';
    expect(_extractBalancedJson(j)).toBe(j);
  });
});

describe('_jsonFormatterFallback', () => {
  const SCHEMA = { type: 'object', properties: { brand: { type: 'string' } }, required: ['brand'] };

  it('formats prose research text into schema JSON via a tool-free second call', async () => {
    const calls = [];
    const fakeAi = {
      models: {
        generateContent: async (req) => {
          calls.push(req);
          return { text: '{"brand":"Dyson"}' };
        },
      },
    };
    const parsed = await _jsonFormatterFallback({
      ai: fakeAi, modelName: 'gemini-2.5-flash',
      rawText: 'Die Marke ist Dyson, Modell WashG1 …',
      schema: SCHEMA, timeoutMs: 5000,
    });
    expect(parsed).toEqual({ brand: 'Dyson' });
    expect(calls).toHaveLength(1);
    expect(calls[0].config.responseMimeType).toBe('application/json');
    expect(calls[0].config.responseJsonSchema).toBe(SCHEMA);
    expect(calls[0].config.tools).toBeUndefined();
  });

  it('throws on empty rawText instead of letting the formatter hallucinate', async () => {
    const fakeAi = { models: { generateContent: async () => ({ text: '{"brand":"Erfunden"}' }) } };
    await expect(_jsonFormatterFallback({
      ai: fakeAi, modelName: 'gemini-2.5-flash', rawText: '   ', schema: SCHEMA, timeoutMs: 5000,
    })).rejects.toThrow(/leer|empty/i);
  });
});
