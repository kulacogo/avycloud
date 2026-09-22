// Run explicitly: node --test tools/warehouse/zone-delete.browser-test.mjs
// Real WarehouseView + API client; local HTTP fixtures, no production services.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '../..');
let browser, server, origin, bundle, css = '';
before(async () => {
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/bundle.js' ? bundle : req.url === '/style.css' ? css : '<html><head><link rel="stylesheet" href="/style.css"></head><body style="padding:24px" class="bg-app-bg"><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, format: 'iife',
    define: { 'import.meta.env': JSON.stringify({ DEV: true, VITE_BACKEND_URL: origin }) },
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import WarehouseView from './components/WarehouseView';
      import { I18nProvider } from './i18n';
      import { setAuthTokenProvider } from './api/client';
      setAuthTokenProvider(async () => 'local-test-token');
      createRoot(document.getElementById('root')).render(<I18nProvider><WarehouseView /></I18nProvider>);
    ` },
    plugins: [{ name: 'inactive-tabs', setup(builder) {
      builder.onResolve({ filter: /\/(WarehouseInventoryTab|WarehouseMovementsTab|LotStructureTab)$/ }, () => ({ path: 'tab', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default () => null;' }));
    } }],
  });
  bundle = result.outputFiles[0].text;
  const assets = await readdir(resolve(root, 'dist/assets')).catch(() => []);
  for (const asset of assets.filter((file) => file.endsWith('.css'))) css += await readFile(resolve(root, 'dist/assets', asset), 'utf8');
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise((done) => server?.close(done)); });

const zone = (name = 'XQ', floor = 'GA', count = 0) => ({ id: `${name}_${floor}`, zone: name, etage: floor, binCount: count, totalProducts: 0, gangs: [], regale: [], ebenen: [] });
async function fixture(t, { initialZones = [zone()], codes = [], previewError, confirmError, waitConfirm, containerScenario = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let zones = [...initialZones];
  const rootBin = { code: 'SEG0101A', zone: 'S', etage: 'EG', gang: 1, regal: 1, ebene: 'A', productCount: 0, products: [] };
  let localBins = containerScenario ? [rootBin] : [];
  const deletes = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    assert.equal(url.origin, origin, `Unexpected external request: ${url.origin}`);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.equal(req.headers().authorization, 'Bearer local-test-token');
    let status = 200;
    let body;
    if (containerScenario && url.pathname.startsWith('/api/warehouse/bins/')) {
      if (req.method() === 'POST') {
        localBins.push({ ...rootBin, code: 'SEG0101A01', parentBinCode: rootBin.code, isContainer: true });
      } else if (req.method() === 'DELETE') {
        localBins = localBins.filter((bin) => !bin.isContainer);
      }
      zones = zones.map((item) => ({ ...item, binCount: localBins.length, rootBinCount: 1, containerCount: localBins.length - 1, shelfCount: 1 }));
      body = { ok: true, data: { ...rootBin, children: localBins.filter((bin) => bin.isContainer) } };
    } else if (req.method() === 'DELETE') {
      deletes.push(url);
      const confirmed = url.searchParams.get('confirm') === '1';
      if (confirmed && waitConfirm) await waitConfirm;
      const message = confirmed ? confirmError : previewError;
      if (message) { status = 409; body = { ok: false, error: { message } }; }
      else {
        if (confirmed) zones = zones.filter((item) => !url.pathname.endsWith(`/${item.zone}/${item.etage}`));
        body = { ok: true, data: { binCodes: codes, deleted: confirmed ? codes.length : 0, zoneDeleted: confirmed, dryRun: !confirmed } };
      }
    } else if (url.pathname === '/api/warehouse/zones') body = { ok: true, data: zones };
    else if (url.pathname.startsWith('/api/warehouse/zones/')) body = { ok: true, data: localBins };
    else throw new Error(`Unexpected API: ${url.pathname}`);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Zone löschen', exact: true }).waitFor();
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return { page, deletes };
}

test('zero-bin zone: preview, cancel, confirm and final empty state', async (t) => {
  const { page, deletes } = await fixture(t);
  await page.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zone XQ / GA löschen?' });
  await dialog.waitFor();
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].searchParams.get('dryRun'), '1');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  assert.equal(deletes.length, 1);
  await page.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  await dialog.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  await page.getByText('Noch keine Lagerstruktur', { exact: true }).waitFor();
  assert.equal(deletes.length, 3);
  assert.equal(deletes[2].searchParams.get('confirm'), '1');
  assert.equal(await page.getByRole('heading', { name: 'Zone XQ / GA', exact: true }).count(), 0);
});

test('delete empty bins: show scope and select remaining zone on another floor', async (t) => {
  const { page } = await fixture(t, { initialZones: [zone('XQ', 'GA', 2), zone('XQ', 'EG')], codes: ['XQGA0101A', 'XQGA0101B'] });
  await page.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.match(await dialog.innerText(), /2.*BIN/);
  await dialog.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  await page.getByRole('heading', { name: 'Zone XQ / EG', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Zone XQ / GA', exact: true }).count(), 0);
});

test('occupied zone: show the backend reason and send no confirmation', async (t) => {
  const { page, deletes } = await fixture(t, { previewError: 'BIN XQGA0101A enthält noch Bestand.' });
  await page.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  await page.getByText('BIN XQGA0101A enthält noch Bestand.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(deletes.length, 1);
});

test('stock changed after preview: failed confirmation keeps the zone', async (t) => {
  const { page } = await fixture(t, { confirmError: 'BIN XQGA0101A enthält inzwischen Bestand.' });
  await page.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Zone löschen', exact: true }).click();
  await page.getByText('BIN XQGA0101A enthält inzwischen Bestand.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Zone XQ / GA', exact: true }).count(), 1);
});

test('confirmation stays busy and prevents a second delete request', async (t) => {
  let release;
  const waitConfirm = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const { page, deletes } = await fixture(t, { waitConfirm });
  await page.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const sent = page.waitForRequest((req) => req.url().includes('confirm=1'));
  await dialog.getByRole('button', { name: 'Zone löschen', exact: true }).click();
  await sent;
  assert.equal(await dialog.locator('button').last().isDisabled(), true);
  await dialog.locator('button').last().evaluate((button) => button.click());
  assert.equal(deletes.filter((url) => url.searchParams.has('confirm')).length, 1);
  release();
  await page.getByText('Noch keine Lagerstruktur', { exact: true }).waitFor();
});

test('zone action and confirmation render in dark and light mode', async (t) => {
  const { page } = await fixture(t);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await page.getByRole('button', { name: 'Zone löschen', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/avycloud-zones-${theme}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Zone löschen', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.screenshot({ path: `/tmp/avycloud-zones-dialog-${theme}.png`, fullPage: true });
    await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
  }
});

test('zone overview distinguishes counts from aisle identifiers, locations, containers and units', async (t) => {
  const { page } = await fixture(t, { initialZones: [{
    ...zone('S', 'EG', 120), rootBinCount: 84, containerCount: 36, shelfCount: 12,
    gangs: [1, 2, 3, 4, 5, 6], regale: [1, 2], ebenen: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], totalProducts: 2720,
  }] });
  const card = page.getByRole('button', { name: /Zone S \/ EG/ });
  const text = await card.innerText();
  assert.match(text, /120 BINs/);
  assert.match(text, /84 Lagerplätze/);
  assert.match(text, /36 Behälter/);
  assert.match(text, /2\.720 Stück/);
  assert.match(text, /Gänge \(6\): 1, 2, 3, 4, 5, 6/);
  assert.match(text, /Regale \(12\): Nr\. 1, 2/);
  assert.match(text, /Ebenen: A, B, C, D, E, F, G/);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await card.screenshot({ path: `/tmp/avycloud-zone-summary-${theme}.png` });
  }
});

test('adding and removing a container refreshes the overview and preserves the open parent BIN', async (t) => {
  const { page } = await fixture(t, { containerScenario: true, initialZones: [{
    ...zone('S', 'EG', 1), rootBinCount: 1, containerCount: 0, shelfCount: 1,
    gangs: [1], regale: [1], ebenen: ['A'],
  }] });
  const card = page.getByRole('button', { name: /Zone S \/ EG/ });
  await page.getByRole('button', { name: 'A 0 Stk', exact: true }).click();
  await page.getByRole('button', { name: '+ Behälter', exact: true }).click();
  await card.getByText('1 Lagerplatz · 1 Behälter', { exact: true }).waitFor();
  assert.match(await card.innerText(), /2 BINs/);
  await page.getByRole('button', { name: 'Entfernen', exact: true }).click();
  await card.getByText('1 Lagerplatz · 0 Behälter', { exact: true }).waitFor();
  assert.match(await card.innerText(), /1 BIN/);
  await page.getByText('Keine Behälter vorhanden.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '+ Behälter', exact: true }).isVisible(), true);
});
