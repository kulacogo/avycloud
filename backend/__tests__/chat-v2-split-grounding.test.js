'use strict';

// Chat-Grounding auf Gemini 2.5 (Incident 2026-08-04):
// Seit der Gemini-3-Kostensperre (01.08.) war der Chat strukturell auf die
// Legacy-Pipeline gepinnt: V2 kombiniert googleSearch + functionDeclarations
// in EINEM Request ("Context Circulation"), was 2.5 mit 400 ablehnt — also
// wurde V2 komplett übersprungen und der Chat verlor jede Google-Recherche.
// Neu: Auf Nicht-customtools-Modellen läuft V2 im ZWEI-REQUEST-Modus:
//   Phase A: googleSearch(+urlContext) OHNE functionDeclarations → Recherche
//   Phase B: functionDeclarations OHNE googleSearch → Change-Cards aus den
//            Recherche-Ergebnissen
// Kill-Switch: CHAT_V2_SPLIT_GROUNDING=off → altes Verhalten (V2 nur auf
// customtools, Kaskade startet auf 2.5 direkt bei Legacy).

const path = require('path');

function patchLocalModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

const RESEARCH_TEXT = 'Hersteller ist Fenix Outdoor AB, Batterivägen 4, Jönköping. Quelle: https://www.fjallraven.com/impressum';

// Fake-GenAI: zeichnet jede chats.create-Config auf und bedient Phase A
// (Grounding, nur Text) und Phase B (Function-Calls) unterschiedlich.
const createdChats = [];
let phaseAFailuresRemaining = 0;

function toolsOf(config) {
  return Array.isArray(config?.tools) ? config.tools : [];
}
function hasGoogleSearch(config) {
  return toolsOf(config).some((t) => t && t.googleSearch);
}
function hasFunctionDeclarations(config) {
  return toolsOf(config).some((t) => t && Array.isArray(t.functionDeclarations));
}
function hasUrlContext(config) {
  return toolsOf(config).some((t) => t && t.urlContext);
}

// Per-Test überschreibbare Phase-B-Antwort (default: GPSR-Vorschlag).
const DEFAULT_PHASE_B_ARGS = {
  summary: 'GPSR ergänzt',
  gpsr: { manufacturer_name: 'Fenix Outdoor AB', url: 'https://www.fjallraven.com' },
};
let phaseBFunctionArgs = DEFAULT_PHASE_B_ARGS;
let phaseAGroundingMeta = null;

function makeFakeChat(createOpts) {
  const messages = [];
  const grounding = hasGoogleSearch(createOpts.config);
  let phaseBCalls = 0;
  return {
    _messages: messages,
    sendMessage: async ({ message }) => {
      messages.push(message);
      if (grounding) {
        if (phaseAFailuresRemaining > 0) {
          phaseAFailuresRemaining -= 1;
          const err = new Error('got status: 400 . url context tool is not supported for this model');
          err.status = 400;
          throw err;
        }
        return {
          text: RESEARCH_TEXT,
          functionCalls: undefined,
          candidates: phaseAGroundingMeta ? [{ groundingMetadata: phaseAGroundingMeta }] : [],
        };
      }
      phaseBCalls += 1;
      if (phaseBCalls === 1) {
        return {
          text: '',
          functionCalls: [{
            name: 'update_product_datasheet',
            args: phaseBFunctionArgs,
          }],
          candidates: [],
        };
      }
      return { text: 'Änderungen vorgeschlagen.', functionCalls: undefined, candidates: [] };
    },
  };
}

const fakeAi = {
  chats: {
    create: (opts) => {
      const chat = makeFakeChat(opts);
      createdChats.push({ opts, chat });
      return chat;
    },
  },
};

patchLocalModule('../lib/gemini3-client.js', { getGenAIClient: async () => fakeAi });
// Redirect-Auflösung ohne Netz: vertexaisearch-Redirects werden im Test
// deterministisch auf ihre "Zielseite" gemappt.
patchLocalModule('../lib/grounding-redirect-resolve.js', {
  isGroundingRedirectUrl: (u) => String(u).includes('grounding-api-redirect'),
  resolveGroundingRedirects: async (urls) => urls.map((u) => (
    String(u).includes('grounding-api-redirect')
      ? 'https://www.idealo.de/preisvergleich/OffersOfProduct/12345.html'
      : u
  )),
});
patchLocalModule('../lib/llm-config.js', {
  getActiveLlmConfig: async () => null,
  resolveScopeConfig: async () => null,
});
patchLocalModule('../services/enrichment.js', { applyEbayTaxonomy: () => {} });
patchLocalModule('../lib/ktype-enrichment.js', { enrichKTypIfPossible: async () => {} });
patchLocalModule('../services/category-resolver.js', { resolveProposedCategoryForChanges: async () => {} });

