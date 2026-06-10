// globals: true in vitest.config.js — describe/it/expect/vi are global

// ─── Mock firestore (require.cache patching for CJS) ──────────────────
const addMock = vi.fn(async () => ({ id: 'alert-1' }));
const mockFirestore = {
  collection: vi.fn(() => ({ add: addMock })),
};
require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: mockFirestore },
  children: [],
  paths: [],
};

const { sendOpsAlert } = require('../lib/ops-alert');

describe('sendOpsAlert', () => {
  const origUrl = process.env.SLACK_ALERTS_URL;
  let fetchSpy;

  beforeEach(() => {
    addMock.mockClear();
    mockFirestore.collection.mockClear();
    fetchSpy = vi.fn(async () => ({ ok: true }));
    global.fetch = fetchSpy;
  });

  afterEach(() => {
    if (origUrl === undefined) delete process.env.SLACK_ALERTS_URL;
    else process.env.SLACK_ALERTS_URL = origUrl;
  });

  it('writes an audit row to ops_alerts with the right shape', async () => {
    delete process.env.SLACK_ALERTS_URL;
    await sendOpsAlert({ source: 'order-intake-kaufland', message: 'reserveStock failed', tenantId: 'trendocean', context: { sku: 'SKU-A' } });
    expect(mockFirestore.collection).toHaveBeenCalledWith('ops_alerts');
    expect(addMock).toHaveBeenCalledTimes(1);
    const row = addMock.mock.calls[0][0];
    expect(row.source).toBe('order-intake-kaufland');
    expect(row.tenantId).toBe('trendocean');
    expect(row.context).toEqual({ sku: 'SKU-A' });
    expect(row.severity).toBe('error');
  });

  it('posts to Slack when SLACK_ALERTS_URL is configured', async () => {
    process.env.SLACK_ALERTS_URL = 'https://hooks.slack.test/xyz';
    await sendOpsAlert({ source: 's', message: 'boom', severity: 'critical' });
    // fire-and-forget — let the microtask flush
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://hooks.slack.test/xyz');
  });

  it('does NOT post to Slack when URL is unset, but still writes audit', async () => {
    delete process.env.SLACK_ALERTS_URL;
    await sendOpsAlert({ source: 's', message: 'boom' });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it('never throws even if the audit write fails', async () => {
    delete process.env.SLACK_ALERTS_URL;
    addMock.mockRejectedValueOnce(new Error('firestore down'));
    await expect(sendOpsAlert({ source: 's', message: 'boom' })).resolves.toMatch(/boom/);
  });
});
