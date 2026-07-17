'use strict';

// Aus-Schalter für BrightData-Web-Unlocker (2026-07-17): WEB_UNLOCKER_ENABLED=false
// macht fetchWithUnlocker zum sauberen No-op (kein Netzwerk-Call, kein 401).
// Modul mit frischem require.cache laden, damit die ENV zur Ladezeit greift.

const path = require('path');
const MOD = require.resolve('../../lib/web-unlocker');

function freshWithEnv(val) {
  const prev = process.env.WEB_UNLOCKER_ENABLED;
  if (val === undefined) delete process.env.WEB_UNLOCKER_ENABLED;
  else process.env.WEB_UNLOCKER_ENABLED = val;
  delete require.cache[MOD];
  const mod = require('../../lib/web-unlocker');
  return { mod, restore: () => {
    if (prev === undefined) delete process.env.WEB_UNLOCKER_ENABLED;
    else process.env.WEB_UNLOCKER_ENABLED = prev;
    delete require.cache[MOD];
  } };
}

describe('web-unlocker Aus-Schalter', () => {
  let origFetch;
  beforeEach(() => { origFetch = global.fetch; });
  afterEach(() => { global.fetch = origFetch; });

  it('disabled → No-op ohne Netzwerk-Call (success:false, disabled:true)', async () => {
    const { mod, restore } = freshWithEnv('false');
    const spy = vi.fn(async () => { throw new Error('should not be called'); });
    global.fetch = spy;
    const res = await mod.fetchWithUnlocker({ url: 'https://www.amazon.de/dp/X' });
    expect(res.success).toBe(false);
    expect(res.disabled).toBe(true);
    expect(res.status).toBe(0);
    expect(res.statusText).toBe('web_unlocker_disabled');
    expect(spy).not.toHaveBeenCalled();
    restore();
  });

  it('default (unset) bleibt aktiviert — kein No-op-Kurzschluss', async () => {
    const { mod, restore } = freshWithEnv(undefined);
    // Ohne Token/Netz wirft/misslingt der echte Pfad — wichtig ist nur, dass
    // NICHT der disabled-Kurzschluss greift (kein statusText 'web_unlocker_disabled').
    let res;
    try {
      res = await mod.fetchWithUnlocker({ url: 'https://example.com' });
    } catch (e) {
      res = { thrown: true };
    }
    expect(res.disabled).not.toBe(true);
    restore();
  });
});
