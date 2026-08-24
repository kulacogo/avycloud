'use strict';
// TRACKING-PFLICHT AB 10 € (Betreiber-Anweisung 2026-08-21): createParcel ist der
// einzige Choke-Point aller Label-Wege (Pack-Flow, OrderDetail, Bulk, Alt-Flow).
// Ein untracked Versandcode (Maxibrief, Warensendung, Warenpost Int ohne Premium)
// darf ab 10 € Bestellwert — und bei UNBEKANNTEM Wert — nie zum Announce kommen.
require('./api/_patchGcp');

const authPath = require.resolve('../lib/sendcloud-auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { getSendCloudAuthHeader: vi.fn().mockResolvedValue('Basic test') },
  children: [], paths: [],
};

const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: {
    lookupCsvPrice: vi.fn().mockResolvedValue(null),
    listSenderAddresses: vi.fn().mockResolvedValue([
      { companyName: 'TrendOcean', street: 'Absenderstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' },
    ]),
  },
  children: [], paths: [],
};

const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};

const { createParcel } = require('../services/shipping-engine');

const baseOrder = {
  id: 'o1', marketplaceOrderId: 'MP1',
  customer: { name: 'Max Mustermann', street: 'Kundenstr 5', city: 'Hamburg', zip: '20095', country: 'DE' },
};

