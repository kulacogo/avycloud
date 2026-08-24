// globals: true in vitest.config.js
//
// Das KI-Urteil in der Duplikat-Suche. Die KI darf einen deterministisch
// gefundenen Kandidaten BESTAETIGEN oder VERWERFEN — sie darf niemals selbst
// bestimmen, auf welches Produkt gematcht wird (Incident 2026-07-08: eine
// halluzinierte EAN oeffnete den Suchraum auf die ganze Datenbank und
// kollabierte drei ATE-Produkte auf ein Datenblatt).
//
// Mocking: require.cache-Patching fuer CJS (vi.mock greift bei require() nicht).

const geminiPath = require.resolve('../lib/gemini-structured');

let antwort;
let aufrufe;

const ladeJudge = () => {
  aufrufe = [];
  require.cache[geminiPath] = {
    id: geminiPath,
    filename: geminiPath,
    loaded: true,
    exports: {
      callGeminiStructured: async (opts) => {
        aufrufe.push(opts);
        if (typeof antwort === 'function') return antwort();
        // callGeminiStructured liefert TEXT, kein Objekt — der Judge muss selbst parsen.
        return JSON.stringify(antwort);
      },
      getStructuredModelName: () => 'test-model',
    },
  };
  delete require.cache[require.resolve('../services/duplicate-judge')];
  return require('../services/duplicate-judge');
};

const frisch = {
  id: 'neu',
  identification: { name: 'ATE Bremsbelagsatz vorne', brand: 'ATE' },
  details: { identifiers: { mpn: '13.0460-7256.2' } },
};

const kandidat = (id, name) => ({
  id,
  score: 0.8,
  reasons: ['model_token'],
  entry: { id, name, brand: 'ATE', mpnNorm: null },
});

afterEach(() => {
  delete require.cache[geminiPath];
  delete require.cache[require.resolve('../services/duplicate-judge')];
});

describe('judgeDuplicate', () => {
  it('fragt die KI ohne Kandidaten gar nicht erst', async () => {
    const { judgeDuplicate } = ladeJudge();
    antwort = { verdict: 'same', candidate_id: 'x', confidence: 1 };

    const ergebnis = await judgeDuplicate({ fresh: frisch, candidates: [] });

    expect(ergebnis.matchId).toBeNull();
    expect(aufrufe).toHaveLength(0);
  });

  it('bestaetigt einen Kandidaten bei klarem Urteil', async () => {
    const { judgeDuplicate } = ladeJudge();
    antwort = { verdict: 'same', candidate_id: 'alt-1', confidence: 0.95, reason: 'identische Artikelnummer auf dem Karton' };

    const ergebnis = await judgeDuplicate({ fresh: frisch, candidates: [kandidat('alt-1', 'ATE Belagsatz')] });

    expect(ergebnis.matchId).toBe('alt-1');
    expect(ergebnis.verdict).toBe('same');
  });

  it('verwirft ein Urteil, das eine unbekannte Produkt-ID nennt', async () => {
    // Die KI darf nur aus der vorgelegten Liste waehlen. Erfindet sie eine ID,
    // ist das keine Bestaetigung, sondern genau der Vektor aus Juli 2026.
    const { judgeDuplicate } = ladeJudge();
    antwort = { verdict: 'same', candidate_id: 'nie-vorgelegt', confidence: 0.99 };

    const ergebnis = await judgeDuplicate({ fresh: frisch, candidates: [kandidat('alt-1', 'ATE Belagsatz')] });

    expect(ergebnis.matchId).toBeNull();
    expect(ergebnis.verdict).toBe('unsure');
  });

  it('reicht ein unsicheres Urteil nicht als Treffer durch', async () => {
    const { judgeDuplicate } = ladeJudge();
    antwort = { verdict: 'same', candidate_id: 'alt-1', confidence: 0.6 };

    const ergebnis = await judgeDuplicate({ fresh: frisch, candidates: [kandidat('alt-1', 'ATE Belagsatz')] });

    expect(ergebnis.matchId).toBeNull();
  });

  it('legt bei einem KI-Fehler neu an statt zu werfen', async () => {
    const { judgeDuplicate } = ladeJudge();
    antwort = () => { throw new Error('Gemini 503'); };

    const ergebnis = await judgeDuplicate({ fresh: frisch, candidates: [kandidat('alt-1', 'ATE Belagsatz')] });

    expect(ergebnis.matchId).toBeNull();
    expect(ergebnis.verdict).toBe('unsure');
    expect(ergebnis.error).toBeTruthy();
  });

  it('legt der KI nur die vorgelegten Kandidaten vor', async () => {
    const { judgeDuplicate } = ladeJudge();
    antwort = { verdict: 'different', candidate_id: null, confidence: 0.9 };

    await judgeDuplicate({ fresh: frisch, candidates: [kandidat('alt-1', 'ATE Belagsatz'), kandidat('alt-2', 'ATE Scheibe')] });

    const text = aufrufe[0].parts.map((p) => p.text || '').join('\n');
    expect(text).toContain('alt-1');
    expect(text).toContain('alt-2');
  });
});
