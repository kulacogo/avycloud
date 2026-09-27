import test from "node:test";
import assert from "node:assert/strict";
import { adjustPhotoPixels, autoRecipe, defaultRecipe, findAlphaBounds, neutralPointRecipe, normalizeRecipe, recipesEqual, restoreEnclosedMaskRegion, sharpenPhotoPixels } from "./photoEditor.ts";
import { getPhotoDimensions } from "./photoEditorCanvas.ts";

test("neutral tone settings preserve every channel including transparent pixels", () => {
  const pixels = new Uint8ClampedArray([0, 0, 0, 255, 41, 120, 219, 190, 255, 255, 255, 255, 23, 40, 90, 0]);
  const before = pixels.slice();
  adjustPhotoPixels(pixels, defaultRecipe());
  assert.deepEqual(pixels, before);
});

test("exposure brightens linear light while keeping black and alpha", () => {
  const pixels = new Uint8ClampedArray([80, 80, 80, 127, 0, 0, 0, 255]);
  adjustPhotoPixels(pixels, { ...defaultRecipe(), exposure: 1 });
  assert.ok(pixels[0] >= 109 && pixels[0] <= 113);
  assert.equal(pixels[0], pixels[1]);
  assert.equal(pixels[3], 127);
  assert.deepEqual(Array.from(pixels.slice(4)), [0, 0, 0, 255]);
});

test("positive exposure preserves highlight separation instead of clipping everything", () => {
  const pixels = new Uint8ClampedArray([220, 220, 220, 255, 240, 240, 240, 255, 255, 255, 255, 255]);
  adjustPhotoPixels(pixels, { ...defaultRecipe(), exposure: 1 });
  assert.ok(pixels[0] > 220 && pixels[0] < pixels[4]);
  assert.ok(pixels[4] < 255);
  assert.equal(pixels[8], 255);
});

test("shared tone curve preserves chromatic ratios in linear light", () => {
  const linear = (x: number) => x / 255 <= 0.04045 ? x / 255 / 12.92 : Math.pow((x / 255 + 0.055) / 1.055, 2.4);
  const pixels = new Uint8ClampedArray([45, 90, 135, 255]);
  const ratio = linear(45) / linear(135);
  adjustPhotoPixels(pixels, { ...defaultRecipe(), shadows: 25, contrast: 10 });
  assert.ok(Math.abs(linear(pixels[0]) / linear(pixels[2]) - ratio) < 0.008);
});

test("normalization clamps damaged persisted data and creates independent defaults", () => {
  const result = normalizeRecipe({ exposure: Infinity, shadows: 400, rotation: 450, padding: 9, crop: { x: 0.9, y: -1, width: 2, height: 0 } } as never);
  assert.equal(result.exposure, 0);
  assert.equal(result.shadows, 100);
  assert.equal(result.rotation, 90);
  assert.equal(result.padding, 0.25);
  assert.ok(result.crop.x + result.crop.width <= 1);
  assert.equal(result.crop.y, 0);
  assert.ok(result.crop.height > 0);
  const first = defaultRecipe(); first.maskStrokes.push({ mode: "erase", radius: 0.1, points: [{ x: 0.5, y: 0.5 }] });
  assert.equal(defaultRecipe().maskStrokes.length, 0);
});

test("recipe equality ignores property order and normalizes missing fields", () => {
  assert.ok(recipesEqual({}, defaultRecipe()));
  assert.ok(!recipesEqual({}, { exposure: 0.1 }));
  assert.ok(!recipesEqual({}, { maskStrokes: [{ mode: "restore", radius: 0.05, points: [{ x: 0.4, y: 0.5 }] }] }));
});

test("mask recipe stays within the persisted thirty-stroke sixty-point contract", () => {
  const strokes = Array.from({ length: 31 }, () => ({ mode: "erase" as const, radius: 0.04,
    points: Array.from({ length: 75 }, (_, i) => ({ x: i / 75, y: 0.5 })) }));
  const recipe = normalizeRecipe({ maskStrokes: strokes });
  assert.equal(recipe.maskStrokes.length, 30);
  assert.equal(recipe.maskStrokes[0].points.length, 60);
});

test("automatic correction does not invent white balance or brighten uniform black products", () => {
  const black = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < black.length; i += 4) black.set([24, 24, 24, 255], i);
  const result = autoRecipe(black);
  assert.equal(result.temperature, 0);
  assert.equal(result.tint, 0);
  assert.equal(result.exposure, 0);
});

test("automatic correction is bounded and leaves geometry intact", () => {
  const pixels = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) pixels.set([i / 2, i / 2, i / 2, 255], i * 4);
  const recipe = autoRecipe({ data: pixels }, { rotation: 90, frame: "square" });
  assert.ok(recipe.exposure > 0 && recipe.exposure <= 0.7);
  assert.equal(recipe.rotation, 90);
  assert.equal(recipe.frame, "square");
});

