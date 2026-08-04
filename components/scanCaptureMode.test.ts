import { test } from "node:test";
import assert from "node:assert";
import { resolveScanCaptureMode } from "./scanCaptureMode.ts";

// Chromium (NETUM Android handhelds): VirtualKeyboard API supported → suppress
// the soft keyboard via the contenteditable + virtualkeyboardpolicy capture.
test("defaults to contenteditable when the VirtualKeyboard API is supported", () => {
  assert.strictEqual(resolveScanCaptureMode(null, true), "contenteditable");
});

// Safari/Firefox have no VirtualKeyboard API — the contenteditable swap would
// buy nothing there, so those browsers keep the proven plain-input capture.
test("defaults to input when the VirtualKeyboard API is unsupported", () => {
  assert.strictEqual(resolveScanCaptureMode(null, false), "input");
});

// Escape hatch: if a device's scanner IME refuses to commit into a
// contenteditable host, ops can revert on-device without a deploy.
test("override 'input' wins even when the API is supported", () => {
  assert.strictEqual(resolveScanCaptureMode("input", true), "input");
});

test("override 'ce'/'contenteditable' forces the new capture regardless of detection", () => {
  assert.strictEqual(resolveScanCaptureMode("ce", false), "contenteditable");
  assert.strictEqual(resolveScanCaptureMode("contenteditable", false), "contenteditable");
});

test("unknown overrides fall back to feature detection", () => {
  assert.strictEqual(resolveScanCaptureMode("garbage", true), "contenteditable");
  assert.strictEqual(resolveScanCaptureMode("", false), "input");
  assert.strictEqual(resolveScanCaptureMode(undefined, false), "input");
});

// Values arrive raw from URL params / localStorage — be lenient about casing
// and stray whitespace so a hand-typed override on the device still works.
test("overrides are case- and whitespace-insensitive", () => {
  assert.strictEqual(resolveScanCaptureMode(" INPUT ", true), "input");
  assert.strictEqual(resolveScanCaptureMode("CE", false), "contenteditable");
});
