'use strict';

/**
 * LLM_CONFIG_STORE=off — kein Firestore-Zugriff in Tests.
 *
 * URSACHE (CI-Rotfärbung seit Wochen, belegt am Lauf 31910495667):
 * `resolveScopeConfig` liest die Prompt-/Modell-Konfiguration bei JEDEM Aufruf
 * aus Firestore (zwei Round-Trips: Scope-Dokument + Versions-Dokument). Auf dem
 * GitHub-Runner gibt es keine Google-Zugangsdaten; der Firestore-Client sucht
 * sie erst über die Metadaten-Erkennung, bevor er aufgibt. Die Aufrufer fangen
 * den Fehler sauber ab und nehmen ihre eingebauten Vorgabewerte — fachlich also
 * korrekt, ABER die Wartezeit liegt innerhalb des 10-Sekunden-Budgets pro Test.
 *
 * Ergebnis: In jedem Lauf fiel ein ANDERER LLM-Test um ("Test timed out in
 * 10000ms") — critic-worker, identify-v3-stage3, product-chat-v3, je nachdem
 * wer die langsame Runde erwischte. Gemessen: dieselbe Datei lokal 877 ms,
 * auf dem Runner 25 367 ms.
 *
 * Dies ist der DRITTE Vorfall derselben Bauart; `vitest.setup.js` schaltet aus
 * genau diesem Grund bereits INTEGRATION_CREDENTIALS_STORE und
 * GPSR_GATE_SELF_SEARCH ab.
 *
 * Der Schalter ändert NUR den Weg zur Konfiguration, nicht das Ergebnis: mit
 * `off` meldet der Speicher sofort "nicht gefunden" — exakt der Zustand, in dem
 * die Tests heute nach der Wartezeit landen. Production bleibt unberührt
 * (Vorgabe `on`).
 */

const path = require('path');

const llmConfigPath = require.resolve('../../lib/llm-config');
const firestoreModulePath = require.resolve('../../lib/firestore');
const gcpFsPath = require.resolve('@google-cloud/firestore');

/** Zählt jeden Zugriff — ein Aufruf im `off`-Modus ist ein Testfehler. */
let firestoreCalls = 0;

function installFirestoreSpy() {
  firestoreCalls = 0;
  try { require(gcpFsPath); } catch (_) { /* optional */ }
  require.cache[gcpFsPath] = {
    id: gcpFsPath,
    filename: gcpFsPath,
    loaded: true,
    exports: {
      FieldValue: { serverTimestamp: () => null, delete: () => null },
      Firestore: function () {},
    },
  };

  const spy = {
    collection() {
      firestoreCalls += 1;
      return {
        doc: () => ({
          get: async () => ({ exists: false, id: 'x', data: () => ({}) }),
          collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }) }),
        }),
        get: async () => ({ docs: [] }),
      };
    },
  };

  try { require(firestoreModulePath); } catch (_) { /* optional */ }
  require.cache[firestoreModulePath] = {
    id: firestoreModulePath,
    filename: firestoreModulePath,
    loaded: true,
    exports: { firestore: spy, FieldValue: { serverTimestamp: () => null } },
  };
}

function loadLlmConfig() {
  delete require.cache[llmConfigPath];
  return require(llmConfigPath);
}

describe('llm-config: LLM_CONFIG_STORE', () => {
  const vorher = process.env.LLM_CONFIG_STORE;

  beforeEach(() => {
    installFirestoreSpy();
  });

  afterEach(() => {
    if (vorher === undefined) delete process.env.LLM_CONFIG_STORE;
    else process.env.LLM_CONFIG_STORE = vorher;
  });

  it('off: getScope fasst Firestore gar nicht an und meldet sofort "nicht gefunden"', async () => {
    process.env.LLM_CONFIG_STORE = 'off';
    const { getScope } = loadLlmConfig();

    const result = await getScope('chat-context');

    expect(result).toBe(null);
    expect(firestoreCalls).toBe(0);
  });

  it('off: resolveScopeConfig scheitert SOFORT statt zu warten — Aufrufer nehmen ihre Vorgabewerte', async () => {
    process.env.LLM_CONFIG_STORE = 'off';
    const { resolveScopeConfig } = loadLlmConfig();

    const start = Date.now();
    await expect(resolveScopeConfig('chat-context', null, {})).rejects.toThrow(/unknown scope/i);
    const dauer = Date.now() - start;

    expect(firestoreCalls).toBe(0);
    // Kein Netz, keine Zugangsdaten-Suche: das muss praktisch ohne Zeitverlust
    // scheitern. Genau diese Wartezeit sprengte auf dem Runner das Zeitbudget.
    expect(dauer).toBeLessThan(250);
  });

  it('Vorgabe (Schalter nicht gesetzt): Firestore wird wie bisher gelesen', async () => {
    delete process.env.LLM_CONFIG_STORE;
    const { getScope } = loadLlmConfig();

    await getScope('chat-context');

    expect(firestoreCalls).toBeGreaterThan(0);
  });

  it("'on' ist gleichbedeutend mit der Vorgabe", async () => {
    process.env.LLM_CONFIG_STORE = 'on';
    const { getScope } = loadLlmConfig();

    await getScope('chat-context');

    expect(firestoreCalls).toBeGreaterThan(0);
  });

  it('der Schalter wird bei JEDEM Aufruf gelesen, nicht beim Laden des Moduls eingefroren', async () => {
    delete process.env.LLM_CONFIG_STORE;
    const { getScope } = loadLlmConfig();

    await getScope('chat-context');
    const nachErstem = firestoreCalls;
    expect(nachErstem).toBeGreaterThan(0);

    process.env.LLM_CONFIG_STORE = 'off';
    const result = await getScope('chat-context');

    expect(result).toBe(null);
    expect(firestoreCalls).toBe(nachErstem);
  });
});
