// globals: true in vitest.config.js — describe/it/expect/vi are global

// Patch ops-alert so checkHeartbeats' alert is observable and never hits firestore.
const sendOpsAlertMock = vi.fn(async () => 'ok');
require.cache[require.resolve('../lib/ops-alert')] = {
  id: require.resolve('../lib/ops-alert'),
  filename: require.resolve('../lib/ops-alert'),
  loaded: true,
  exports: { sendOpsAlert: sendOpsAlertMock },
  children: [],
  paths: [],
};

const hb = require('../lib/cron-heartbeat');

describe('cron-heartbeat dead-man-switch', () => {
  beforeEach(() => {
    hb._reset();
    sendOpsAlertMock.mockClear();
  });

  it('does not flag a freshly-registered job (grace window)', () => {
    hb.registerCronJob('drain', 1000);
    const stale = hb.checkHeartbeats(Date.now());
    expect(stale).toHaveLength(0);
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  it('flags a job that has not beaten within staleMs and alerts once', () => {
    hb.registerCronJob('drain', 1000);
    const future = Date.now() + 5000;
    const stale = hb.checkHeartbeats(future);
    expect(stale.map((s) => s.name)).toContain('drain');
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
    expect(sendOpsAlertMock.mock.calls[0][0].source).toBe('cron-watchdog');
    expect(sendOpsAlertMock.mock.calls[0][0].severity).toBe('critical');

    // Still stale on the next check, but does NOT re-alert (one-shot).
    hb.checkHeartbeats(future + 1000);
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms the alert after a successful beat', () => {
    hb.registerCronJob('drain', 1000);
    hb.checkHeartbeats(Date.now() + 5000); // alert #1
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);

    hb.beat('drain'); // recovered
    const stale = hb.checkHeartbeats(Date.now());
    expect(stale).toHaveLength(0);

    hb.checkHeartbeats(Date.now() + 5000); // stale again → alert #2
    expect(sendOpsAlertMock).toHaveBeenCalledTimes(2);
  });

  it('ignores jobs registered without a staleMs (beat-only auto-register)', () => {
    hb.beat('untracked');
    const stale = hb.checkHeartbeats(Date.now() + 999999);
    expect(stale).toHaveLength(0);
  });
});
