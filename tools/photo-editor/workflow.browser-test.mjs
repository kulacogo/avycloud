// Run: npm run build && node --test tools/photo-editor/workflow.browser-test.mjs
// Real editor, gallery, data sheet and API client. Synthetic photos and local HTTP only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
let browser, server, origin, bundle, css = "";
before(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html");
    res.end(req.url === "/bundle.js" ? bundle : req.url === "/style.css" ? css : '<html><head><link rel="stylesheet" href="/style.css"></head><body class="bg-app-bg"><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, format: "iife",
    define: { "import.meta.env": JSON.stringify({ DEV: true, VITE_BACKEND_URL: origin }) },
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import PhotoEditor from "./components/PhotoEditor";
      import ImageGallery from "./components/ImageGallery";
      import ProductSheet from "./components/ProductSheet";
      import { I18nProvider } from "./i18n";
      import { defaultRecipe } from "./utils/photoEditor";
      import { setAuthTokenProvider } from "./api/client";
      setAuthTokenProvider(async () => "fixture-token");
      const canvas=document.createElement("canvas");canvas.width=600;canvas.height=400;
      const ctx=canvas.getContext("2d");ctx.fillStyle="#dddddd";ctx.fillRect(0,0,600,400);ctx.fillStyle="#345678";ctx.fillRect(100,60,400,300);
      const original=canvas.toDataURL("image/png");ctx.clearRect(0,0,600,400);ctx.fillStyle="white";ctx.fillRect(100,60,400,300);ctx.clearRect(280,160,30,30);
      const mask=canvas.toDataURL("image/png");
      const images=[0,1,2].map(i=>({source:"upload",url_or_base64:original,notes:"Image "+i,photoEditor:{version:1,originalUrl:original,originalMimeType:"image/png",maskUrl:mask,recipe:{...defaultRecipe(),exposure:.2,background:"transparent"},updatedAt:"2026-09-29T00:00:00.000Z"}}));
      window.fixtureProduct={id:"photo-fixture",identification:{name:"Photo fixture",brand:"Fixture",category:"",barcodes:[],sku:"SKU-FIXTURE"},details:{images,attributes:{},pricing:{sellPrice:10}},inventory:{quantity:0},ops:{readiness:"ready",last_saved_iso:"2026-09-29T00:00:00.000Z"}};
      if(new URLSearchParams(location.search).has("claim")) window.fixtureProduct.ops.readiness="pending";
      function App(){
        const [list,setList]=React.useState(images),[open,setOpen]=React.useState(true),[locked,setLocked]=React.useState(false);
        const mode=new URLSearchParams(location.search).get("mode");
        window.fixture={images:list,setLocked,append:()=>setList(old=>[...old,{...old[0],notes:"late append"}]),replace:()=>setList(old=>old.map((im,i)=>i?im:{...im,notes:"changed elsewhere"}))};
        const apply=changes=>{window.applied=changes;setList(old=>old.map((im,i)=>changes.find(c=>c.index===i)?.image||im));setOpen(false);return true;};
        return <I18nProvider>{mode==="sheet"?<ProductSheet product={window.fixtureProduct} onUpdate={p=>{window.savedProduct=p;}}/>:mode==="gallery"?<ImageGallery images={list} resetKey="fixture" isEditing mutationsDisabled={locked} productId="photo-fixture" onDeleteImage={i=>setList(old=>old.filter((_,n)=>n!==i))} onReorder={(a,b)=>setList(old=>{const next=[...old];next.splice(b,0,next.splice(a,1)[0]);return next;})} onUpdateImage={(i,next)=>setList(old=>old.map((im,n)=>n===i?next:im))} onApplyPhotoChanges={apply}/>:<><button onClick={()=>setOpen(true)}>Werkstatt öffnen</button>{open&&<PhotoEditor images={list} initialIndex={0} onApply={apply} onClose={()=>setOpen(false)}/>}</>}</I18nProvider>;
      }
      createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);
    ` },
    plugins: [{ name: "local-contexts", setup(builder) {
      builder.onResolve({ filter: /context\/(AuthContext|InventoryContext)$/ }, args => ({ path: args.path.endsWith("AuthContext") ? "auth" : "inventory", namespace: "fixture" }));
      builder.onResolve({ filter: /utils\/photoBackground$/ }, () => ({ path: "background", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: args.path === "auth"
        ? 'export const useAuth=()=>({user:{uid:"local",email:"local@example.test"},hasPermission:()=>true});'
        : args.path === "inventory" ? 'export const useInventoryContext=()=>({inventories:[],syncInventories:async()=>{},syncing:false,setActiveInventoryId:()=>{},resolveInventory:()=>null});'
        : 'export const removePhotoBackground=()=>{throw Error("Inference is not part of this local workflow test");};' }));
    } }],
  });
  bundle = result.outputFiles[0].text;
  for (const file of (await readdir(resolve(root, "dist/assets"))).filter(file => file.endsWith(".css"))) css += await readFile(resolve(root, "dist/assets", file), "utf8");
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(done => server?.close(done)); });

async function fixture(t, mode = "editor", onApi) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push(`Unexpected external request: ${url.origin}`); return route.abort(); }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (onApi && await onApi(route, url, page)) return;
    const data = url.pathname === "/api/images/editor-capabilities" ? { version: 1 }
      : url.pathname === "/api/products/photo-fixture" ? await page.evaluate(() => window.fixtureProduct) : [];
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto(`${origin}/?mode=${mode}`);
  if (mode === "editor") await page.waitForFunction(() => document.querySelector("canvas")?.width > 1);
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return page;
}
const button = (p, name) => p.getByRole("button", { name, exact: true });
const history = p => p.locator("summary").filter({ hasText: "Verlauf" }).innerText();
async function startBrush(p) {
  await p.getByRole("tab", { name: "Freistellen", exact: true }).click();
  await button(p, "Radieren").click();
  const r = await p.locator("canvas").boundingBox();
  await p.mouse.move(r.x + r.width * .45, r.y + r.height * .45); await p.mouse.down();
  await p.mouse.move(r.x + r.width * .5, r.y + r.height * .5);
  return r;
}

test("save holds all gallery mutations until its response; rejected save retains editability", async t => {
  let release, saves = 0;
  const pending = new Promise(done => { release = done; });
  const p = await fixture(t, "sheet", async (route, url) => {
    if (url.pathname !== "/api/save") return false;
    saves++; await pending;
    await route.fulfill({ status: 503, json: { ok: false, error: { message: "Fixture unavailable" } } });
    return true;
  });
  await p.locator("#btn-edit-photo-fixture").click();
  await p.getByRole("tab", { name: /^Bilder/ }).click();
  await p.locator("#btn-save-photo-fixture").click();
  await p.getByText("Produkt wird gespeichert. Bildbearbeitung ist danach wieder verfügbar.").waitFor();
  assert.equal(await button(p, "Bild bearbeiten").isDisabled(), true);
  assert.equal(await button(p, "KI-Studio-Foto").isDisabled(), true);
  assert.equal(await button(p, "Delete selected image").isDisabled(), true);
  assert.equal(await p.locator('input[type="file"][accept="image/*"]').isDisabled(), true);
  assert.equal(await p.locator('[draggable="true"]').count(), 0);
  await p.getByRole("button", { name: "Bild löschen", exact: true }).first().dispatchEvent("click");
  assert.equal(await p.getByAltText("Thumbnail 2", { exact: true }).count(), 1);
  release();
  await p.waitForFunction(() => !document.querySelector("#btn-save-photo-fixture").disabled);
  assert.equal(saves, 1);
  assert.equal(await button(p, "Bild bearbeiten").isEnabled(), true);
  assert.equal(await p.locator('input[type="file"][accept="image/*"]').isEnabled(), true);
});

test("a studio result finishes before product save becomes available", async t => {
  let release, saves = 0;
  const pending = new Promise(done => { release = done; });
  const p = await fixture(t, "sheet", async (route, url, page) => {
    if (url.pathname === "/api/save") { saves++; await route.fulfill({ json: { ok: true, data: { id: "photo-fixture", revision: 1 } } }); return true; }
    if (url.pathname !== "/api/images/studio") return false;
    await pending;
    const image = await page.evaluate(() => window.fixtureProduct.details.images[0]);
    await route.fulfill({ json: { ok: true, data: { method: "gemini", image } } }); return true;
  });
  await p.locator("#btn-edit-photo-fixture").click(); await p.getByRole("tab", { name: /^Bilder/ }).click();
  await button(p, "KI-Studio-Foto").click();
  assert.equal(await p.locator("#btn-save-photo-fixture").isDisabled(), true);
  await p.locator("#btn-save-photo-fixture").dispatchEvent("click");
  assert.equal(saves, 0);
  release();
  await p.getByAltText("Thumbnail 4", { exact: true }).waitFor();
  await p.waitForFunction(() => !document.querySelector("#btn-save-photo-fixture").disabled);
  await p.locator("#btn-save-photo-fixture").click();
  await p.waitForFunction(() => !!window.savedProduct);
  assert.equal(saves, 1);
});

test("save lock preserves an already-open editor and its unsaved recipe", async t => {
  const p = await fixture(t, "gallery");
  await button(p, "Bild bearbeiten").click(); await button(p, "Dunkles Foto").click();
  await p.evaluate(() => window.fixture.setLocked(true));
  await button(p, "Ins Datenblatt übernehmen").click();
  await p.getByRole("alert").filter({ hasText: "Produkt wird gerade gespeichert" }).waitFor();
  assert.equal(await p.getByRole("dialog", { name: "Bildwerkstatt" }).count(), 1);
  await p.evaluate(() => window.fixture.setLocked(false));
  await button(p, "Ins Datenblatt übernehmen").click();
  await p.waitForFunction(() => window.applied?.length === 1);
  assert.equal(await p.evaluate(() => window.applied[0].image.photoEditor.recipe.exposure), .35);
});

test("a late ownership acknowledgement keeps a newer photo draft", async t => {
  let release;
  const pending = new Promise(done => { release = done; });
  const p = await fixture(t, "sheet&claim=1", async (route, url) => {
    if (url.pathname !== "/api/save") return false;
    await pending; await route.fulfill({ json: { ok: true, data: { id: "photo-fixture", revision: 1 } } }); return true;
  });
  await p.locator("#btn-edit-photo-fixture").click(); await p.getByRole("tab", { name: /^Bilder/ }).click();
  await button(p, "Bild bearbeiten").click(); await button(p, "Dunkles Foto").click(); await button(p, "Ins Datenblatt übernehmen").click();
  await p.getByRole("dialog", { name: "Bildwerkstatt" }).waitFor({ state: "detached" });
  const changed = await p.getByAltText("Product image 1", { exact: true }).getAttribute("src");
  const response = p.waitForResponse(r => r.url().includes("/api/save")); release(); await (await response).finished();
  await p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await p.getByAltText("Product image 1", { exact: true }).getAttribute("src"), changed);
  await button(p, "Bild bearbeiten").click();
  assert.equal(await p.getByRole("slider", { name: "Belichtung", exact: true }).inputValue(), "0.35");
});

test("full save waits for ownership claim and sends the newer image recipe", async t => {
  let release; const writes = [];
  const pending = new Promise(done => { release = done; });
  const p = await fixture(t, "sheet&claim=1", async (route, url, page) => {
    if (url.pathname !== "/api/save") return false;
    const activity = url.searchParams.get("activity"); const product = route.request().postDataJSON(); writes.push({ activity, product });
    if (activity === "ownership") await pending;
    else await page.evaluate(product => { window.fixtureProduct = product; }, product);
    await route.fulfill({ json: { ok: true, data: { id: "photo-fixture", revision: writes.length } } }); return true;
  });
  await p.locator("#btn-edit-photo-fixture").click(); await p.getByRole("tab", { name: /^Bilder/ }).click();
  await button(p, "Bild bearbeiten").click(); await button(p, "Dunkles Foto").click(); await button(p, "Ins Datenblatt übernehmen").click();
  await p.getByRole("dialog", { name: "Bildwerkstatt" }).waitFor({ state: "detached" });
  await p.locator("#btn-save-photo-fixture").click();
  await p.getByText("Produkt wird gespeichert. Bildbearbeitung ist danach wieder verfügbar.").waitFor();
  assert.deepEqual(writes.map(write => write.activity), ["ownership"]);
  release(); await p.waitForFunction(() => !!window.savedProduct);
  assert.deepEqual(writes.map(write => write.activity), ["ownership", "datasheet"]);
  assert.equal(writes[1].product.ops.revision, 1);
  assert.equal(writes[1].product.details.images[0].photoEditor.recipe.exposure, .35);
  assert.equal(await p.evaluate(() => window.savedProduct.details.images[0].photoEditor.recipe.exposure), .35);
});

test("all selected file reads finish before a product save is enabled", async t => {
  const p = await fixture(t, "sheet");
  await p.locator("#btn-edit-photo-fixture").click(); await p.getByRole("tab", { name: /^Bilder/ }).click();
  await p.evaluate(() => {
    const read = FileReader.prototype.readAsDataURL;
    window.pendingReads = [];
    FileReader.prototype.readAsDataURL = function(file) { window.pendingReads.push(() => read.call(this, file)); };
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1sAAAAASUVORK5CYII=", "base64");
  await p.locator('input[type="file"][accept="image/*"]').setInputFiles(["first.png", "second.png"].map(name => ({ name, mimeType: "image/png", buffer: png })));
  assert.equal(await p.locator("#btn-save-photo-fixture").isDisabled(), true);
  await p.evaluate(() => window.pendingReads.shift()());
  await p.getByAltText("Thumbnail 4", { exact: true }).waitFor();
  assert.equal(await p.locator("#btn-save-photo-fixture").isDisabled(), true);
  await p.waitForFunction(() => window.pendingReads.length === 1);
  await p.evaluate(() => window.pendingReads.shift()());
  await p.getByAltText("Thumbnail 5", { exact: true }).waitFor();
  await p.waitForFunction(() => !document.querySelector("#btn-save-photo-fixture").disabled);
});

test("gallery generation finishes and retains its new image before save", async t => {
  let release;
  const pending = new Promise(done => { release = done; });
  const p = await fixture(t, "sheet", async (route, url, page) => {
    if (url.pathname !== "/api/generate-images") return false;
    await pending;
    const image = await page.evaluate(() => ({ ...window.fixtureProduct.details.images[0], source: "generated", notes: "generated fixture" }));
    await route.fulfill({ json: { ok: true, data: [image] } }); return true;
  });
  await p.locator("#btn-edit-photo-fixture").click(); await p.getByRole("tab", { name: /^Bilder/ }).click();
  await button(p, "AI-Varianten aus Referenz erzeugen").click();
  assert.equal(await p.locator("#btn-save-photo-fixture").isDisabled(), true);
  release(); await p.getByAltText("Thumbnail 4", { exact: true }).waitFor();
  await p.waitForFunction(() => !document.querySelector("#btn-save-photo-fixture").disabled);
});

test("batch apply and reopen retain original URLs, masks and undoable original restoration", async t => {
  const p = await fixture(t);
  const sources = await p.evaluate(() => window.fixture.images.map(image => image.photoEditor));
  await button(p, "Dunkles Foto").click();
  await button(p, "Bildstil auf weitere Fotos …").click(); await button(p, "Licht & Format übertragen").click();
  await button(p, "Ins Datenblatt übernehmen (3)").click();
  await p.waitForFunction(() => window.applied?.length === 3);
  const applied = await p.evaluate(() => window.applied.map(change => change.image.photoEditor));
  applied.forEach((value, index) => { assert.equal(value.originalUrl, sources[index].originalUrl); assert.equal(value.maskUrl, sources[index].maskUrl); assert.equal(value.recipe.exposure, .35); });
  await button(p, "Werkstatt öffnen").click();
  await button(p, "Original wiederherstellen").click();
  assert.equal(await p.getByRole("slider", { name: "Belichtung", exact: true }).inputValue(), "0");
  await button(p, "Rückgängig").click();
  assert.equal(await p.getByRole("slider", { name: "Belichtung", exact: true }).inputValue(), "0.35");
  await button(p, "Wiederholen").click(); await button(p, "Ins Datenblatt übernehmen").click();
  await p.waitForFunction(() => window.applied?.length === 1);
  const restored = await p.evaluate(() => window.applied[0].image.photoEditor);
  assert.equal(restored.originalUrl, sources[0].originalUrl); assert.equal(restored.maskUrl, sources[0].maskUrl); assert.equal(restored.recipe.background, "original");
});

test("concurrent append survives apply; a replaced photo rejects stale edits", async t => {
  const p = await fixture(t, "gallery");
  await button(p, "Bild bearbeiten").click(); await button(p, "Dunkles Foto").click();
  await p.evaluate(() => window.fixture.append());
  await button(p, "Ins Datenblatt übernehmen").click();
  await p.waitForFunction(() => window.applied?.length === 1);
  assert.equal(await p.evaluate(() => window.fixture.images.length), 4);
  await button(p, "Bild bearbeiten").click(); await button(p, "Neutral").click();
  await p.evaluate(() => window.fixture.replace());
  await button(p, "Ins Datenblatt übernehmen").click();
  await p.getByRole("alert").filter({ hasText: "Bilder wurden zwischenzeitlich geändert" }).waitFor();
  assert.equal(await p.evaluate(() => window.fixture.images[0].notes), "changed elsewhere");
  assert.equal(await p.getByRole("dialog", { name: "Bildwerkstatt" }).count(), 1);
});

test("Escape cancels a brush gesture without adding a history entry", async t => {
  const p = await fixture(t); const before = await history(p); const r = await startBrush(p);
  await p.keyboard.press("Escape"); await p.mouse.move(r.x + r.width * .6, r.y + r.height * .5); await p.mouse.up();
  assert.equal(await history(p), before);
});

test("undo during a slider drag reverts only that drag and supports redo", async t => {
  const p = await fixture(t); await button(p, "Dunkles Foto").click();
  const slider = p.getByRole("slider", { name: "Belichtung", exact: true }); const r = await slider.boundingBox();
  await p.mouse.move(r.x + r.width * .8, r.y + r.height * .5); await p.mouse.down(); const dragging = await slider.inputValue();
  await p.keyboard.press("Control+z"); await p.mouse.up();
  assert.equal(await slider.inputValue(), "0.35");
  await button(p, "Wiederholen").click(); assert.equal(await slider.inputValue(), dragging);
});

test("switching images cancels a held brush without committing to either image", async t => {
  const p = await fixture(t); const before = await history(p); const r = await startBrush(p);
  await p.getByRole("dialog", { name: "Bildwerkstatt" }).focus(); await p.keyboard.press("ArrowRight");
  await p.mouse.move(r.x + r.width * .6, r.y + r.height * .5); await p.mouse.up();
  await button(p, "Bild 1 bearbeiten").click(); assert.equal(await history(p), before);
});
