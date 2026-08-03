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