const { runProductChatV2, chatV2ModelSupported } = require('../services/product-chat-v2');

function makeProduct() {
  return {
    id: 'p1',
    identification: { name: 'Fjällräven Färden Duffel 80', brand: 'FJALLRAVEN' },
    details: { attributes: {}, images: [] },
  };
}

beforeEach(() => {
  createdChats.length = 0;
  phaseAFailuresRemaining = 0;
  phaseBFunctionArgs = DEFAULT_PHASE_B_ARGS;
  phaseAGroundingMeta = null;
});

describe('chatV2ModelSupported — Split-Modus öffnet V2 auf 2.5', () => {
  it('ist unter der 2.5-Politik jetzt TRUE (Zwei-Request-Modus verfügbar)', () => {
    expect(chatV2ModelSupported()).toBe(true);
  });

  it('Kill-Switch CHAT_V2_SPLIT_GROUNDING=off stellt das alte Gate wieder her (Legacy-Direktstart)', () => {
    process.env.CHAT_V2_SPLIT_GROUNDING = 'off';
    try {
      expect(chatV2ModelSupported()).toBe(false);
    } finally {
      delete process.env.CHAT_V2_SPLIT_GROUNDING;
    }
  });
});

describe('runProductChatV2 — Zwei-Request-Modus auf Nicht-customtools-Modellen', () => {
  it('trennt Grounding (Phase A) und Function-Calls (Phase B) in zwei Requests', async () => {
    const result = await runProductChatV2(makeProduct(), 'Recherchiere Herstellerangaben für GPSR.', {});

    expect(createdChats.length).toBe(2);
    const phaseA = createdChats.find(({ opts }) => hasGoogleSearch(opts.config));
    const phaseB = createdChats.find(({ opts }) => hasFunctionDeclarations(opts.config));
    expect(phaseA).toBeTruthy();
    expect(phaseB).toBeTruthy();
    // Phase A: Grounding ohne Custom-Functions (2.5 lehnt die Kombination ab).
    expect(hasGoogleSearch(phaseA.opts.config)).toBe(true);
    expect(hasFunctionDeclarations(phaseA.opts.config)).toBe(false);
    // Phase B: Custom-Functions ohne Grounding.
    expect(hasFunctionDeclarations(phaseB.opts.config)).toBe(true);
    expect(hasGoogleSearch(phaseB.opts.config)).toBe(false);

    // Die Recherche-Ergebnisse aus Phase A werden Phase B mitgegeben.
    const phaseBFirstMessage = JSON.stringify(phaseB.chat._messages[0]);
    expect(phaseBFirstMessage).toContain('Fenix Outdoor AB');

    // Ergebnis: Antworttext aus der Recherche + Change-Card aus Phase B.
    expect(result.message).toContain('Fenix Outdoor AB');
    expect(result.datasheetChanges.length).toBe(1);
    expect(result.datasheetChanges[0].gpsr.manufacturer_name).toBe('Fenix Outdoor AB');
    expect(result.datasheetChanges[0].gpsr.url).toBe('https://www.fjallraven.com');
    expect(result._split).toBe(true);
  });

  // Prod-Vorfall 2026-08-04 01:29Z: Phase A wurde 3x nach exakt 30s abgewürgt
  // ("sendMessage-research per-attempt timeout after 30000ms") — ein
  // gegroundeter 2.5-Pro-Call mit Bildern + Thinking braucht 30-60s. Der Chat
  // verbrannte 2min in Retries und fiel dann doch auf Legacy.
  it('Phase A läuft OHNE thinkingConfig und mit gekapptem maxOutputTokens (Latenz)', async () => {
    process.env.CHAT_V2_ENHANCED = 'true';
    try {
      await runProductChatV2(makeProduct(), 'Recherchiere Herstellerangaben.', {});
      const phaseA = createdChats.find(({ opts }) => hasGoogleSearch(opts.config));
      const phaseB = createdChats.find(({ opts }) => hasFunctionDeclarations(opts.config));
      expect(phaseA.opts.config.thinkingConfig).toBeUndefined();
      expect(phaseA.opts.config.maxOutputTokens).toBeLessThanOrEqual(4096);
      // Der Haupt-Chat (Phase B) behält das Enhanced-Tuning.
      expect(phaseB.opts.config.thinkingConfig).toBeTruthy();
    } finally {
      delete process.env.CHAT_V2_ENHANCED;
    }
  });

  it('Phase A nutzt das 90s-Recherche-Budget mit max. 2 Versuchen (Source-Vertrag)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/product-chat-v2.js'), 'utf8');
    expect(src).toMatch(/CHAT_V2_RESEARCH_TIMEOUT_MS \|\| '90000'/);
    const researchCall = src.slice(src.indexOf("label: 'sendMessage-research'") - 300, src.indexOf("label: 'sendMessage-research'") + 300);
    expect(researchCall).toMatch(/perAttemptTimeoutMs: RESEARCH_PER_ATTEMPT_TIMEOUT_MS/);
    expect(researchCall).toMatch(/maxAttempts: 2/);
  });

  it('Split-Modus: Phase B läuft OHNE includeServerSideToolInvocations (Circulation-Flag, 400-Risiko auf 2.5)', async () => {
    await runProductChatV2(makeProduct(), 'Recherchiere Herstellerangaben.', {});
    const phaseB = createdChats.find(({ opts }) => hasFunctionDeclarations(opts.config));
    expect(phaseB.opts.config.toolConfig).toBeUndefined();
  });

  it('Split-Modus: Phase-B-Calls nutzen das 60s-Budget mit max. 2 Versuchen (Source-Vertrag)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../services/product-chat-v2.js'), 'utf8');
    expect(src).toMatch(/CHAT_V2_SPLIT_SEND_TIMEOUT_MS \|\| '60000'/);
    const initIdx = src.indexOf("label: 'sendMessage-initial'");
    expect(src.slice(initIdx - 60, initIdx + 120)).toMatch(/\.\.\.splitSendRetryOpts/);
    const iterIdx = src.indexOf('label: `sendMessage-iter-');
    expect(src.slice(iterIdx - 60, iterIdx + 120)).toMatch(/\.\.\.splitSendRetryOpts/);
  });

  it('füllt einen zu kurzen Titel-Vorschlag aus Phase B mit Datenblatt-Tokens auf (31-Zeichen-Vorfall)', async () => {
    phaseBFunctionArgs = { summary: 'Titel optimiert', title: 'FJALLRAVEN Duffel Tasche' };
    const product = makeProduct();
    product.details.attributes = {
      Produktart: 'Reisetasche',
      Modell: 'Färden Duffel 80',
      Farbe: 'Coal Black',
      Material: 'Polyamid',
      Volumen: '80 L',
    };
    product.details.identifiers = { mpn: 'F23200283' };

    const result = await runProductChatV2(product, 'Optimiere den Titel.', {});
    const titleChange = result.datasheetChanges.find((c) => c && c.title);
    expect(titleChange).toBeTruthy();
    expect(titleChange.title.startsWith('FJALLRAVEN Duffel Tasche')).toBe(true);
    expect(titleChange.title.length).toBeGreaterThanOrEqual(60);
    expect(titleChange.title.length).toBeLessThanOrEqual(80);
  });

  it('löst Grounding-Redirect-Quellen auf echte URLs auf, bevor Phase B sie sieht', async () => {
    phaseAGroundingMeta = {
      webSearchQueries: ['idealo preis'],
      groundingChunks: [
        { web: { title: 'idealo', uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/XyZ' } },
      ],
    };
    const result = await runProductChatV2(makeProduct(), 'Recherchiere den Marktpreis.', {});

    const phaseB = createdChats.find(({ opts }) => hasFunctionDeclarations(opts.config));
    const phaseBFirstMessage = JSON.stringify(phaseB.chat._messages[0]);
    // Die echte Ziel-URL kommt an, die opake Redirect-URL nicht.
    expect(phaseBFirstMessage).toContain('idealo.de/preisvergleich');
    expect(phaseBFirstMessage).not.toContain('grounding-api-redirect');
    // Auch der Evidence-Trace fürs Frontend trägt die aufgelöste URL.
    const traceJson = JSON.stringify(result.serpTrace);
    expect(traceJson).toContain('idealo.de/preisvergleich');
    expect(traceJson).not.toContain('grounding-api-redirect');
  });

  it('fällt bei 400 auf urlContext in Phase A auf googleSearch-only zurück', async () => {
    process.env.CHAT_V2_ENHANCED = 'true';
    phaseAFailuresRemaining = 1;
    try {
      const result = await runProductChatV2(makeProduct(), 'Recherchiere Herstellerangaben.', {});
      // Erster Phase-A-Versuch (mit urlContext) scheiterte → zweiter ohne.
      const groundingChats = createdChats.filter(({ opts }) => hasGoogleSearch(opts.config));
      expect(groundingChats.length).toBe(2);
      expect(hasUrlContext(groundingChats[0].opts.config)).toBe(true);
      expect(hasUrlContext(groundingChats[1].opts.config)).toBe(false);
      expect(result.message).toContain('Fenix Outdoor AB');
    } finally {
      delete process.env.CHAT_V2_ENHANCED;
    }
  });
});
