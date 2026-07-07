/**
 * User Session Tracking Service
 *
 * Tracks user login sessions with device, browser, location, and activity data.
 * Collection: userSessions
 *
 * Usage:
 *   const { createSession, heartbeat, endSession } = require('./user-sessions');
 *   const sessionId = await createSession({ userId, userEmail, tenantId, ip, userAgent, authProvider, clientInfo });
 */

const { firestore } = require('../lib/firestore');
const UAParser = require('ua-parser-js');
const geoip = require('geoip-lite');

const SESSIONS_COLLECTION = 'userSessions';

// Sessions without heartbeat for longer than this are considered stale.
const STALE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes

// TODO (Betrieb): `userSessions` wächst unbegrenzt (createSession fügt bei jedem
// Login ein Doc an, endSession/heartbeat setzt nur Felder). Es gibt KEINEN
// TTL-/Cleanup-Job. Bei >>1000 Docs pro Tenant liefern die 1000-Doc-Queries
// unten nur einen Ausschnitt. Kein Cron hier (Scope), aber ein späterer
// TTL-Delete (z. B. Docs älter als 90 Tage) sollte ergänzt werden.

/**
 * Erkennt den Firestore-FAILED_PRECONDITION-Fehler, der geworfen wird, wenn ein
 * benötigter Composite-Index (where + orderBy auf unterschiedlichem Feld) fehlt.
 * Damit degradieren wir robust auf die alte Single-Field-Query statt zu crashen.
 */
function isMissingIndexError(err) {
  if (!err) return false;
  return (
    err.code === 9 || // gRPC FAILED_PRECONDITION
    err.code === 'failed-precondition' ||
    /FAILED_PRECONDITION|requires an index|composite index|needs an index/i.test(String(err.message || ''))
  );
}

/**
 * Parse User-Agent string into structured browser/OS/device data.
 */
function parseUserAgent(uaString) {
  const parser = new UAParser(uaString || '');
  const result = parser.getResult();
  return {
    browser: {
      name: result.browser.name || 'Unknown',
      version: result.browser.version || '',
    },
    os: {
      name: result.os.name || 'Unknown',
      version: result.os.version || '',
    },
    device: {
      type: result.device.type || 'desktop',
      vendor: result.device.vendor || '',
      model: result.device.model || '',
    },
  };
}

/**
 * Look up geo data from IP address using the local MaxMind GeoLite2 database.
 */
function lookupGeo(ip) {
  if (!ip) return null;
  // Strip IPv6 prefix for mapped IPv4
  const cleanIp = ip.replace(/^::ffff:/, '');
  const geo = geoip.lookup(cleanIp);
  if (!geo) return null;
  return {
    country: geo.country || '',
    region: geo.region || '',
    city: geo.city || '',
    lat: geo.ll?.[0] ?? null,
    lon: geo.ll?.[1] ?? null,
    timezone: geo.timezone || '',
  };
}

/**
 * Create a new user session.
 *
 * @param {Object} params
 * @param {string} params.userId - Firebase Auth UID
 * @param {string} params.userEmail - User email
 * @param {string} params.tenantId - Tenant ID
 * @param {string} params.ip - Client IP address
 * @param {string} params.userAgent - Raw User-Agent string
 * @param {string} params.authProvider - Firebase auth provider (e.g. 'password')
 * @param {Object} [params.clientInfo] - Client-side collected data
 * @returns {Promise<string>} sessionId
 */
