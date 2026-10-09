'use strict';
const { printJobKey, deliveryUpdate } = require('../lib/print-delivery');
describe('safe label delivery', () => {
  const job = { tenantId: 't', protocolVersion: 2, status: 'claimed', claimedBy: 'station', claimedByUid: 'agent-user', claimToken: 'lease', attempts: 1 };
  const actor = { tenantId: 't', uid: 'agent-user', agentId: 'station', claimToken: 'lease' };
  it('the initial print is stable across retries and devices; a reprint is explicit', () => {
    expect(printJobKey('t', 'shipment-1')).toBe(printJobKey('t', 'shipment-1'));
    expect(printJobKey('t', 'shipment-1', 'reprint-1')).not.toBe(printJobKey('t', 'shipment-1'));
    expect(printJobKey('u', 'shipment-1')).not.toBe(printJobKey('t', 'shipment-1'));
  });
  it.each([{ ...actor, uid: 'other' }, { ...actor, claimToken: 'old' }, { ...actor, tenantId: 'other' }])('rejects a stale or foreign delivery acknowledgement', (bad) => {
    expect(() => deliveryUpdate(job, bad, { action: 'begin' })).toThrow();
  });
  it('marks dispatch before CUPS and never blindly retries an uncertain dispatch', () => {
    const sending = { ...job, ...deliveryUpdate(job, actor, { action: 'begin' }) };
    expect(sending.status).toBe('dispatching');
    expect(deliveryUpdate(sending, actor, { ok: false, error: 'connection lost' }).status).toBe('uncertain');
  });
  it('a spooled receipt can be acknowledged repeatedly without making a new job', () => {
    const sent = { ...job, status: 'dispatching' };
    const done = deliveryUpdate(sent, actor, { ok: true, spoolId: 'DHL-234' });
    expect(done).toMatchObject({ status: 'done', spoolId: 'DHL-234' });
    expect(deliveryUpdate({ ...sent, ...done }, actor, { ok: true, spoolId: 'DHL-234' })).toEqual({});
  });
});
