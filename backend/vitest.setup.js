'use strict';

/**
 * Globales Vitest-Setup.
 *
 * INTEGRATION_CREDENTIALS_STORE=off: Die Runtime-Credential-Auflösung
 * (services/integration-store.js resolveProviderCredentials) schaut in
 * Production ZUERST in Firestore (Self-Service-Zugangsdaten aus dem
 * IntegrationWizard). In Tests würde dieser Lookup einen ECHTEN
 * Firestore-Client hochziehen (hängt ohne GCP-Credentials bis zum Timeout
 * bzw. frisst node-fetch-Stub-Queues über gaxios leer). Deshalb ist der
 * Store-Lookup in Tests global aus — Credentials kommen wie früher aus
 * ENV/Secret-Manager-Stubs. Tests, die den Store-Pfad selbst testen
 * (integration-live-credentials.test.js), schalten ihn explizit wieder ein.
 */
process.env.INTEGRATION_CREDENTIALS_STORE = 'off';

/**
 * GPSR_GATE_SELF_SEARCH=off: Das GPSR-Beleg-Gate beschafft sich fehlende
 * Impressum-URLs seit 2026-08-04 selbst (Registry-Lookup = echter
 * Firestore-Client, Web-Suche = echtes Netz). In Tests global aus —
 * Tests, die die Selbstsuche selbst testen
 * (gpsr-gate-self-search-keep-unverified.test.js), schalten sie explizit
 * wieder ein und injizieren searchImpl/registryLookupImpl.
 */
process.env.GPSR_GATE_SELF_SEARCH = 'off';

/**
 * LLM_CONFIG_STORE=off: `resolveScopeConfig` (lib/llm-config.js) holt die
 * Prompt-/Modell-Konfiguration bei JEDEM Aufruf aus Firestore — zwei
 * Round-Trips, mitten im Testlauf. Ohne Google-Zugangsdaten sucht der Client
 * sie erst über die Metadaten-Erkennung, bevor er aufgibt.
 *
 * Fachlich war das folgenlos (alle Aufrufer fangen den Fehler ab und nehmen
 * ihre eingebauten Vorgabewerte), die WARTEZEIT lag aber innerhalb des
 * 10-Sekunden-Budgets pro Test. Auf dem GitHub-Runner fiel deshalb in jedem
 * Lauf ein ANDERER LLM-Test um ("Test timed out in 10000ms") — critic-worker,
 * identify-v3-stage3, product-chat-v3 —, je nachdem wer die langsame Runde
 * erwischte. Gemessen: dieselbe Datei lokal 877 ms, auf dem Runner 25 367 ms.
 *
 * Mit `off` meldet der Speicher sofort "nicht gefunden" — exakt der Zustand,
 * in dem die Tests bisher nach der Wartezeit landeten. Gleiches Ergebnis,
 * ohne das Warten. Tests, die den Firestore-Pfad selbst prüfen
 * (llm-config-store-off.test.js), schalten ihn explizit wieder ein.
 */
process.env.LLM_CONFIG_STORE = 'off';
