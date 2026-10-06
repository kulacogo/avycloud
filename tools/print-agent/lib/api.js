'use strict';

/**
 * api.js — Zugang zu AvyCloud aus dem lokalen Netz.
 *
 * Gleiches Muster wie beim Foto-Agenten: das Backend laeuft auf Cloud Run und
 * kann eine private Adresse (192.168.x.x) prinzipiell nicht erreichen. Also
 * holt der Agent die Auftraege ab, statt dass das Backend sie zustellt.
 *
 * Anmeldung: eigener Firebase-Benutzer (Dienstkonto anlegen, NICHT das Konto
 * eines Mitarbeiters mitbenutzen). Token gilt eine Stunde, wird vorher erneuert.
 */

const AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
const TOKEN_PUFFER_MS = 5 * 60 * 1000;

function erstelleApi({ basisUrl, firebaseApiKey, email, passwort, sessionFile, fetchImpl = globalThis.fetch }) {
  if (!basisUrl) throw new Error('AVYCLOUD_URL fehlt.');
  if (!firebaseApiKey) throw new Error('FIREBASE_API_KEY fehlt.');
  if (!sessionFile && (!email || !passwort)) throw new Error('AGENT_EMAIL / AGENT_PASSWORT fehlen.');

  let token = null;
  let refreshToken = sessionFile ? JSON.parse(require('node:fs').readFileSync(sessionFile, 'utf8')).refreshToken : null;
  const persistSession = () => {
    if (!sessionFile) return;
    const fs = require('node:fs');
    const temporary = `${sessionFile}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ refreshToken })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, sessionFile);
  };
  let gueltigBis = 0;
  let protocolVerifiedUntil = 0;

  async function anmelden() {
    if (!email || !passwort) throw new Error('Druckstation erneut anmelden.');
    const antwort = await fetchImpl(`${AUTH_URL}?key=${encodeURIComponent(firebaseApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: passwort, returnSecureToken: true }),
    });
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok) throw new Error(`Anmeldung fehlgeschlagen: ${daten?.error?.message || antwort.status}`);
    token = daten.idToken;
    refreshToken = daten.refreshToken;
    persistSession();
    gueltigBis = Date.now() + Number(daten.expiresIn || 3600) * 1000;
  }

  async function erneuern() {
    if (!refreshToken) return anmelden();
    const antwort = await fetchImpl(`${REFRESH_URL}?key=${encodeURIComponent(firebaseApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok) return anmelden();
    token = daten.id_token;
    refreshToken = daten.refresh_token || refreshToken;
    persistSession();
    gueltigBis = Date.now() + Number(daten.expires_in || 3600) * 1000;
  }

  async function holeToken() {
    if (!token) await erneuern();
    else if (Date.now() > gueltigBis - TOKEN_PUFFER_MS) await erneuern();
    return token;
  }

  async function ruf(pfad, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
    const abbruch = new AbortController();
    const uhr = setTimeout(() => abbruch.abort(), timeoutMs);
    try {
      const kopf = { Authorization: `Bearer ${await holeToken()}` };
      if (body) kopf['Content-Type'] = 'application/json';
      const antwort = await fetchImpl(`${basisUrl}${pfad}`, {
        method,
        headers: kopf,
        body: body ? JSON.stringify(body) : undefined,
        signal: abbruch.signal,
      });
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok || daten?.ok === false) {
        const err = new Error(daten?.error?.message || `HTTP ${antwort.status}`);
        err.code = daten?.error?.code;
        err.status = antwort.status;
        throw err;
      }
      return daten;
    } finally {
      clearTimeout(uhr);
    }
  }

  return {
    /** Am Leben melden — daran entscheidet die Oberflaeche den Druckweg. */
    async melde({ agentId, drucker }) {
      return ruf('/api/print/agent/heartbeat', {
        method: 'POST',
        body: { agentId, printers: drucker, protocolVersion: 2 },
      });
    },

    /** Naechsten Auftrag zuweisen lassen (oder null). */
    async holeAuftrag({ agentId }) {
      if (Date.now() >= protocolVerifiedUntil) {
        const status = await ruf('/api/print/status');
        if (status?.data?.protocolVersion !== 2) throw new Error('Backend unterstützt noch kein Druck-Protokoll 2. Station wartet auf das Update.');
        protocolVerifiedUntil = Date.now() + 30000;
      }
      const daten = await ruf('/api/print/agent/claim', { method: 'POST', body: { agentId, protocolVersion: 2 } });
      const job = daten?.data?.job || null;
      if (job && (!job.claimToken || !job.claimedByUid)) throw new Error('Druckauftrag ohne Protokoll-2-Quittung abgelehnt.');
      return job;
    },

    /** Das fertig skalierte Etikett-PDF laden. */
    async ladeDokument(jobId) {
      const abbruch = new AbortController();
      const uhr = setTimeout(() => abbruch.abort(), 60000);
      try {
        const antwort = await fetchImpl(`${basisUrl}/api/print/jobs/${encodeURIComponent(jobId)}/document`, {
          headers: { Authorization: `Bearer ${await holeToken()}` },
          signal: abbruch.signal,
        });
        if (!antwort.ok) throw new Error(`Etikett-Download fehlgeschlagen (HTTP ${antwort.status})`);
        return Buffer.from(await antwort.arrayBuffer());
      } finally {
        clearTimeout(uhr);
      }
    },

    /** Ergebnis zurueckmelden. */
    async melderErgebnis(jobId, { ok, fehler, error, action, spoolId, agentId, claimToken }) {
      return ruf(`/api/print/jobs/${encodeURIComponent(jobId)}/result`, {
        method: 'POST',
        body: { ok, error: error || fehler || undefined, action, spoolId, agentId, claimToken },
      });
    },
  };
}

module.exports = { erstelleApi };