let fetchCalls;
beforeEach(() => {
  fetchCalls = [];
  global.fetch = vi.fn(async (url, opts) => {
    const u = String(url);
    fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
    if (u.includes('/shipments/announce')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship1', parcels: [{ id: 42, tracking_number: 'TRACK123', tracking_url: 'http://t', documents: [{ type: 'label', link: 'http://label' }] }] } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
  });
});

const announceCalls = () => fetchCalls.filter((c) => c.url.includes('/shipments/announce'));

describe('createParcel — Tracking-Pflicht ab 10 € Bestellwert', () => {
  it('blockt Maxibrief bei Bestellwert 25 € VOR dem SendCloud-Call', async () => {
    const order = { ...baseOrder, totalAmount: 25 };
    await expect(
      createParcel({ order, shippingOptionCode: 'dp:maxibrief/mailbox', weight: 0.4, tenantId: 'default' })
    ).rejects.toThrow(/Sendungsverfolgung/);
    expect(announceCalls()).toHaveLength(0);
  });

  it('erlaubt Maxibrief bei Bestellwert unter 10 €', async () => {
    const order = { ...baseOrder, totalAmount: 7.5 };
    const res = await createParcel({ order, shippingOptionCode: 'dp:maxibrief/mailbox', weight: 0.4, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
    expect(announceCalls()).toHaveLength(1);
  });

  it('blockt untracked Versand bei UNBEKANNTEM Bestellwert (fail-safe)', async () => {
    await expect(
      createParcel({ order: { ...baseOrder }, shippingOptionCode: 'dp:bucherwarensendung/mailbox', weight: 0.4, tenantId: 'default' })
    ).rejects.toThrow(/Sendungsverfolgung/);
    expect(announceCalls()).toHaveLength(0);
  });

  it('nutzt die Positionssumme, wenn totalAmount fehlt', async () => {
    const order = { ...baseOrder, items: [{ priceBrutto: 4, quantity: 2 }] }; // 8 € < 10 €
    const res = await createParcel({ order, shippingOptionCode: 'dp:maxibrief/mailbox', weight: 0.4, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
  });

  it('tracked Versandarten bleiben bei jedem Bestellwert erlaubt', async () => {
    const order = { ...baseOrder, totalAmount: 500 };
    const res = await createParcel({ order, shippingOptionCode: 'dhl_de:dhl_paket', weight: 2, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
  });

  it('blockt Warenpost International OHNE Premium ab 10 €, erlaubt sie MIT Premium', async () => {
    const intlOrder = {
      ...baseOrder, totalAmount: 25,
      customer: { ...baseOrder.customer, country: 'AT', zip: '1010', city: 'Wien' },
    };
    await expect(
      createParcel({ order: intlOrder, shippingOptionCode: 'dhl_de:warenpostinternational', weight: 0.4, tenantId: 'default' })
    ).rejects.toThrow(/Sendungsverfolgung/);
    const res = await createParcel({ order: intlOrder, shippingOptionCode: 'dhl_de:warenpostinternational/premium', weight: 0.4, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
  });

  it('auch der Alt-Flow (Fuzzy-Resolver ueber shippingMethodId) laeuft durch den Guard', async () => {
    // Lane liefert NUR ein untracked Briefprodukt — der Fuzzy-Fallback wuerde es waehlen.
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/shipping-options')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [
          { code: 'dp:maxibrief/mailbox', weight: { min: { value: 0 }, max: { value: 1 } } },
        ] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship1', parcels: [{ id: 42, tracking_number: 'T', documents: [] }] } }) };
    });
    const order = { ...baseOrder, totalAmount: 25 };
    await expect(
      createParcel({ order, shippingMethodId: 99, weight: 0.4, tenantId: 'default' })
    ).rejects.toThrow(/Sendungsverfolgung/);
    expect(announceCalls()).toHaveLength(0);
  });

  it('Premium-Pflicht ist WERTUNABHAENGIG: plain weltpaket wird auch unter 10 € geblockt', async () => {
    const intlOrder = {
      ...baseOrder, totalAmount: 5,
      customer: { ...baseOrder.customer, country: 'FR', zip: '75001', city: 'Paris' },
    };
    await expect(
      createParcel({ order: intlOrder, shippingOptionCode: 'dhl_de:weltpaket', weight: 2, tenantId: 'default' })
    ).rejects.toThrow(/Premium/);
    await expect(
      createParcel({ order: intlOrder, shippingOptionCode: 'dhl_de:warenpostinternational', weight: 0.4, tenantId: 'default' })
    ).rejects.toThrow(/Premium/);
    expect(announceCalls()).toHaveLength(0);
    // Mit Premium geht es durch:
    const res = await createParcel({ order: intlOrder, shippingOptionCode: 'dhl_de:weltpaket/premium', weight: 2, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
  });

  it("SHIPPING_TRACKED_ONLY_FROM_EUR='off' schaltet den Guard ab", async () => {
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = 'off';
    try {
      const order = { ...baseOrder, totalAmount: 500 };
      const res = await createParcel({ order, shippingOptionCode: 'dp:maxibrief/mailbox', weight: 0.4, tenantId: 'default' });
      expect(res.trackingNumber).toBe('TRACK123');
    } finally {
      delete process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
    }
  });

  it("'off' bypasst den Guard AUCH bei unbekanntem Bestellwert (Notbremsen-Semantik)", async () => {
    process.env.SHIPPING_TRACKED_ONLY_FROM_EUR = 'off';
    try {
      // Kein totalAmount, keine Positionen — Wert unbekannt. Vorher warf das mit
      // der absurden Meldung "ab Infinity € Bestellwert nicht erlaubt".
      const res = await createParcel({ order: { ...baseOrder }, shippingOptionCode: 'dp:maxibrief/mailbox', weight: 0.4, tenantId: 'default' });
      expect(res.trackingNumber).toBe('TRACK123');
    } finally {
      delete process.env.SHIPPING_TRACKED_ONLY_FROM_EUR;
    }
  });
});

// ── Premium-Pflicht im Alt-Flow: Auto-Upgrade statt Sackgasse ──────────────────
// _matchV3OptionCode MEIDET Premium bewusst (+4-Penalty, Fix 2026-07-20) — ohne
// Upgrade wuerde jeder internationale Alt-Flow-/Bulk-Versand am neuen Guard hart
// scheitern, obwohl die Premium-Schwester auf der Lane verfuegbar ist.
describe('createParcel — Premium-Auto-Upgrade im Alt-Flow', () => {
  it('resolvter plain-weltpaket-Code wird auf die Premium-Schwester umgeschrieben', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/shipping-options')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [
          { code: 'dhl_de:weltpaket', weight: { min: { value: 0 }, max: { value: 31.5 } } },
          { code: 'dhl_de:weltpaket/premium', weight: { min: { value: 0 }, max: { value: 31.5 } } },
        ] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship1', parcels: [{ id: 42, tracking_number: 'TRACK123', documents: [{ type: 'label', link: 'http://label' }] }] } }) };
    });
    const order = {
      ...baseOrder, totalAmount: 50,
      customer: { ...baseOrder.customer, country: 'FR', zip: '75001', city: 'Paris' },
    };
    const res = await createParcel({ order, shippingMethodId: 77, weight: 2, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
    const announce = fetchCalls.find((c) => c.url.includes('/shipments/announce'));
    expect(announce.body.ship_with.properties.shipping_option_code).toBe('dhl_de:weltpaket/premium');
  });

  it('ohne Premium-Schwester auf der Lane: harter, klarer Fehler statt untracked Versand', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/shipping-options')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [
          { code: 'dhl_de:weltpaket', weight: { min: { value: 0 }, max: { value: 31.5 } } },
        ] }) };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    });
    const order = {
      ...baseOrder, totalAmount: 50,
      customer: { ...baseOrder.customer, country: 'FR', zip: '75001', city: 'Paris' },
    };
    await expect(
      createParcel({ order, shippingMethodId: 77, weight: 2, tenantId: 'default' })
    ).rejects.toThrow(/Premium/);
    expect(announceCalls()).toHaveLength(0);
  });

  it("SHIPPING_PREMIUM_REQUIRED='off': plain weltpaket passiert den Guard (Notbremse)", async () => {
    process.env.SHIPPING_PREMIUM_REQUIRED = 'off';
    try {
      const order = {
        ...baseOrder, totalAmount: 50,
        customer: { ...baseOrder.customer, country: 'FR', zip: '75001', city: 'Paris' },
      };
      const res = await createParcel({ order, shippingOptionCode: 'dhl_de:weltpaket', weight: 2, tenantId: 'default' });
      expect(res.trackingNumber).toBe('TRACK123');
    } finally {
      delete process.env.SHIPPING_PREMIUM_REQUIRED;
    }
  });
});

