export type PhotoBackgroundQuality = "fast" | "best";
export type PhotoBackgroundProgress = { message: string; percent?: number };
export type PhotoBackgroundOptions = {
  quality?: PhotoBackgroundQuality;
  onProgress?: (progress: PhotoBackgroundProgress) => void;
  signal?: AbortSignal;
};

type WorkerReply = {
  id: number;
  type: "progress" | "result" | "error" | "retry-cpu";
  progress?: PhotoBackgroundProgress;
  blob?: Blob;
  message?: string;
};

type Job = {
  id: number;
  blob: Blob;
  quality: PhotoBackgroundQuality;
  options: PhotoBackgroundOptions;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  abort: () => void;
};

const abortError = () => new DOMException("Freistellen abgebrochen.", "AbortError");

/** One model worker for the photo workspace, independent of React renders. */
export class PhotoBackgroundProcessor {
  private worker: Worker | null = null;
  private active: Job | null = null;
  private queue: Job[] = [];
  private sequence = 0;
  private forceCpu = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private idleTimeout: ReturnType<typeof setTimeout> | undefined;
  private cache = new WeakMap<Blob, Partial<Record<PhotoBackgroundQuality, Blob>>>();
  private readonly createWorker: () => Worker;

  constructor(createWorker: () => Worker = () => {
    if (typeof Worker === "undefined") {
      throw new Error("Dieser Browser unterstützt das Freistellen nicht. Bitte einen aktuellen Chrome-, Edge- oder Safari-Browser verwenden.");
    }
    return new Worker(new URL("./photoBackground.worker.ts", import.meta.url), { type: "module" });
  }) { this.createWorker = createWorker; }

  remove(blob: Blob, options: PhotoBackgroundOptions = {}): Promise<Blob> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (!blob.size) return Promise.reject(new Error("Das Bild ist leer. Bitte ein anderes Foto auswählen."));
    const quality = options.quality === "best" ? "best" : "fast";
    const cached = this.cache.get(blob)?.[quality];
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.sequence, blob, quality, options, resolve, reject,
        abort: () => {
          if (this.active === job) {
            this.stopWorker();
            this.finish(undefined, abortError());
          } else {
            this.queue = this.queue.filter((queued) => queued !== job);
            options.signal?.removeEventListener("abort", job.abort);
            reject(abortError());
          }
        },
      };
      options.signal?.addEventListener("abort", job.abort, { once: true });
      this.queue.push(job);
      if (this.active) this.progress(job, { message: "Wartet auf das vorherige Bild …" });
      this.next();
    });
  }

  /** Releases model memory and cancels pending work, e.g. when leaving the workspace. */
  dispose(): void {
    clearTimeout(this.idleTimeout);
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = null;
    this.queue = [];
    this.stopWorker();
    for (const job of jobs) {
      job.options.signal?.removeEventListener("abort", job.abort);
      job.reject(abortError());
    }
    this.cache = new WeakMap();
  }

  private progress(job: Job, progress: PhotoBackgroundProgress): void {
    // UI callbacks must never interrupt worker cleanup or the following job.
    try { job.options.onProgress?.(progress); } catch { /* caller-owned callback */ }
  }

  private next(): void {
    if (this.active) return;
    clearTimeout(this.idleTimeout);
    const job = this.queue.shift();
    if (!job) {
      // Keep a warm model between photos, but do not retain hundreds of MB forever.
      this.idleTimeout = setTimeout(() => this.stopWorker(), 90_000);
      return;
    }
    this.active = job;
    const cached = this.cache.get(job.blob)?.[job.quality];
    if (cached) { this.finish(cached); return; }
    this.dispatch();
  }

  private dispatch(): void {
    const job = this.active;
    if (!job) return;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
          const reply = event.data;
          if (!this.active || reply.id !== this.active.id) return;
          if (reply.type === "progress" && reply.progress) this.progress(this.active, reply.progress);
          else if (reply.type === "result" && reply.blob instanceof Blob && reply.blob.size) this.finish(reply.blob);
          else if (reply.type === "retry-cpu" && !this.forceCpu) {
            // ORT is a singleton in IMG.LY. Start CPU in a clean worker after GPU failure.
            this.forceCpu = true;
            this.stopWorker();
            const retryJob = this.active;
            this.progress(retryJob, { message: "Grafikbeschleunigung nicht verfügbar. Freistellen wird fortgesetzt …" });
            if (this.active === retryJob) this.dispatch();
          } else if (reply.type !== "progress") {
            this.stopWorker();
            this.finish(undefined, new Error(reply.message || "Freistellen konnte nicht abgeschlossen werden. Bitte erneut versuchen."));
          }
        };
        this.worker.onerror = (event) => {
          event.preventDefault?.();
          this.stopWorker();
          this.finish(undefined, new Error("Das Freistellen wurde unterbrochen. Bitte erneut versuchen oder den Browser aktualisieren."));
        };
        this.worker.onmessageerror = () => {
          this.stopWorker();
          this.finish(undefined, new Error("Das Bild konnte nicht verarbeitet werden. Bitte erneut versuchen."));
        };
      }
      clearTimeout(this.timeout);
      this.timeout = setTimeout(() => {
        this.stopWorker();
        this.finish(undefined, new Error("Das Freistellen dauert auf diesem Gerät zu lange. Bitte erneut im Modus Schnell versuchen."));
      }, 180_000);
      this.progress(job, { message: "Freistellen vorbereiten …", percent: 0 });
      if (this.active !== job) return;
      this.worker.postMessage({ id: job.id, blob: job.blob, quality: job.quality, forceCpu: this.forceCpu });
    } catch (error) {
      this.stopWorker();
      this.finish(undefined, error instanceof Error ? error : new Error("Freistellen nicht verfügbar."));
    }
  }

  private finish(blob?: Blob, error?: Error): void {
    clearTimeout(this.timeout);
    const job = this.active;
    this.active = null;
    if (!job) return;
    job.options.signal?.removeEventListener("abort", job.abort);
    if (blob) {
      const versions = this.cache.get(job.blob) || {};
      versions[job.quality] = blob;
      this.cache.set(job.blob, versions);
      this.progress(job, { message: "Hintergrund entfernt", percent: 100 });
      job.resolve(blob);
    } else job.reject(error || new Error("Freistellen fehlgeschlagen."));
    this.next();
  }

  private stopWorker(): void {
    clearTimeout(this.timeout);
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
    }
    this.worker = null;
  }
}

const processor = new PhotoBackgroundProcessor();

/**
 * Returns a pure segmentation mask (white RGB, predicted alpha, PNG, max 4096px).
 * Its aspect matches the photo. Apply it to original pixels ONCE in the renderer;
 * the mask intentionally does not include the photo's existing transparency.
 */
export function removePhotoBackground(blob: Blob, options: PhotoBackgroundOptions = {}): Promise<Blob> {
  return processor.remove(blob, options);
}

export function releasePhotoBackground(): void {
  processor.dispose();
}
