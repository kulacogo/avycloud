// Run: npm run build && node --test tools/navigation/sidebar.browser-test.mjs
// Real Sidebar, fixture authentication only. Every non-local request is blocked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
let browser, server, origin, bundle, css = "";
before(async () => {
  const result = await build({
    absWorkingDir: root, bundle: true, write: false, format: "iife",
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { Sidebar } from "./components/Sidebar";
      import { AuthFixture } from "./context/AuthContext";
      function App() {
        const [view, setView] = React.useState(new URLSearchParams(location.search).get("view") || "dashboard");
        const [uid, setUid] = React.useState("alice");
        window.switchAccount = setUid;
        return <AuthFixture uid={uid}><div className="flex min-h-screen bg-app-bg"><Sidebar currentView={view} setView={setView} /><main className="p-8 text-txt-primary"><h1>Navigation · lokale Vorschau</h1><p>Aktuelle Ansicht: <span data-testid="view">{view}</span></p></main></div></AuthFixture>;
      }
      createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
    ` },
    plugins: [{ name: "fixture-auth", setup(builder) {
      builder.onResolve({ filter: /context\/AuthContext$/ }, () => ({ path: "auth", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ resolveDir: root, loader: "tsx", contents: `
        import React from "react";
        const Context = React.createContext(null);
        export const useAuth = () => React.useContext(Context);
        export const AuthFixture = ({ uid, children }) => <Context.Provider value={{
          user: { uid, tenantId: "local", email: uid + "@example.test", displayName: uid },
          hasPermission: (module, action) => uid !== "reader" || (module === "products" && action === "read"),
          logout: async () => {}, rbac: { roles: [uid === "reader" ? "viewer" : "admin"] }
        }}>{children}</Context.Provider>;
      ` }));
    } }],
  });
  bundle = result.outputFiles[0].text;
  for (const file of (await readdir(resolve(root, "dist/assets"))).filter(file => file.endsWith(".css"))) css += await readFile(resolve(root, "dist/assets", file), "utf8");
  server = createServer(async (req, res) => {
    if (req.url.startsWith("/avycloud_logo")) {
      res.setHeader("Content-Type", "image/png");
      res.end(await readFile(resolve(root, "public", req.url.slice(1))));
      return;
    }
    res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : req.url === "/style.css" ? "text/css" : "text/html");
    res.end(req.url === "/bundle.js" ? bundle : req.url === "/style.css" ? css : '<html data-theme="dark"><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(done => server?.close(done)); });
async function fixture(t, view = "dashboard", blockedStorage = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (blockedStorage) await page.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw Error("blocked"); } }));
  await page.goto(`${origin}/?view=${view}`);
  await page.getByRole("navigation", { name: "Hauptnavigation" }).waitFor();
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return page;
}
const group = (page, name) => page.getByRole("button", { name, exact: true });
const expanded = (page, name) => group(page, name).getAttribute("aria-expanded");

test("compact start, keyboard disclosure, last choices survive reload and account switching", async t => {
  const page = await fixture(t);
  assert.equal(await page.locator('nav button[aria-expanded="true"]').count(), 1);
  await group(page, "Lager").focus();
  await page.keyboard.press("Enter");
  await group(page, "Aufträge").click();
  await page.getByRole("link", { name: "Inventar", exact: true }).click();
  assert.equal(await page.getByTestId("view").textContent(), "inventory");
  assert.equal(new URL(page.url()).hash, "#/inventory");
  await page.reload();
  assert.equal(await expanded(page, "Lager"), "true");
  assert.equal(await expanded(page, "Aufträge"), "false");
  await page.evaluate(() => window.switchAccount("bob"));
  await page.waitForFunction(() => document.querySelector('button[aria-label="Lager"]').getAttribute("aria-expanded") === "false");
  assert.equal(await expanded(page, "Aufträge"), "true");
  await page.evaluate(() => window.switchAccount("alice"));
  await page.waitForFunction(() => document.querySelector('button[aria-label="Lager"]').getAttribute("aria-expanded") === "true");
  assert.equal(await expanded(page, "Aufträge"), "false");
});
test("deep links expose secondary function; manually closed active group stays closed", async t => {
  const page = await fixture(t, "rules");
  assert.equal(await page.getByRole("link", { name: "Regeln", exact: true }).getAttribute("aria-current"), "page");
  await group(page, "Weitere Funktionen: Produkte").click();
  await group(page, "Produkte").click();
  await page.reload();
  assert.equal(await expanded(page, "Produkte"), "false");
  await group(page, "Produkte").click();
  assert.equal(await expanded(page, "Weitere Funktionen: Produkte"), "false");
});
test("icon rail stays compact, persists and opens the chosen work area", async t => {
  const page = await fixture(t);
  await group(page, "Sidebar einklappen").click();
  await page.reload();
  await group(page, "Sidebar ausklappen").waitFor();
  assert.equal(await page.getByRole("navigation").getByRole("link").count(), 2);
  assert.equal(await page.getByRole("navigation").getByRole("button").count(), 5);
  await group(page, "Lager").click();
  await page.getByRole("link", { name: "Inventar", exact: true }).waitFor();
  assert.equal(await expanded(page, "Lager"), "true");
});
test("permissions still hide protected links, inventory is reachable without warehouse rights", async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.switchAccount("reader"));
  await page.waitForFunction(() => !document.querySelector('a[href="#/finance"]'));
  await group(page, "Lager").click();
  await page.getByRole("link", { name: "Inventar", exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Verwaltung", exact: true }).count(), 0);
  assert.equal(await group(page, "Aufträge").count(), 0);
  await group(page, "Einstellungen").click();
  await page.getByRole("link", { name: "Persönliche Daten" }).waitFor();
  assert.equal(await page.locator('a[href="#/settings/team"]').count(), 0);
});
test("unavailable storage leaves navigation usable", async t => {
  const page = await fixture(t, "dashboard", true);
  await group(page, "Lager").click();
  await page.getByRole("link", { name: "Inventar", exact: true }).click();
  assert.equal(await page.getByTestId("view").textContent(), "inventory");
});
test("dark/light layouts fit at desktop heights; screenshots for visual review", async t => {
  const page = await fixture(t);
  await group(page, "Lager").click();
  const output = "/tmp/avycloud-navigation-review";
  await mkdir(output, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
    await page.screenshot({ path: `${output}/${theme}.png` });
    assert.ok(await page.locator("nav").evaluate(el => el.scrollHeight <= el.clientHeight));
    assert.ok(await page.locator("aside").evaluate(el => el.scrollWidth <= el.clientWidth));
  }
  await page.setViewportSize({ width: 1024, height: 600 });
  for (const name of ["Produkte", "Marktplätze", "Einstellungen"]) await group(page, name).click();
  await page.getByRole("link", { name: "Aktivitätsprotokoll" }).scrollIntoViewIfNeeded();
  assert.equal(await group(page, "Abmelden").isVisible(), true);
});
