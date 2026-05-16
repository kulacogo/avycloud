/**
 * Unit tests for lib/kaufland-api.js getBookings()
 *
 * Strategy: patch lib/secret-values + node-fetch in require.cache BEFORE
 * loading kaufland-api. We can then drive every HTTP response from a fetch
 * stub queue and verify the queue→poll→download→parse→aggregate pipeline.
 */

// ─── 1. Stub secret-values so kauflandRequest can build a signature ──────────
const secretValuesPath = require.resolve('../../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath,
  filename: secretValuesPath,
  loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('test-secret') },
  children: [],
  paths: [],
};

// ─── 2. Stub node-fetch with a scripted response queue ───────────────────────
const nodeFetchPath = require.resolve('node-fetch');
const responseQueue = [];
const fetchCalls = [];
const fetchStub = vi.fn(async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });
  if (!responseQueue.length) {
    throw new Error(`fetch stub queue exhausted (url=${url})`);
  }
  return responseQueue.shift();
});
require.cache[nodeFetchPath] = {
  id: nodeFetchPath,
  filename: nodeFetchPath,
  loaded: true,
  exports: fetchStub,
  children: [],
  paths: [],
};

// Force-reload kaufland-api so it picks up the stubs
const kauflandApiPath = require.resolve('../../lib/kaufland-api');
delete require.cache[kauflandApiPath];
const { getBookings } = require('../../lib/kaufland-api');

function mockJsonResponse(status, json) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(json),
    headers: { get: () => null },
  };
}
function mockTextResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    headers: { get: () => null },
  };
}

describe('getBookings — input validation', () => {
  beforeEach(() => {
    responseQueue.length = 0;
    fetchCalls.length = 0;
    fetchStub.mockClear();
  });

  it('throws when from is not a YYYY-MM-DD string', async () => {
    await expect(getBookings({ from: 'bad', to: '2026-01-31' })).rejects.toMatchObject({
      code: 'KAUFLAND_BOOKINGS_DATE_INVALID',
    });
  });

  it('throws when to is missing', async () => {
    await expect(getBookings({ from: '2026-01-01' })).rejects.toMatchObject({
      code: 'KAUFLAND_BOOKINGS_DATE_INVALID',
    });
  });
});

