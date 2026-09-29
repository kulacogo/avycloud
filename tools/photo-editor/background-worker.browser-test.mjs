import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("real worker applies all quarter turns/flips before segmentation and returns alpha in original coordinates", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "avy-photo-worker-geometry-"));
  let server, browser;
  try {
    const stub = join(directory, "segmentation-stub.js");
    // The real model is replaced by a deterministic, asymmetric alpha oracle.
    // All image decoding, orientation, inverse transform and PNG encoding remain real.
    await writeFile(stub, `
      export async function preload() {}
      export async function segmentForeground(blob) {
        const image = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const corners = [0, canvas.width - 1, canvas.width * canvas.height - 1, canvas.width * (canvas.height - 1)]
          .map(index => pixels.data[index * 4]);
        self.postMessage({ type: "inspected-input", width: canvas.width, height: canvas.height, corners });
        for (let i = 0; i < pixels.data.length; i += 4) {
          pixels.data[i + 3] = pixels.data[i];
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
        }
        context.putImageData(pixels, 0, 0);
        image.close();
        return canvas.convertToBlob({ type: "image/png" });
      }
    `);
    const entry = join(directory, "entry.js");
    await writeFile(entry, `window.createGeometryWorker = () => new Worker(new URL(${JSON.stringify(join(root, "utils/photoBackground.worker.ts"))}, import.meta.url), { type: "module" });`);
    const output = join(directory, "dist");
    const bundle = await build({ root, logLevel: "silent", resolve: { alias: [{ find: "@imgly/background-removal", replacement: stub }] },
      build: { outDir: output, emptyOutDir: true, rollupOptions: { input: entry } } });
    const script = bundle.output.find(chunk => chunk.isEntry).fileName;
    await writeFile(join(output, "index.html"), `<script type="module" src="/${script}"></script>`);
    server = createServer(async (request, response) => {
      try {
        const pathname = new URL(request.url, "http://localhost").pathname;
        const path = join(output, pathname === "/" ? "index.html" : pathname);
        response.setHeader("Content-Type", extname(path) === ".html" ? "text/html" : "text/javascript");
        response.end(await readFile(path));
      } catch { response.statusCode = 404; response.end(); }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route("**/*", route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.createGeometryWorker === "function");
    const results = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 37; canvas.height = 23;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const pixels = context.createImageData(canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const index = (y * canvas.width + x) * 4;
        pixels.data[index] = 15 + (x * 7 + y * 13) % 230;
        pixels.data[index + 1] = 80; pixels.data[index + 2] = 120; pixels.data[index + 3] = 255;
      }
      const translucent = (11 * canvas.width + 18) * 4;
      pixels.data[translucent] = 200; pixels.data[translucent + 3] = 128;
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const source = await createImageBitmap(blob);
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(source, 0, 0);
      const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const sourceCorners = [0, canvas.width - 1, canvas.width * canvas.height - 1, canvas.width * (canvas.height - 1)].map(index => expected[index * 4]);
      const cases = [];
      const worker = window.createGeometryWorker();
      try {
        for (const rotation of [0, 90, 180, 270]) for (const flipX of [false, true]) for (const flipY of [false, true]) {
          const id = cases.length + 1;
          let inspected;
          const result = await new Promise((resolve, reject) => {
            worker.onmessage = ({ data }) => {
              if (data.type === "inspected-input") inspected = data;
              if (data.id !== id) return;
              if (data.type === "result") resolve(data.blob);
              if (data.type === "error") reject(new Error(data.message));
            };
            worker.onerror = reject;
            worker.postMessage({ id, blob, quality: "fast", forceCpu: true, orientation: { rotation, flipX, flipY } });
          });
          const image = await createImageBitmap(result);
          context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
          const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let maxAlphaDifference = 0, nonWhite = 0;
          for (let i = 0; i < actual.length; i += 4) {
            maxAlphaDifference = Math.max(maxAlphaDifference, Math.abs(actual[i + 3] - expected[i]));
            if (actual[i + 3] && (actual[i] !== 255 || actual[i + 1] !== 255 || actual[i + 2] !== 255)) nonWhite++;
          }
          let corners = sourceCorners.slice();
          if (flipX) corners = [corners[1], corners[0], corners[3], corners[2]];
          if (flipY) corners = [corners[3], corners[2], corners[1], corners[0]];
          const mappings = { 0: [0, 1, 2, 3], 90: [3, 0, 1, 2], 180: [2, 3, 0, 1], 270: [1, 2, 3, 0] };
          cases.push({ rotation, flipX, flipY, width: image.width, height: image.height, inspected,
            expectedCorners: mappings[rotation].map(index => corners[index]), maxAlphaDifference, nonWhite,
            sourceAlpha: expected[translucent + 3], maskAlpha: actual[translucent + 3], expectedMaskAlpha: expected[translucent] });
          image.close();
        }
      } finally { worker.terminate(); source.close(); }
      return cases;
    });
    assert.equal(results.length, 16);
    for (const result of results) {
      const label = JSON.stringify({ rotation: result.rotation, flipX: result.flipX, flipY: result.flipY });
      assert.equal(result.width, 37, label); assert.equal(result.height, 23, label);
      const swapped = result.rotation === 90 || result.rotation === 270;
      assert.equal(result.inspected.width, swapped ? 23 : 37, label);
      assert.equal(result.inspected.height, swapped ? 37 : 23, label);
      assert.deepEqual(result.inspected.corners, result.expectedCorners, label);
      assert.ok(result.maxAlphaDifference <= 1, `${label}: mask misplaced by ${result.maxAlphaDifference}`);
      assert.equal(result.nonWhite, 0, label);
      assert.equal(result.sourceAlpha, 128, label);
      assert.ok(Math.abs(result.maskAlpha - result.expectedMaskAlpha) <= 1, `${label}: source transparency was baked into the mask`);
    }
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
