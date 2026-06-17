const { computeSyncSlo } = require('../lib/sync-slo');

// Helper: build a pending failure doc with a createdAt N minutes before `now`.
function pendingAgedMinutes(ageMinutes, now) {
  return { createdAt: new Date(now - ageMinutes * 60 * 1000).toISOString() };
}

describe('computeSyncSlo', () => {
  const NOW = Date.parse('2026-06-18T12:00:00.000Z');

  it('returns ok with no pending failures', () => {
    const slo = computeSyncSlo({ pending: [], now: NOW });
    expect(slo.status).toBe('ok');
    expect(slo.pendingCount).toBe(0);
    expect(slo.oldestAgeMinutes).toBeNull();
  });

  it('returns ok below all thresholds (few, fresh)', () => {
    const pending = [pendingAgedMinutes(5, NOW), pendingAgedMinutes(10, NOW)];
    const slo = computeSyncSlo({ pending, now: NOW });
    expect(slo.status).toBe('ok');
    expect(slo.pendingCount).toBe(2);
    expect(slo.oldestAgeMinutes).toBe(10);
  });

  // ── warn by count ─────────────────────────────────────────────
  it('warns when pendingCount >= 25 (boundary)', () => {
    const pending = Array.from({ length: 25 }, () => pendingAgedMinutes(1, NOW));
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('warn');
  });

  it('stays ok at 24 fresh pending (just below warn count)', () => {
    const pending = Array.from({ length: 24 }, () => pendingAgedMinutes(1, NOW));
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('ok');
  });

  // ── warn by age ───────────────────────────────────────────────
  it('warns when oldest pending is older than 30 min', () => {
    const pending = [pendingAgedMinutes(31, NOW)];
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('warn');
  });

  it('stays ok when oldest pending is exactly 30 min (strict >)', () => {
    const pending = [pendingAgedMinutes(30, NOW)];
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('ok');
  });

  // ── critical by count ─────────────────────────────────────────
  it('is critical when pendingCount >= 100 (boundary)', () => {
    const pending = Array.from({ length: 100 }, () => pendingAgedMinutes(1, NOW));
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('critical');
  });

  it('stays warn at 99 pending (just below critical count)', () => {
    const pending = Array.from({ length: 99 }, () => pendingAgedMinutes(1, NOW));
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('warn');
  });

  // ── critical by age ───────────────────────────────────────────
  it('is critical when oldest pending is older than 60 min', () => {
    const pending = [pendingAgedMinutes(61, NOW)];
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('critical');
  });

  it('stays warn when oldest pending is exactly 60 min (strict >)', () => {
    const pending = [pendingAgedMinutes(60, NOW)];
    expect(computeSyncSlo({ pending, now: NOW }).status).toBe('warn');
  });

  // ── precedence: critical wins over warn ───────────────────────
  it('reports critical when count is warn-level but age is critical-level', () => {
    const pending = [pendingAgedMinutes(90, NOW), pendingAgedMinutes(5, NOW)];
    const slo = computeSyncSlo({ pending, now: NOW });
    expect(slo.status).toBe('critical');
    expect(slo.oldestAgeMinutes).toBe(90);
  });

  // ── reporting ─────────────────────────────────────────────────
  it('exposes thresholds and reasons for the dashboard', () => {
    const pending = Array.from({ length: 100 }, () => pendingAgedMinutes(70, NOW));
    const slo = computeSyncSlo({ pending, now: NOW });
    expect(slo.thresholds).toMatchObject({
      warnCount: 25,
      warnAgeMinutes: 30,
      criticalCount: 100,
      criticalAgeMinutes: 60,
    });
    expect(Array.isArray(slo.reasons)).toBe(true);
    expect(slo.reasons.length).toBeGreaterThan(0);
  });

  // ── robustness ────────────────────────────────────────────────
  it('counts docs with missing/invalid createdAt but ignores them for age', () => {
    const pending = [{ createdAt: null }, { foo: 'bar' }, pendingAgedMinutes(5, NOW)];
    const slo = computeSyncSlo({ pending, now: NOW });
    expect(slo.pendingCount).toBe(3);
    expect(slo.oldestAgeMinutes).toBe(5);
  });

  it('defaults now to current time when omitted', () => {
    const slo = computeSyncSlo({ pending: [] });
    expect(slo.status).toBe('ok');
  });

  it('tolerates a missing/empty argument object', () => {
    expect(computeSyncSlo().status).toBe('ok');
    expect(computeSyncSlo({}).status).toBe('ok');
  });
});
