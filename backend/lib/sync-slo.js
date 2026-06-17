/**
 * sync-slo.js — SLO-Klassifizierung für den Marketplace-Sync-Backlog.
 *
 * Reine, dependency-freie Funktion (Teil E, Task 7 des Master-Plans). Sie bewertet
 * die Menge offener (`status: 'pending'`) Einträge aus `stock_operation_failures`
 * und liefert eine Ampel für die `sync`-Sektion in `GET /api/admin/system-health`.
 *
 * Schwellen (aus dem Plan, Teil E Task 7):
 *   - warn:     pendingCount >= 25  ODER  ältester Eintrag > 30 min alt
 *   - critical: pendingCount >= 100 ODER  ältester Eintrag > 60 min alt
 *   - sonst:    ok
 *
 * Count-Schwellen sind inklusiv (>=), Alters-Schwellen strikt (>).
 */

'use strict';

const THRESHOLDS = Object.freeze({
  warnCount: 25,
  warnAgeMinutes: 30,
  criticalCount: 100,
  criticalAgeMinutes: 60,
});

const MINUTE_MS = 60 * 1000;

/**
 * @param {Object}   params
 * @param {Array}    [params.pending=[]] - offene Failure-Docs; je Doc optional `createdAt` (ISO-String oder ms).
 * @param {number}   [params.now=Date.now()] - Referenzzeit in ms epoch.
 * @returns {{status:'ok'|'warn'|'critical', pendingCount:number, oldestAgeMinutes:number|null,
 *           oldestCreatedAt:string|null, thresholds:Object, reasons:string[]}}
 */
function computeSyncSlo({ pending = [], now = Date.now() } = {}) {
  const docs = Array.isArray(pending) ? pending : [];
  const pendingCount = docs.length;

  // Ältesten gültigen createdAt-Zeitstempel finden (ungültige werden gezählt, aber beim Alter ignoriert).
  let oldestMs = null;
  let oldestCreatedAt = null;
  for (const doc of docs) {
    const raw = doc && doc.createdAt;
    if (raw == null) continue;
    const ts = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(ts)) continue;
    if (oldestMs === null || ts < oldestMs) {
      oldestMs = ts;
      oldestCreatedAt = typeof raw === 'number' ? new Date(raw).toISOString() : raw;
    }
  }

  const oldestAgeMs = oldestMs === null ? null : Math.max(0, now - oldestMs);
  const oldestAgeMinutes = oldestAgeMs === null ? null : Math.round(oldestAgeMs / MINUTE_MS);

  const reasons = [];

  const criticalByCount = pendingCount >= THRESHOLDS.criticalCount;
  const criticalByAge = oldestAgeMs !== null && oldestAgeMs > THRESHOLDS.criticalAgeMinutes * MINUTE_MS;
  const warnByCount = pendingCount >= THRESHOLDS.warnCount;
  const warnByAge = oldestAgeMs !== null && oldestAgeMs > THRESHOLDS.warnAgeMinutes * MINUTE_MS;

  let status;
  if (criticalByCount || criticalByAge) {
    status = 'critical';
    if (criticalByCount) reasons.push(`pendingCount>=${THRESHOLDS.criticalCount}`);
    if (criticalByAge) reasons.push(`oldest>${THRESHOLDS.criticalAgeMinutes}min`);
  } else if (warnByCount || warnByAge) {
    status = 'warn';
    if (warnByCount) reasons.push(`pendingCount>=${THRESHOLDS.warnCount}`);
    if (warnByAge) reasons.push(`oldest>${THRESHOLDS.warnAgeMinutes}min`);
  } else {
    status = 'ok';
  }

  return {
    status,
    pendingCount,
    oldestAgeMinutes,
    oldestCreatedAt,
    thresholds: { ...THRESHOLDS },
    reasons,
  };
}

module.exports = { computeSyncSlo, SYNC_SLO_THRESHOLDS: THRESHOLDS };