async function createSession({ userId, userEmail, tenantId = 'default', ip, userAgent, authProvider, clientInfo = {} }) {
  const now = new Date().toISOString();
  const parsed = parseUserAgent(userAgent);
  const geo = lookupGeo(ip);

  const doc = {
    userId,
    userEmail,
    tenantId,
    loginAt: now,
    logoutAt: null,
    lastActiveAt: now,
    durationSeconds: null,
    status: 'active',
    authProvider: authProvider || 'unknown',
    ip: ip || '',
    geo,
    userAgent: userAgent || '',
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
    client: {
      screenResolution: clientInfo.screenResolution || '',
      viewportSize: clientInfo.viewportSize || '',
      devicePixelRatio: clientInfo.devicePixelRatio ?? null,
      language: clientInfo.language || '',
      languages: Array.isArray(clientInfo.languages) ? clientInfo.languages : [],
      timezone: clientInfo.timezone || '',
      referrer: clientInfo.referrer || '',
      connectionType: clientInfo.connectionType || null,
      connectionDownlink: clientInfo.connectionDownlink ?? null,
      connectionRtt: clientInfo.connectionRtt ?? null,
      saveData: Boolean(clientInfo.saveData),
      isPwa: Boolean(clientInfo.isPwa),
      touchPoints: clientInfo.touchPoints ?? 0,
      cookieEnabled: clientInfo.cookieEnabled !== false,
      doNotTrack: clientInfo.doNotTrack || null,
      hardwareConcurrency: clientInfo.hardwareConcurrency ?? null,
      deviceMemory: clientInfo.deviceMemory ?? null,
      platform: clientInfo.platform || '',
      colorScheme: clientInfo.colorScheme || 'dark',
      reducedMotion: Boolean(clientInfo.reducedMotion),
      pdfViewerEnabled: clientInfo.pdfViewerEnabled !== false,
    },
  };

  const ref = await firestore.collection(SESSIONS_COLLECTION).add(doc);
  return ref.id;
}

/**
 * Update session heartbeat (marks session as active).
 *
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {string} params.tenantId
 */
async function heartbeat({ sessionId, tenantId = 'default' }) {
  const ref = firestore.collection(SESSIONS_COLLECTION).doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const data = snap.data();
  if (data.tenantId !== tenantId) return;

  await ref.update({
    lastActiveAt: new Date().toISOString(),
    status: 'active',
  });
}

/**
 * End a session (logout or tab close).
 *
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {string} params.tenantId
 * @param {string} [params.userId] - Optional: verify session belongs to user
 */
async function endSession({ sessionId, tenantId = 'default', userId }) {
  const ref = firestore.collection(SESSIONS_COLLECTION).doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const data = snap.data();
  if (data.tenantId !== tenantId) return;
  if (userId && data.userId !== userId) return;
  if (data.status === 'offline') return;

  const now = new Date().toISOString();
  const loginAt = new Date(data.loginAt);
  const logoutAt = new Date(now);
  const durationSeconds = Math.round((logoutAt.getTime() - loginAt.getTime()) / 1000);

  await ref.update({
    logoutAt: now,
    lastActiveAt: now,
    durationSeconds,
    status: 'offline',
  });
}

/**
 * Query sessions with filters, ordered by loginAt DESC.
 *
 * @param {Object} params
 * @param {string} [params.tenantId]
 * @param {string} [params.userId]
 * @param {number} [params.limit]
 * @param {string} [params.startAfter] - ISO timestamp cursor
 * @returns {Promise<Array>}
 */
