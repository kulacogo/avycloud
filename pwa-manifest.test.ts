// Regression-Test für den PWA-Install-Icon-Bug (2026-07-07):
// manifest.webmanifest lag im Repo-Root (wurde von Vite nie nach dist/ kopiert)
// und referenzierte Icon-Dateien, die es nicht gab. Firebase-SPA-Rewrite lieferte
// dafür still index.html (HTTP 200, text/html) → Android/Windows zeigten den
// generischen Buchstaben statt des avycloud-Logos.
//
// Ausführen: node --test pwa-manifest.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");
const manifestPath = join(publicDir, "manifest.webmanifest");

function pngSize(buf: Buffer): { width: number; height: number } {
  const isPng =
    buf.length > 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  assert.ok(isPng, "Datei ist kein PNG (Magic-Bytes fehlen)");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("manifest.webmanifest liegt in public/ (sonst kopiert Vite es nicht nach dist/)", () => {
  assert.ok(
    existsSync(manifestPath),
    "public/manifest.webmanifest fehlt — im Repo-Root wird es nicht deployed"
  );
});

test("index.html verlinkt das Manifest", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  assert.match(html, /rel="manifest"\s+href="\/manifest\.webmanifest"/);
});

test("alle Manifest-Icons existieren in public/ und haben die deklarierte Größe", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);

  for (const icon of manifest.icons) {
    const file = join(publicDir, icon.src.replace(/^\//, ""));
    assert.ok(existsSync(file), `Icon fehlt in public/: ${icon.src}`);
    const { width, height } = pngSize(readFileSync(file));
    assert.equal(`${width}x${height}`, icon.sizes, `Größe stimmt nicht: ${icon.src}`);
  }
});

test("Manifest deckt die Pflichtgrößen 192x192 und 512x512 ab (any + maskable)", () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const covered = (size: string, purpose: string) =>
    manifest.icons.some(
      (i: { sizes: string; purpose?: string }) =>
        i.sizes === size && (i.purpose ?? "any").split(" ").includes(purpose)
    );
  for (const size of ["192x192", "512x512"]) {
    assert.ok(covered(size, "any"), `Icon ${size} (any) fehlt im Manifest`);
    assert.ok(covered(size, "maskable"), `Icon ${size} (maskable) fehlt im Manifest`);
  }
});
