'use strict';

/**
 * ebay-sync-error-kind.js — ordnet eine eBay-Sync-Fehlermeldung einem Fehlertyp zu.
 *
 * Vorfall 2026-10-08: das Banner „Angebots-Abgleich mit eBay gestoert" bot bei
 * LEEREM TAGESKONTINGENT den Knopf „eBay neu verbinden" an. Neu verbinden
 * heilt kein Kontingent — der Bediener muss wissen, ob er warten (Reset
 * 09:00 MESZ) oder die Anmeldung erneuern soll.
 *
 *   quota — eBay-Ablehnung, Breaker-Skip oder Budget-Reservierung
 *   auth  — Token/Anmeldung/Konfiguration
 *   other — alles Weitere (Netz, Parser, eBay-Fehler)
 *   null  — keine Meldung
 */

const QUOTA_PATTERN = /exceeded usage limit|usage limit|call limit|quota|tagesbudget|rate.?limit|too many requests/i;
// eBay antwortet auf Site 77 DEUTSCH („Die Validierung des Authentifizierungs-
// Tokens … ist fehlgeschlagen") — deshalb auch die deutschen Formen.
const AUTH_PATTERN = /iaf token|auth token|access token|oauth|invalid_grant|token.*(expired|invalid|revoked|abgelaufen|ung[üu]ltig|fehlgeschlagen)|(expired|invalid|revoked).*token|authentifizierung|unauthori[sz]ed|config missing|not connected|nicht verbunden|EBAY_NOT_CONNECTED|EBAY_REFRESH_|EBAY_TOKEN_|\b401\b/i;

function classifyEbaySyncError(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  if (QUOTA_PATTERN.test(text)) return 'quota';
  if (AUTH_PATTERN.test(text)) return 'auth';
  return 'other';
}

module.exports = { classifyEbaySyncError, QUOTA_PATTERN, AUTH_PATTERN };