test("neutral pipette inverts the actual linear-light warmth and tint gains", () => {
  for (const [r, g, b] of [[160, 150, 140], [150, 160, 150], [155, 142, 155]]) {
    const recipe = neutralPointRecipe({ r, g, b }, { rotation: 90, frame: "square" });
    const pixel = new Uint8ClampedArray([r, g, b, 255]);
    adjustPhotoPixels(pixel, recipe);
    assert.ok(Math.max(...pixel.slice(0, 3)) - Math.min(...pixel.slice(0, 3)) <= 1, `${r},${g},${b} => ${pixel}`);
    assert.equal(recipe.rotation, 90);
    assert.equal(recipe.frame, "square");
  }
});

test("pipette rejects invalid neutral points and bounds extreme casts", () => {
  assert.equal(neutralPointRecipe({ r: 0, g: 100, b: 100 }, { temperature: 5 }).temperature, 5);
  assert.equal(neutralPointRecipe({ r: NaN, g: 100, b: 100 }, { tint: 9 }).tint, 9);
  const recipe = neutralPointRecipe({ r: 240, g: 150, b: 40 });
  assert.equal(recipe.temperature, -100);
  assert.ok(recipe.tint >= -100 && recipe.tint <= 100);
});

test("alpha bounds include isolated thin parts and transparent images have no bounds", () => {
  const data = new Uint8ClampedArray(4 * 3 * 4);
  data[(1 * 4 + 1) * 4 + 3] = 255;
  data[(2 * 4 + 3) * 4 + 3] = 20;
  assert.deepEqual(findAlphaBounds({ data, width: 4, height: 3 }), { x: 0.25, y: 1 / 3, width: 0.75, height: 2 / 3 });
  assert.equal(findAlphaBounds({ data: new Uint8ClampedArray(16), width: 2, height: 2 }), null);
});

test("selected enclosed print is restored without filling another strap gap or changing RGB", () => {
  const pixels = new Uint8ClampedArray(9 * 7 * 4);
  for (let i = 0; i < 9 * 7; i++) pixels.set([201, 223, 241, 255], i * 4);
  for (const [x, y] of [[2, 2], [2, 3], [3, 3], [6, 2], [6, 3]]) pixels[(y * 9 + x) * 4 + 3] = 40;
  assert.equal(restoreEnclosedMaskRegion(pixels, 9, 7, 2, 2), 3);
  assert.equal(pixels[(3 * 9 + 3) * 4 + 3], 255);
  assert.equal(pixels[(2 * 9 + 6) * 4 + 3], 40);
  for (let i = 0; i < 9 * 7; i++) assert.deepEqual(Array.from(pixels.slice(i * 4, i * 4 + 3)), [201, 223, 241]);
});

test("outside-connected background and opaque clicks are unchanged", () => {
  const pixels = new Uint8ClampedArray(5 * 5 * 4).fill(255);
  for (const [x, y] of [[0, 2], [1, 2], [2, 2]]) pixels[(y * 5 + x) * 4 + 3] = 0;
  const before = pixels.slice();
  assert.equal(restoreEnclosedMaskRegion(pixels, 5, 5, 2, 2), 0);
  assert.equal(restoreEnclosedMaskRegion(pixels, 5, 5, 4, 4), 0);
  assert.deepEqual(pixels, before);
  assert.equal(restoreEnclosedMaskRegion(pixels, 50000, 50000, 2, 2), 0);
  assert.equal(restoreEnclosedMaskRegion(pixels, 5, 5, -1, 2), 0);
  const diagonal = new Uint8ClampedArray(5 * 5 * 4).fill(255);
  for (let p = 0; p < 3; p++) diagonal[(p * 5 + p) * 4 + 3] = 0;
  assert.equal(restoreEnclosedMaskRegion(diagonal, 5, 5, 2, 2), 0);
});

test("sharpening does not tint neutral pixels or modify alpha", () => {
  const data = new Uint8ClampedArray(5 * 5 * 4);
  for (let i = 0; i < 25; i++) data.set([100, 100, 100, i === 12 ? 200 : 255], i * 4);
  const before = data.slice();
  sharpenPhotoPixels(data, 5, 5, 70);
  assert.deepEqual(data, before);
});

test("dimensions rotate, retain full straighten bounds, frame, and respect export limit", () => {
  assert.deepEqual(getPhotoDimensions(800, 600, { rotation: 90 }), { width: 600, height: 800 });
  const straight = getPhotoDimensions(800, 600, { straighten: 15 });
  assert.ok(straight.width > 800 && straight.height > 600);
  assert.deepEqual(getPhotoDimensions(6000, 4000, { frame: "square", padding: 0.1 }), { width: 4096, height: 4096 });
  assert.deepEqual(getPhotoDimensions(800, 600, { crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }), { width: 400, height: 300 });
});
