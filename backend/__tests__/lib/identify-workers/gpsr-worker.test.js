'use strict';

const Module = require('module');

function patchLocalModule(modulePath, exportsOverride) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const fakeModule = new Module(resolved);
  fakeModule.exports = exportsOverride;
  fakeModule.loaded = true;
  fakeModule.filename = resolved;
  require.cache[resolved] = fakeModule;
  return { resolved, revert: () => delete require.cache[resolved] };
}

describe('gpsr-worker', () => {
  let worker;
  let registryH;
  let webH;
  let atomicH;

  beforeEach(() => {
    delete require.cache[require.resolve('../../../lib/identify-workers/gpsr-worker')];
    registryH = patchLocalModule('../../../lib/gpsr-manufacturer-registry', {
      getManufacturerGpsrByName: () => Promise.resolve(null),
    });
    webH = patchLocalModule('../../../lib/gpsr-web-fallback', {
      lookupGpsrFromWeb: () => Promise.resolve(null),
    });
    atomicH = patchLocalModule('../../../services/atomic-tools', {
      executors: {
        executeSearchManufacturerSite: () => Promise.resolve({ ok: false }),
      },
    });
    worker = require('../../../lib/identify-workers/gpsr-worker');
  });

  afterEach(() => {
    registryH.revert();
    webH.revert();
    atomicH.revert();
  });

  it('DOMAIN is "gpsr"', () => {
    expect(worker.DOMAIN).toBe('gpsr');
  });

  it('ok:false with no brand', async () => {
    const r = await worker.runGpsrWorker({});
    expect(r.ok).toBe(false);
    expect(r.meta.error).toBe('no_brand');
  });

  it('registry complete → confidence 0.9, completeness 1.0', async () => {
    registryH.revert();
    registryH = patchLocalModule('../../../lib/gpsr-manufacturer-registry', {
      getManufacturerGpsrByName: () =>
        Promise.resolve({
          found: true,
          data: {
            manufacturer_name: 'Sony Europe',
            manufacturer_address: 'Berlin',
            email: 'legal@sony.de',
            country_code: 'DE',
          },
        }),
    });
    delete require.cache[require.resolve('../../../lib/identify-workers/gpsr-worker')];
    worker = require('../../../lib/identify-workers/gpsr-worker');

    const r = await worker.runGpsrWorker({ product: { identification: { brand: 'Sony' } } });
    expect(r.ok).toBe(true);
    expect(r.resolved.gpsr_completeness).toBe(1);
    expect(r.confidence.gpsr).toBeGreaterThanOrEqual(0.9);
  });

  it('registry + web-fallback merge', async () => {
    registryH.revert();
    registryH = patchLocalModule('../../../lib/gpsr-manufacturer-registry', {
      getManufacturerGpsrByName: () =>
        Promise.resolve({
          found: true,
          data: { manufacturer_name: 'Sony', country_code: 'DE' },
        }),
    });
    webH.revert();
    webH = patchLocalModule('../../../lib/gpsr-web-fallback', {
      lookupGpsrFromWeb: () =>
        Promise.resolve({ manufacturer_address: 'Berlin', email: 'info@sony.de' }),
    });
    delete require.cache[require.resolve('../../../lib/identify-workers/gpsr-worker')];
    worker = require('../../../lib/identify-workers/gpsr-worker');

    const r = await worker.runGpsrWorker({ product: { identification: { brand: 'Sony' } } });
    expect(r.resolved.gpsr.manufacturer_name).toBe('Sony');
    expect(r.resolved.gpsr.manufacturer_address).toBe('Berlin');
    expect(r.resolved.gpsr_completeness).toBe(1);
    expect(r.confidence.gpsr).toBeGreaterThanOrEqual(0.9);
  });

  it('completeness correctly computed at 0.5 when 2/4 filled', async () => {
    registryH.revert();
    registryH = patchLocalModule('../../../lib/gpsr-manufacturer-registry', {
      getManufacturerGpsrByName: () =>
        Promise.resolve({
          found: true,
          data: { manufacturer_name: 'Sony', email: 'x@y.de' },
        }),
    });
    delete require.cache[require.resolve('../../../lib/identify-workers/gpsr-worker')];
    worker = require('../../../lib/identify-workers/gpsr-worker');

    const r = await worker.runGpsrWorker({ product: { identification: { brand: 'Sony' } } });
    expect(r.resolved.gpsr_completeness).toBe(0.5);
  });

  it('returns unified shape', async () => {
    const r = await worker.runGpsrWorker({
      product: { identification: { brand: 'X' } },
    });
    expect(r).toHaveProperty('ok');
    expect(r).toHaveProperty('domain', 'gpsr');
    expect(r).toHaveProperty('resolved');
    expect(r.resolved).toHaveProperty('gpsr_completeness');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('sources');
    expect(r).toHaveProperty('meta');
  });
});
