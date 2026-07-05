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
