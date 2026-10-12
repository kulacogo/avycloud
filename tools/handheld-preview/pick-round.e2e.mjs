import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.env.HANDHELD_PREVIEW_URL || 'http://127.0.0.1:4182';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Local fixture server required');
const output = new URL('../../docs/reviews/pick-round-20261012/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
 for (const [width,height] of [[320,568],[360,640],[393,852]]) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/?reset=1`); await page.getByRole('button',{name:/Picken →/}).click();
  await page.getByText('XEG0107D',{exact:true}).waitFor();
  const scan = page.locator('section[aria-label="Picken"] input[type="text"]');
  await scan.fill('XEG0107D'); await scan.press('Enter');
  await scan.fill('SKU-8918729216'); await scan.press('Enter');
  await page.getByRole('button',{name:'2 Stück gepickt',exact:true}).click();
  await page.getByText('LEG0304E',{exact:true}).waitFor();
  const dimensions = await page.evaluate(() => ({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
  assert.equal(dimensions.scrollWidth,width); assert.equal(dimensions.scrollHeight,height);
  const end = page.getByRole('button',{name:'Runde beenden',exact:true});
  const box = await end.boundingBox(); assert(box && box.y+box.height<=height && box.height>=44);
  await page.screenshot({path:new URL(`pick-${width}.png`,output).pathname});
  await end.click(); const dialog=page.getByRole('dialog'); await dialog.waitFor();
  assert.equal(await scan.count(),0);
  await page.waitForFunction(()=>Boolean(document.activeElement?.closest('[role="dialog"]')));
  const dialogBox=await dialog.boundingBox(); assert(dialogBox.y>=0&&dialogBox.y+dialogBox.height<=height);
  await page.screenshot({path:new URL(`end-${width}.png`,output).pathname});
  await dialog.getByRole('button',{name:'Weiterpicken',exact:true}).click();
  await scan.waitFor();
  await end.click(); await dialog.getByRole('button',{name:'Runde beenden',exact:true}).click();
  await page.getByRole('heading',{name:'Operationen',exact:true}).waitFor();
  const state=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('preview-order')));
  assert.equal(state.pickWork.status,'released'); assert.equal(state.pickWork.lines[0].picked,2); assert.equal(state.pickWork.lines[1].picked,0);
  assert.deepEqual(errors,[]); results.push({width,height,partialEnd:true,layout:true,focus:true});
  await context.close();
 }
 for (const variant of ['endFailure','reverseStop']) {
  const context=await browser.newContext({viewport:{width:360,height:640}});
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  const page=await context.newPage(); await page.goto(`${base}/?reset=1&${variant}=1`);
  await page.getByRole('button',{name:/Picken →/}).click();
  await page.getByText(variant==='reverseStop'?'LEG0304E':'XEG0107D',{exact:true}).waitFor();
  if(variant==='endFailure') {
   await page.getByRole('button',{name:'Runde beenden',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'Runde beenden',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'Verbindung unterbrochen'}).waitFor();
   const state=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('preview-order')));
   assert.equal(state.pickWork.status,'active');
   await page.getByText('XEG0107D',{exact:true}).waitFor();
  }
  results.push({variant,passed:true}); await context.close();
 }
 await writeFile(new URL('browser-results.json',output),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
 console.log(JSON.stringify(results));
} finally { await browser.close(); }
