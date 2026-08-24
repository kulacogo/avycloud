/**
 * Druckwarteschlange — damit Drucken IMMER ueber AvyCloud laeuft.
 *
 * WARUM UEBERHAUPT EINE WARTESCHLANGE:
 * Das Backend laeuft auf Cloud Run in europe-west3 und kann eine private
 * LAN-Adresse (192.168.x.x) prinzipiell nicht erreichen — dieselbe Wand wie
 * beim Foto-Agenten. Der Browser des Handscanners koennte den Drucker zwar
 * sehen, darf aber von einer HTTPS-Seite aus kein http:// im lokalen Netz
 * aufrufen (gemischte Inhalte).
 *
 * Also andersherum: AvyCloud legt den Druckauftrag ab, und ein kleines
 * Programm IM Netz (`tools/print-agent/`) holt ihn und schickt ihn an den
 * richtigen Drucker. Der Bediener sieht nie eine Android-Druckauswahl.
 *
 * Diese Datei haelt die Entscheidungen (rein, testbar) getrennt von den
 * Firestore-Zugriffen.
 */

const PRINT_JOBS_COLLECTION = 'print_jobs';
const PRINT_AGENTS_COLLECTION = 'print_agents';

/** Nach so vielen vergeblichen Versuchen gilt ein Auftrag als gescheitert. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Ab wann ein Agent als offline gilt. Der Agent meldet sich beim Abholen; er
 * fragt im Sekundentakt, also ist eine Minute Stille schon viel.
 */
const AGENT_STALE_MS = 90 * 1000;

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  DONE: 'done',
  FAILED: 'failed',
});

/**
 * Wartezeit vor dem naechsten Versuch. Bewusst kurz — ein Druckauftrag ist
 * nur solange etwas wert, wie das Paket noch am Packtisch steht.
 */
function computeRetryDelayMs(attempts) {
  const n = Math.max(0, Math.floor(Number(attempts) || 0));
  return Math.min(30_000, 2_000 * 2 ** n);
}

/**
 * Lebt der Druck-Agent?
 *
 * Das ist die Frage, an der die Oberflaeche entscheidet, ob sie den Auftrag in
 * die Warteschlange legt oder auf den alten Teilen-Weg zurueckfaellt. Ohne
 * diese Pruefung wuerde ein Auftrag bei totem Agenten still in der
 * Warteschlange verrotten — und der Bediener steht mit einem unfrankierten
 * Paket da, ohne es zu merken. Das waere schlimmer als die Android-Auswahl.
 *
 * @param {string|null} lastSeenIso
 * @param {number} nowMs
 * @param {number} [staleMs]
 */
function isAgentOnline(lastSeenIso, nowMs = Date.now(), staleMs = AGENT_STALE_MS) {
  if (!lastSeenIso) return false;
  const seen = Date.parse(lastSeenIso);
  if (!Number.isFinite(seen)) return false;
  return nowMs - seen <= staleMs;
}

/**
 * Darf ein gescheiterter Auftrag noch einmal?
 */
function shouldRetry(job, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const attempts = Math.max(0, Math.floor(Number(job?.attempts) || 0));
  return attempts < Math.max(1, Number(job?.maxAttempts) || maxAttempts);
}

/**
 * Auftragsdokument bauen und dabei pruefen.
 *
 * Wirft bei fehlenden Pflichtangaben — ein Druckauftrag ohne Ziel waere ein
 * Auftrag, den der Agent nicht zuordnen kann.
 */
function buildPrintJob({
  tenantId,
  orderId,
  shipmentId = null,
  formatKey,
  printerRole,
  widthMm,
  heightMm,
  copies = 1,
  createdBy = null,
  nowIso = new Date().toISOString(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  if (!tenantId) throw new Error('buildPrintJob: tenantId fehlt');
  if (!orderId) throw new Error('buildPrintJob: orderId fehlt');
  if (!printerRole) throw new Error('buildPrintJob: printerRole fehlt');

  const safeCopies = Math.min(10, Math.max(1, Math.floor(Number(copies) || 1)));

  return {
    tenantId,
    kind: 'shipping_label',
    orderId,
    shipmentId: shipmentId || null,
    formatKey: formatKey || null,
    printerRole,
    widthMm: Number(widthMm) || null,
    heightMm: Number(heightMm) || null,
    copies: safeCopies,
    status: JOB_STATUS.QUEUED,
    attempts: 0,
    maxAttempts: Math.max(1, Math.floor(Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS)),
    createdAt: nowIso,
    createdBy: createdBy || null,
    notBefore: nowIso,
    claimedAt: null,
    claimedBy: null,
    finishedAt: null,
    error: null,
  };
}

/**
 * Ist dieser Auftrag jetzt abholbereit?
 *
 * Rein, damit die Auswahl ohne Firestore pruefbar ist. `claimed` zaehlt wieder
 * als abholbereit, sobald die Zusage abgelaufen ist — sonst blockiert ein
 * Agent, der mitten im Druck abstuerzt, den Auftrag fuer immer.
 */
function isClaimable(job, nowMs = Date.now(), claimTimeoutMs = 60_000) {
  if (!job) return false;
  if (job.status === JOB_STATUS.DONE || job.status === JOB_STATUS.FAILED) return false;

  const notBefore = job.notBefore ? Date.parse(job.notBefore) : 0;
  if (Number.isFinite(notBefore) && notBefore > nowMs) return false;

  if (job.status === JOB_STATUS.CLAIMED) {
    const claimedAt = job.claimedAt ? Date.parse(job.claimedAt) : 0;
    if (!Number.isFinite(claimedAt)) return true;
    return nowMs - claimedAt > claimTimeoutMs;
  }

  return job.status === JOB_STATUS.QUEUED;
}

/**
 * Notbremse. Nur der exakte Wert `'off'` schaltet ab — gleiche Strenge wie bei
 * den Geld-Schaltern: ein Tippfehler darf den Druckweg nicht still umlegen.
 */
function printQueueEnabled() {
  return String(process.env.PRINT_QUEUE || '').trim().toLowerCase() !== 'off';
}

module.exports = {
  PRINT_JOBS_COLLECTION,
  PRINT_AGENTS_COLLECTION,
  JOB_STATUS,
  DEFAULT_MAX_ATTEMPTS,
  AGENT_STALE_MS,
  computeRetryDelayMs,
  isAgentOnline,
  shouldRetry,
  buildPrintJob,
  isClaimable,
  printQueueEnabled,
};
