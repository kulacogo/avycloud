'use strict';

/**
 * api.js — Zugang zu AvyCloud aus dem lokalen Netz.
 *
 * Warum ueberhaupt ein eigenes Programm ausserhalb des Backends: das Backend
 * laeuft auf Cloud Run in europe-west3 und kann eine private Adresse wie
 * 192.168.178.61 prinzipiell nicht erreichen. Ein Cron-Job im Backend koennte
 * den Foto-Share also nie sehen. Der Agent laeuft im selben Netz wie der Share
 * und spricht ueber HTTPS mit den bestehenden Schnittstellen — es wurde dafuer
 * KEINE neue Route gebaut.
 *
 * Anmeldung: Firebase-Benutzer (eigenes Dienstkonto anlegen, nicht das Konto
 * eines Mitarbeiters mitbenutzen). Das Zugangstoken gilt eine Stunde und wird
 * vor Ablauf erneuert.
 */

const AUTH_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const REFRESH_URL = 'https://securetoken.googleapis.com/v1/token';
// Etwas vor Ablauf erneuern, damit kein Aufruf mit totem Token losfaehrt.
const TOKEN_PUFFER_MS = 5 * 60 * 1000;

function erstelleApi({ basisUrl, firebaseApiKey, email, passwort, fetchImpl = globalThis.fetch }) {
  if (!basisUrl) throw new Error('AVYCLOUD_URL fehlt.');
  if (!firebaseApiKey) throw new Error('FIREBASE_API_KEY fehlt.');
  if (!email || !passwort) throw new Error('AGENT_EMAIL / AGENT_PASSWORT fehlen.');

  let token = null;
  let refreshToken = null;
  let gueltigBis = 0;

  async function anmelden() {
    const antwort = await fetchImpl(`${AUTH_URL}?key=${encodeURIComponent(firebaseApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: passwort, returnSecureToken: true }),
    });
    const daten = await antwort.json().catch(() => ({}));
    if (!antwort.ok) {
      throw new Error(`Anmeldung fehlgeschlagen: ${daten?.error?.message || antwort.status}`);
    }
    token = daten.idToken;
    refreshToken = daten.refreshToken;
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
    gueltigBis = Date.now() + Number(daten.expires_in || 3600) * 1000;
  }

  async function holeToken() {
    if (!token) await anmelden();
    else if (Date.now() > gueltigBis - TOKEN_PUFFER_MS) await erneuern();
    return token;
  }

  function baueFormular(dateien, felder = {}) {
    const form = new FormData();
    for (const datei of dateien) {
      form.append('images', new Blob([datei.inhalt], { type: 'image/jpeg' }), datei.name);
    }
    for (const [schluessel, wert] of Object.entries(felder)) {
      if (wert != null && wert !== '') form.append(schluessel, String(wert));
    }
    return form;
  }

  async function sende(pfad, form, { timeoutMs = 400000 } = {}) {
    const abbruch = new AbortController();
    const uhr = setTimeout(() => abbruch.abort(), timeoutMs);
    try {
      const antwort = await fetchImpl(`${basisUrl}${pfad}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await holeToken()}` },
        body: form,
        signal: abbruch.signal,
      });
      const daten = await antwort.json().catch(() => ({}));
      if (!antwort.ok || daten?.ok === false) {
        const fehler = daten?.error?.message || `HTTP ${antwort.status}`;
        const code = daten?.error?.code;
        const err = new Error(fehler);
        err.code = code;
        err.status = antwort.status;
        throw err;
      }
      return daten;
    } finally {
      clearTimeout(uhr);
    }
  }

  return {
    /** Laesst die Bilderkennung entscheiden, welche Fotos zu welchem Produkt gehoeren. */
    async gruppiereBilder(dateien) {
      const daten = await sende('/api/v2/group-images', baueFormular(dateien), { timeoutMs: 180000 });
      return daten?.data?.groups || [];
    },

    /** Erfasst ein Produkt. Der Server entscheidet selbst, ob es schon existiert. */
    async erfasse({ dateien, barcodes = '', losCode, hint = '' }) {
      const daten = await sende('/api/v2/identify', baueFormular(dateien, {
        barcodes, lotCode: losCode, hint, locale: 'de-DE',
      }));
      return { produkt: daten?.data || null, meta: daten?.meta || {} };
    },
  };
}

module.exports = { erstelleApi };
