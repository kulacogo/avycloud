import test from "node:test";
import assert from "node:assert/strict";
import { getPhotoDimensions, photoPointToSource, sourcePointToPhoto } from "./photoEditorCanvas.ts";
import { normalizeRecipe, type PhotoRecipe } from "./photoEditor.ts";

function near(actual: { x: number; y: number } | null, expected: { x: number; y: number }) {
  assert.ok(actual);
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9, `x: ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9, `y: ${actual.y} != ${expected.y}`);
}

test("upright quarter-turn photo tools select the original pixel under the cursor", () => {
  // 1200x1600 rose source is stored sideways; its saved 270-degree view is 1600x1200.
  near(sourcePointToPhoto({ x: 0.25, y: 0.75 }, 1200, 1600, { rotation: 270 }), { x: 0.75, y: 0.75 });
  near(photoPointToSource({ x: 0.75, y: 0.75 }, 1200, 1600, { rotation: 270 }), { x: 0.25, y: 0.75 });
  // Existing recipes mirror in original axes before rotation; changing this would alter saved photos.
  near(sourcePointToPhoto({ x: 0.25, y: 0.75 }, 1200, 1600, { rotation: 270, flipX: true }), { x: 0.75, y: 0.25 });
});

test("pointer transforms round trip crop, framing, padding, all turns, flips and straightening", () => {
  for (const rotation of [0, 90, 180, 270] as const) for (const straighten of [-13.7, 0, 8.3]) {
    for (const flipX of [false, true]) for (const flipY of [false, true]) {
      for (const frame of ["original", "square", "portrait", "landscape"] as const) {
        const recipe = normalizeRecipe({ rotation, straighten, flipX, flipY, frame, padding: 0.073,
          crop: { x: 0.137, y: 0.093, width: 0.637, height: 0.731 } });
        for (const maxEdge of [733, 1000, 4096]) for (const [fx, fy] of [[0, 0], [0, 1], [1, 0], [1, 1], [0.271, 0.813]]) {
          const source = { x: recipe.crop.x + fx * recipe.crop.width, y: recipe.crop.y + fy * recipe.crop.height };
          const shown = sourcePointToPhoto(source, 4031, 3023, recipe, maxEdge);
          near(photoPointToSource(shown, 4031, 3023, recipe, maxEdge), source);
        }
      }
    }
  }
});

test("pointer mapping accounts for independently rounded raster dimensions", () => {
  const recipe: Partial<PhotoRecipe> = { crop: { x: 0.1, y: 0.2, width: 0.733, height: 0.677 }, frame: "square", padding: 0.13 };
  const dimensions = getPhotoDimensions(4031, 3023, recipe, 777);
  assert.deepEqual(dimensions, { width: 777, height: 777 });
  const scale = 777 / (4031 * 0.733 / 0.74);
  const rasterWidth = Math.round(4031 * 0.733 * scale);
  const rasterHeight = Math.round(3023 * 0.677 * scale);
  near(sourcePointToPhoto({ x: 0.1, y: 0.2 }, 4031, 3023, recipe, 777),
    { x: 0.5 - rasterWidth / 2 / 777, y: 0.5 - rasterHeight / 2 / 777 });
});

test("clicks on margins, rotation triangles and outside the image cannot paint product pixels", () => {
  assert.equal(photoPointToSource({ x: 0.01, y: 0.5 }, 1200, 1600, { frame: "square", padding: 0.1 }), null);
  assert.equal(photoPointToSource({ x: 0.01, y: 0.01 }, 1200, 1600, { straighten: 12 }), null);
  assert.equal(photoPointToSource({ x: -0.01, y: 0.5 }, 1200, 1600, {}), null);
  assert.equal(photoPointToSource({ x: 1.01, y: 0.5 }, 1200, 1600, {}), null);
  assert.equal(photoPointToSource({ x: NaN, y: 0.5 }, 1200, 1600, {}), null);
  near(photoPointToSource({ x: 0, y: 0 }, 1200, 1600, {}), { x: 0, y: 0 });
  near(photoPointToSource({ x: 1, y: 1 }, 1200, 1600, {}), { x: 1, y: 1 });
  assert.equal(photoPointToSource({ x: 1, y: 1 }, 10, 10,
    { crop: { x: 0.999, y: 0.999, width: 0.001, height: 0.001 } }), null);
});
