// Run after npm run build: node --test tools/capture/sale-price.browser-test.mjs
// Real review/summary components; only the final persistence API is a fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '../..');
let browser, server, origin;
before(async () => {
  const result = await build({ absWorkingDir: root, bundle: true, write: false, format: 'iife',
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import StepReview from './components/capture/StepReview';
      import StepSummary from './components/capture/StepSummary';
      function App() {
        const params = new URLSearchParams(location.search);
        const [product, setProduct] = React.useState({id:'fixture',identification:{name:'IKEA SÄFFEROT Decke warm 140x200 cm',brand:'IKEA',category:'Bettdecken',barcodes:[]},details:{identifiers:{},images:[],attributes:{condition:'new'},short_description:'Warme Bettdecke, 140 × 200 cm.',pricing:params.has('missing')?{}:{sellPrice:19.99,lowest_price:{amount:19.99,currency:'EUR',sources:[{url:'https://www.ikea.com/de/de/p/saefferot-decke-warm-80565716/'}]}}}});
        const [summary, setSummary] = React.useState(false);
        return <main className='p-4 max-w-5xl mx-auto'>{summary ? <StepSummary products={[product]} onBack={()=>setSummary(false)} onSave={()=>{}} onReset={()=>{}} /> : <StepReview product={product} reuseNotice={params.has('reuse')?{title:'Bereits vorhanden',detail:'Bestehendes Datenblatt'}:null} onBack={()=>{}} onComplete={p=>{setProduct(p);setSummary(true);}} />}</main>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    ` },
    plugins: [{ name: 'local-save-only', setup(builder) {
      builder.onResolve({ filter: /api\/client$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      builder.onResolve({ filter: /context\/ToastContext$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'api'
        ? 'export const saveProduct = async (product, context) => { window.saved = {product,context}; return {ok:true}; };'
        : 'export const useToast = () => ({addToast:()=>{}});' }));
    } }],
  });
  let css = '';
  for (const name of (await readdir(resolve(root, 'dist/assets'))).filter(n => n.endsWith('.css'))) css += await readFile(resolve(root, 'dist/assets', name), 'utf8');
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/bundle.js' ? result.outputFiles[0].text : `<html data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="bg-app-bg"><div id="root"></div><script src="/bundle.js"></script></body></html>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(done => server?.close(done)); });
async function fixture(t, query = '') {
  const page = await browser.newPage({ viewport: {width: 1200, height: 850} });
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/${query}`);
  await page.getByLabel('Verkaufspreis (€)').waitFor();
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return page;
}
test('initial price survives review, summary and the actual save callback', async t => {
  const page = await fixture(t);
  assert.equal(await page.getByLabel('Verkaufspreis (€)').inputValue(), '19.99');
  await page.getByRole('button', {name:'Weiter zur Zusammenfassung'}).click();
  assert.match(await page.locator('main').textContent(), /19,99\s*€/);
  await page.getByRole('button', {name:'Produkt speichern',exact:true}).click();
  await page.getByText('Produkt erfolgreich angelegt', {exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(() => ({price:window.saved.product.details.pricing.sellPrice,market:window.saved.product.details.pricing.lowest_price.amount,activity:window.saved.context.activity})), {price:19.99,market:19.99,activity:'capture'});
});
test('a missing research price can be entered without opening chat', async t => {
  const page = await fixture(t, '?missing');
  await page.getByLabel('Verkaufspreis (€)').fill('24.95');
  await page.getByRole('button', {name:'Weiter zur Zusammenfassung'}).click();
  await page.getByRole('button', {name:'Produkt speichern',exact:true}).click();
  await page.waitForFunction(() => window.saved);
  assert.equal(await page.evaluate(() => window.saved.product.details.pricing.sellPrice), 24.95);
});
test('clearing a known price or entering invalid cents cannot silently save the old value', async t => {
  const page = await fixture(t);
  for (const value of ['', '0', '-1', '12.345']) {
    await page.getByLabel('Verkaufspreis (€)').fill(value);
    assert.equal(await page.getByRole('button', {name:'Weiter zur Zusammenfassung'}).isDisabled(), true);
    assert.equal(await page.getByRole('alert').count(), 1);
  }
  await page.getByLabel('Verkaufspreis (€)').fill('14.99');
  assert.equal(await page.getByRole('button', {name:'Weiter zur Zusammenfassung'}).isEnabled(), true);
});
test('existing-product notice and mobile dark/light price controls remain usable', async t => {
  const page = await fixture(t, '?reuse');
  assert.equal(await page.getByText('Bisheriger Verkaufspreis des vorhandenen Produkts.').count(), 1);
  await mkdir('/tmp/avy-capture-review', {recursive:true});
  for (const theme of ['dark','light']) {
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme',theme), theme);
    await page.getByLabel('Verkaufspreis (€)').scrollIntoViewIfNeeded();
    await page.screenshot({path:`/tmp/avy-capture-review/${theme}.png`,fullPage:true,animations:"disabled"});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
});