// ── Billigst-Fallback kennt die Tracking-Pflicht ───────────────────────────────
describe('createParcel — Fallback waehlt tracked statt untracked bei >= 10 €', () => {
  it('ueberspringt Maxibrief und nimmt Kleinpaket, statt in den Guard zu laufen', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/shipping-options')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [
          { code: 'dp:maxibrief/mailbox', weight: { min: { value: 0 }, max: { value: 1 } } },
          { code: 'dhl_de:warenpost', weight: { min: { value: 0 }, max: { value: 1 } } },
        ] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship1', parcels: [{ id: 42, tracking_number: 'TRACK123', documents: [{ type: 'label', link: 'http://label' }] }] } }) };
    });
    const order = { ...baseOrder, totalAmount: 25 };
    const res = await createParcel({ order, shippingMethodId: 99, weight: 0.4, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
    const announce = fetchCalls.find((c) => c.url.includes('/shipments/announce'));
    expect(announce.body.ship_with.properties.shipping_option_code).toBe('dhl_de:warenpost');
  });

  it('unter 10 € versendet der Alt-Flow weiterhin untracked (Maxibrief bleibt erlaubt)', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/shipping-options')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [
          { code: 'dp:maxibrief/mailbox', weight: { min: { value: 0 }, max: { value: 1 } } },
        ] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship1', parcels: [{ id: 42, tracking_number: 'TRACK123', documents: [{ type: 'label', link: 'http://label' }] }] } }) };
    });
    const order = { ...baseOrder, totalAmount: 5 };
    const res = await createParcel({ order, shippingMethodId: 99, weight: 0.4, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
    const announce = fetchCalls.find((c) => c.url.includes('/shipments/announce'));
    expect(announce.body.ship_with.properties.shipping_option_code).toBe('dp:maxibrief/mailbox');
  });
});
