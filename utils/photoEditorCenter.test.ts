import assert from "node:assert/strict";
import { test } from "node:test";
import { centeredPhotoCrop } from "./photoEditor.ts";
import { getPhotoDimensions } from "./photoEditorCanvas.ts";

test("centering the rotated rose box keeps its 4:3 frame and every detected product pixel", () => {
  const bounds = { x: 0.2267, y: 0.206, width: 0.732, height: 0.611 };
  const crop = centeredPhotoCrop(bounds, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(crop.x <= bounds.x && crop.y <= bounds.y);
  assert.ok(crop.x + crop.width >= bounds.x + bounds.width - 1e-12);
  assert.ok(crop.y + crop.height >= bounds.y + bounds.height - 1e-12);
  assert.equal(crop.width, crop.height);
  const result = getPhotoDimensions(1200, 1600, { crop, rotation: 270, padding: 0.06 });
  assert.ok(Math.abs(result.width / result.height - 4 / 3) < 0.002);
});

test("centering respects a previous crop, its aspect ratio and its border", () => {
  const previous = { x: 0.2, y: 0.1, width: 0.6, height: 0.8 };
  const crop = centeredPhotoCrop({ x: 0, y: 0.5, width: 0.7, height: 0.5 }, previous);
  assert.equal(crop.x, previous.x);
  assert.ok(Math.abs(crop.y + crop.height - 0.9) < 1e-12);
  assert.ok(Math.abs(crop.width / crop.height - previous.width / previous.height) < 1e-12);
  assert.ok(crop.x + crop.width <= previous.x + previous.width);
});