async function querySessions({ tenantId = 'default', userId = null, limit = 50, startAfter = null } = {}) {
  // BUGFIX (2026-07): Ohne orderBy ordnet Firestore nach __name__ (zufällige
  // add-IDs). Ab >1000 Docs pro Tenant lieferte die 1000-Doc-Query damit einen
  // BELIEBIGEN Ausschnitt statt der NEUESTEN Sessions. Jetzt server-seitig nach
  // loginAt DESC ordnen. Die Kombination (tenantId ==) + (orderBy loginAt desc)
  // braucht einen Composite-Index [tenantId ASC, loginAt DESC]; fehlt er, wirft
  // Firestore FAILED_PRECONDITION → wir degradieren robust auf die alte
  // Single-Field-Query mit Client-Sort (kein Crash, kein Datenverlust).
  const col = firestore.collection(SESSIONS_COLLECTION);
  let docs;
  try {
    const snap = await col
      .where('tenantId', '==', tenantId)
      .orderBy('loginAt', 'desc')
      .limit(1000)
      .get();
    docs = snap.docs;
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    console.warn('[user-sessions] querySessions: Composite-Index [tenantId, loginAt desc] fehlt — Fallback auf Client-Sort:', err.message);
    const snap = await col
      .where('tenantId', '==', tenantId)
      .limit(1000)
      .get();
    docs = snap.docs;
  }

  let results = docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // Sort by loginAt DESC (client-side; idempotent, deckt auch den Fallback-Pfad ab)
  results.sort((a, b) => (b.loginAt || '').localeCompare(a.loginAt || ''));

  if (userId) {
    results = results.filter((s) => s.userId === userId);
  }

  if (startAfter) {
    const idx = results.findIndex((s) => s.loginAt === startAfter);
    if (idx >= 0) {
      results = results.slice(idx + 1);
    }
  }

  return results.slice(0, Math.min(limit, 500));
}

/**
 * Get currently active sessions.
 * Also expires stale sessions lazily.
 *
 * @param {Object} params
 * @param {string} [params.tenantId]
 * @returns {Promise<Array>}
 */
async function getActiveSessions({ tenantId = 'default' } = {}) {
  // BUGFIX (2026-07): analog zu querySessions — ohne orderBy lieferte die
  // 1000-Doc-Query ab >1000 Docs einen zufälligen __name__-Ausschnitt statt der
  // neuesten aktiven Sessions. Jetzt server-seitig status==active + loginAt DESC.
  // Braucht Composite-Index [tenantId ASC, status ASC, loginAt DESC]; fehlt er,
  // degradieren wir robust auf die alte Single-Field-Query (Client-Filter bleibt
  // unten erhalten, daher weiterhin korrekt).
  const col = firestore.collection(SESSIONS_COLLECTION);
  let docs;
  try {
    const snap = await col
      .where('tenantId', '==', tenantId)
      .where('status', '==', 'active')
      .orderBy('loginAt', 'desc')
      .limit(1000)
      .get();
    docs = snap.docs;
  } catch (err) {
    if (!isMissingIndexError(err)) throw err;
    console.warn('[user-sessions] getActiveSessions: Composite-Index [tenantId, status, loginAt desc] fehlt — Fallback auf Client-Filter:', err.message);
    const snap = await col
      .where('tenantId', '==', tenantId)
      .limit(1000)
      .get();
    docs = snap.docs;
  }

  const now = Date.now();
  const active = [];
  const staleUpdates = [];

  for (const doc of docs) {
    const data = { id: doc.id, ...doc.data() };
    // Skip non-active sessions — defense-in-depth: der Fallback-Pfad filtert
    // status nicht server-seitig, daher hier weiterhin nötig (im Index-Pfad no-op).
    if (data.status !== 'active') continue;

    const lastActive = new Date(data.lastActiveAt).getTime();

    if (now - lastActive > STALE_THRESHOLD_MS) {
      // Mark stale session as offline (lazy cleanup)
      staleUpdates.push(
        doc.ref.update({
          status: 'offline',
          logoutAt: data.lastActiveAt,
          durationSeconds: Math.round((lastActive - new Date(data.loginAt).getTime()) / 1000),
        })
      );
    } else {
      active.push(data);
    }
  }

  // Fire-and-forget stale session cleanup
  if (staleUpdates.length > 0) {
    Promise.all(staleUpdates).catch((err) => {
      console.error('[user-sessions] Stale cleanup error:', err.message);
    });
  }

  return active;
}

module.exports = {
  createSession,
  heartbeat,
  endSession,
  querySessions,
  getActiveSessions,
  SESSIONS_COLLECTION,
  // Exported for testing
  parseUserAgent,
  lookupGeo,
};