describe('getBookings — happy path (queue → poll → download → aggregate)', () => {
  beforeEach(() => {
    responseQueue.length = 0;
    fetchCalls.length = 0;
    fetchStub.mockClear();
  });

  it('queues report, polls until done, downloads CSV and aggregates payout cents', async () => {
    // 1. POST /reports/bookings-new  → 202 with id_report
    responseQueue.push(mockJsonResponse(202, { data: { id_report: 4242, report_name: 'r', storefront: 'de', parameters: [] } }));
    // 2. GET  /reports/4242          → 200, status=done, url
    responseQueue.push(mockJsonResponse(200, {
      data: {
        id_report: 4242,
        status: 'done',
        date_requested: '2026-01-31 10:00:00',
        url: 'https://kaufland.de/report_files/4242/',
        report_name: 'r',
        storefront: 'de',
        parameters: [],
      },
    }));
    // 3. GET CSV file               → 200 with CSV body
    const csv = [
      'id_order;type;amount;currency;ts_created',
      'KL-1001;PAYOUT;12,50;EUR;2026-01-15',
      'KL-1002;PAYOUT;7,89;EUR;2026-01-20',
      'KL-1003;FEE;-1,25;EUR;2026-01-22',
    ].join('\n');
    responseQueue.push(mockTextResponse(200, csv));

    const result = await getBookings({
      from: '2026-01-01',
      to: '2026-01-31',
      storefront: 'de',
      pollIntervalMs: 1, // make the test fast
      pollTimeoutMs: 5_000,
    });

    expect(result.from).toBe('2026-01-01');
    expect(result.to).toBe('2026-01-31');
    expect(result.storefront).toBe('de');
    expect(result.count).toBe(3);
    expect(result.bookings).toHaveLength(3);
    // 12.50 + 7.89 + (-1.25) = 19.14 → 1914 cents
    expect(result.total_payout_cents).toBe(1914);
    expect(result.total_payout_eur).toBeCloseTo(19.14, 2);
    expect(result.currency).toBe('EUR');
    expect(result.reportId).toBe(4242);
    expect(result.reportUrl).toBe('https://kaufland.de/report_files/4242/');
    expect(result.endpointUsed).toBe('/reports/bookings-new');

    // Verify call sequence
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[0].url).toMatch(/\/reports\/bookings-new\?/);
    expect(fetchCalls[0].url).toMatch(/storefront=de/);
    expect(fetchCalls[0].url).toMatch(/version=v2/);
    expect(fetchCalls[0].opts.method).toBe('POST');
    expect(fetchCalls[1].url).toMatch(/\/reports\/4242$/);
    expect(fetchCalls[2].url).toBe('https://kaufland.de/report_files/4242/');
  });

  it('falls back to /reports/bookings when /reports/bookings-new returns 404', async () => {
    // POST /reports/bookings-new → 404 (endpoint renamed/missing)
    responseQueue.push(mockJsonResponse(404, { message: 'Not found' }));
    // POST /reports/bookings → 202 ok
    responseQueue.push(mockJsonResponse(202, { data: { id_report: 555, report_name: 'r', storefront: 'de', parameters: [] } }));
    // GET /reports/555 → done
    responseQueue.push(mockJsonResponse(200, {
      data: { id_report: 555, status: 'done', date_requested: '', url: 'https://kaufland.de/x/', report_name: 'r', storefront: 'de', parameters: [] },
    }));
    // CSV download
    responseQueue.push(mockTextResponse(200, 'id_order;amount;currency\nA;1,00;EUR'));

    const result = await getBookings({
      from: '2026-02-01', to: '2026-02-28', storefront: 'de', pollIntervalMs: 1,
    });

    expect(result.endpointUsed).toBe('/reports/bookings');
    expect(result.count).toBe(1);
    expect(result.total_payout_cents).toBe(100);
  });

  it('throws KAUFLAND_BOOKINGS_REPORT_FAILED when polling returns status=failed', async () => {
    responseQueue.push(mockJsonResponse(202, { data: { id_report: 777, report_name: 'r', storefront: 'de', parameters: [] } }));
    responseQueue.push(mockJsonResponse(200, {
      data: { id_report: 777, status: 'failed', date_requested: '', url: '', report_name: 'r', storefront: 'de', parameters: [] },
    }));
    await expect(
      getBookings({ from: '2026-01-01', to: '2026-01-31', pollIntervalMs: 1 })
    ).rejects.toMatchObject({ code: 'KAUFLAND_BOOKINGS_REPORT_FAILED' });
  });

  it('respects offset and limit slicing of the aggregated bookings array', async () => {
    responseQueue.push(mockJsonResponse(202, { data: { id_report: 1, report_name: 'r', storefront: 'de', parameters: [] } }));
    responseQueue.push(mockJsonResponse(200, {
      data: { id_report: 1, status: 'done', date_requested: '', url: 'u', report_name: 'r', storefront: 'de', parameters: [] },
    }));
    responseQueue.push(mockTextResponse(200, [
      'id_order;amount;currency',
      'A;1,00;EUR',
      'B;2,00;EUR',
      'C;3,00;EUR',
      'D;4,00;EUR',
      'E;5,00;EUR',
    ].join('\n')));

    const result = await getBookings({
      from: '2026-01-01', to: '2026-01-31', limit: 2, offset: 1, pollIntervalMs: 1,
    });
    // count = all aggregated bookings (5), bookings = the paged slice (2)
    expect(result.count).toBe(5);
    expect(result.bookings).toHaveLength(2);
    expect(result.bookings[0].order_id).toBe('B');
    expect(result.bookings[1].order_id).toBe('C');
    // Total payout cents still sums ALL rows, not just the page
    expect(result.total_payout_cents).toBe(100 + 200 + 300 + 400 + 500);
  });
});
