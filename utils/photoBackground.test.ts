import test from "node:test";
import assert from "node:assert/strict";
import { PhotoBackgroundProcessor } from "./photoBackground.ts";

class FakeWorker {
  sent: Array<{ id: number; blob: Blob; quality: string; forceCpu: boolean }> = [];
  terminated = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage(data: FakeWorker["sent"][number]) { this.sent.push(data); }
  terminate() { this.terminated = true; }
  reply(type: string, extra: Record<string, unknown> = {}) {
    this.onmessage?.({ data: { id: this.sent.at(-1)?.id, type, ...extra } });
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const processor = new PhotoBackgroundProcessor(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { processor, workers };
}

test("serializes photos, reuses the worker and routes progress to the current photo", async () => {
  const { processor, workers } = setup();
  try {
    const progress: string[] = [];
    const first = processor.remove(new Blob(["one"]), { onProgress: (p) => progress.push(`one:${p.message}`) });
    const second = processor.remove(new Blob(["two"]), { onProgress: (p) => progress.push(`two:${p.message}`) });
    assert.equal(workers.length, 1);
    assert.equal(workers[0].sent.length, 1);
    workers[0].reply("result", { blob: new Blob(["cutout-one"]) });
    await first;
    assert.equal(workers[0].sent.length, 2);
    workers[0].reply("progress", { progress: { message: "model-ready", percent: 80 } });
    assert.equal(progress.at(-1), "two:model-ready");
    workers[0].reply("result", { blob: new Blob(["cutout-two"]) });
    assert.equal(await (await second).text(), "cutout-two");
  } finally { processor.dispose(); }
});

test("reuses a finished cutout, including a queued duplicate, but keeps qualities separate", async () => {
  const { processor, workers } = setup();
  try {
    const source = new Blob(["original"]);
    const first = processor.remove(source);
    const duplicate = processor.remove(source);
    const output = new Blob(["transparent"], { type: "image/png" });
    workers[0].reply("result", { blob: output });
    assert.equal(await first, output);
    assert.equal(await duplicate, output);
    assert.equal(await processor.remove(source), output);
    assert.equal(workers[0].sent.length, 1);
    const best = processor.remove(source, { quality: "best" });
    assert.equal(workers[0].sent.at(-1)?.quality, "best");
    workers[0].reply("result", { blob: output });
    await best;
  } finally { processor.dispose(); }
});

test("cancelling active inference terminates the worker and continues the next photo safely", async () => {
  const { processor, workers } = setup();
  try {
    const controller = new AbortController();
    const first = processor.remove(new Blob(["one"]), { signal: controller.signal });
    const rejected = assert.rejects(first, { name: "AbortError" });
    const second = processor.remove(new Blob(["two"]));
    controller.abort();
    await rejected;
    assert.equal(workers[0].terminated, true);
    assert.equal(workers.length, 2);
    workers[0].reply("result", { blob: new Blob(["stale-result"]) });
    workers[1].reply("result", { blob: new Blob(["two-result"]) });
    assert.equal(await (await second).text(), "two-result");
  } finally { processor.dispose(); }
});

test("cancelling a queued photo does not terminate the active worker", async () => {
  const { processor, workers } = setup();
  try {
    const first = processor.remove(new Blob(["one"]));
    const controller = new AbortController();
    const queued = processor.remove(new Blob(["two"]), { signal: controller.signal });
    const rejected = assert.rejects(queued, { name: "AbortError" });
    controller.abort();
    await rejected;
    assert.equal(workers[0].terminated, false);
    workers[0].reply("result", { blob: new Blob(["one-result"]) });
    await first;
    assert.equal(workers[0].sent.length, 1);
  } finally { processor.dispose(); }
});

test("restarts in CPU mode only once after GPU failure and retains that choice for later photos", async () => {
  const { processor, workers } = setup();
  try {
    const pending = processor.remove(new Blob(["one"]));
    workers[0].reply("retry-cpu");
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[1].sent[0].forceCpu, true);
    workers[1].reply("result", { blob: new Blob(["cutout"]) });
    await pending;
    const next = processor.remove(new Blob(["two"]));
    assert.equal(workers[1].sent.at(-1)?.forceCpu, true);
    workers[1].reply("retry-cpu");
    await assert.rejects(next, /Freistellen konnte nicht abgeschlossen/);
    assert.equal(workers.length, 2);
  } finally { processor.dispose(); }
});

test("worker errors clear the failed session, callbacks cannot block cleanup, and dispose cancels the queue", async () => {
  const { processor, workers } = setup();
  try {
    const first = processor.remove(new Blob(["one"]), { onProgress: () => { throw new Error("UI error"); } });
    const rejected = assert.rejects(first, /unterbrochen/);
    workers[0].onerror?.({ preventDefault() {} });
    await rejected;
    const second = processor.remove(new Blob(["two"]));
    const third = processor.remove(new Blob(["three"]));
    const secondRejected = assert.rejects(second, { name: "AbortError" });
    const thirdRejected = assert.rejects(third, { name: "AbortError" });
    processor.dispose();
    await Promise.all([secondRejected, thirdRejected]);
    assert.equal(workers[1].terminated, true);
  } finally { processor.dispose(); }
});

test("cancelling inside GPU fallback progress does not dispatch the following photo twice", async () => {
  const { processor, workers } = setup();
  try {
    const controller = new AbortController();
    const first = processor.remove(new Blob(["one"]), {
      signal: controller.signal,
      onProgress: (p) => { if (p.message.includes("Grafikbeschleunigung")) controller.abort(); },
    });
    const rejected = assert.rejects(first, { name: "AbortError" });
    const second = processor.remove(new Blob(["two"]));
    workers[0].reply("retry-cpu");
    await rejected;
    assert.equal(workers.length, 2);
    assert.equal(workers[1].sent.length, 1);
    workers[1].reply("result", { blob: new Blob(["mask"]) });
    await second;
  } finally { processor.dispose(); }
});

test("rejects an already cancelled or empty photo before creating a worker", async () => {
  const { processor, workers } = setup();
  try {
    await assert.rejects(processor.remove(new Blob(["photo"]), { signal: AbortSignal.abort() }), { name: "AbortError" });
    await assert.rejects(processor.remove(new Blob()), /leer/);
    assert.equal(workers.length, 0);
  } finally { processor.dispose(); }
});
