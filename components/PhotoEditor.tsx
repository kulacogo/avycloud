import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProductImage } from "../types";
import { autoRecipe, defaultRecipe, findAlphaBounds, neutralPointRecipe, normalizeRecipe, recipesEqual, restoreEnclosedMaskRegion, type PhotoRecipe } from "../utils/photoEditor";
import { renderPhoto } from "../utils/photoEditorCanvas";
import { removePhotoBackground } from "../utils/photoBackground";
import { decodePhoto, encodePhoto, fetchPhotoBlob, photoBlobToDataUrl } from "../utils/photoEditorIO";
import { createPhotoHistory, pushPhotoHistory, type PhotoChange, type PhotoHistory } from "../utils/photoEditorSession";

type EditState = { recipe: PhotoRecipe; maskUrl?: string; maskBlob?: Blob; maskId?: number };
type Draft = { history: PhotoHistory<EditState>; initial: EditState };
type Decoded = Awaited<ReturnType<typeof decodePhoto>>;
type Resource = Decoded & { blob: Blob; mask?: Decoded; maskKey?: string | number };
type Props = { images: ProductImage[]; initialIndex: number; onApply: (changes: PhotoChange[]) => void; onClose: () => void };
const button = "rounded-lg border border-app-border bg-app-elevated px-3 py-2 text-xs font-medium text-txt-primary transition-colors hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed";
const current = (draft: Draft) => draft.history.entries[draft.history.position].value;
const changed = (draft: Draft) => !recipesEqual(current(draft).recipe, draft.initial.recipe) || current(draft).maskId !== draft.initial.maskId || current(draft).maskUrl !== draft.initial.maskUrl;
const photoSrc = (image: ProductImage): string => {
  const value = image.url_or_base64 as unknown;
  return typeof value === "string" ? value : value && typeof value === "object" && "url" in value && typeof value.url === "string" ? value.url : "";
};
const initialState = (image: ProductImage): EditState => ({ recipe: normalizeRecipe(image.photoEditor?.recipe), maskUrl: image.photoEditor?.maskUrl });

function Slider({ label, value, min = -100, max = 100, step = 1, suffix = "", onChange, onCommit }: {
  label: string; value: number; min?: number; max?: number; step?: number; suffix?: string;
  onChange: (value: number) => void; onCommit: () => void;
}) {
  return <label className="block space-y-1.5">
    <span className="flex justify-between gap-2 text-xs text-txt-secondary"><span>{label}</span><span className="tabular-nums text-txt-muted">{Number(value.toFixed(2))}{suffix}</span></span>
    <input aria-label={label} type="range" min={min} max={max} step={step} value={value}
      className="w-full accent-accent cursor-pointer" onChange={event => onChange(Number(event.target.value))}
      onPointerUp={onCommit} onPointerCancel={onCommit} onKeyUp={onCommit} onBlur={onCommit} />
  </label>;
}

export default function PhotoEditor({ images, initialIndex, onApply, onClose }: Props) {
  const [drafts, setDrafts] = useState<Draft[]>(() => images.map(image => { const initial = initialState(image); return { initial, history: createPhotoHistory(initial) }; }));
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [active, setActive] = useState(initialIndex);
  const activeRef = useRef(active); activeRef.current = active;
  const [tab, setTab] = useState<"light" | "background" | "geometry">("light");
  const [liveRecipe, setLiveRecipe] = useState<PhotoRecipe | null>(null);
  const liveRef = useRef<PhotoRecipe | null>(null);
  const [compare, setCompare] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [mode, setMode] = useState<"view" | "crop" | "erase" | "restore" | "fill" | "whitepoint">("view");
  const [brush, setBrush] = useState(0.025);
  const [quality, setQuality] = useState<"fast" | "best">("fast");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(images.map((_, index) => index)));
  const [batchOpen, setBatchOpen] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [stageSize, setStageSize] = useState({ width: 700, height: 450 });
  const [cropBox, setCropBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const resources = useRef(new Map<number, Resource>());
  const loading = useRef(new Map<number, Promise<Resource>>());
  const life = useRef(new AbortController());
  const operation = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const strokeId = useRef(0);
  const repairQueue = useRef(Promise.resolve());
  const pendingRepairs = useRef(0);
  const gesture = useRef<{ index: number; mode: typeof mode; points: Array<{ x: number; y: number }> } | null>(null);
  const edit = current(drafts[active]);
  const recipe = liveRecipe || edit.recipe;
  const dirtyCount = drafts.filter(changed).length;

  const commit = useCallback((index: number, value: EditState, label: string) => {
    const next = draftsRef.current.map((draft, i) => i === index ? { ...draft, history: pushPhotoHistory(draft.history, value, label) } : draft);
    draftsRef.current = next;
    setDrafts(next);
    setError(null);
  }, []);
  const commitSlider = useCallback(() => {
    if (!liveRef.current) return;
    const index = activeRef.current;
    commit(index, { ...current(draftsRef.current[index]), recipe: liveRef.current }, "Regler angepasst");
    liveRef.current = null; setLiveRecipe(null);
  }, [commit]);
  const adjust = (patch: Partial<PhotoRecipe>, label: string) => {
    commitSlider();
    commit(active, { ...edit, recipe: normalizeRecipe({ ...recipe, ...patch }) }, label);
  };
  const updateSlider = (key: keyof PhotoRecipe, value: number) => {
    const next = normalizeRecipe({ ...(liveRef.current || current(draftsRef.current[activeRef.current]).recipe), [key]: value });
    liveRef.current = next; setLiveRecipe(next);
  };
  const undo = useCallback((direction: number) => {
    liveRef.current = null; setLiveRecipe(null); setMode("view"); setCompare(false);
    const index = activeRef.current;
    setDrafts(previous => previous.map((draft, i) => i === index ? { ...draft, history: { ...draft.history, position: Math.max(0, Math.min(draft.history.entries.length - 1, draft.history.position + direction)) } } : draft));
  }, []);
  const select = (index: number) => { commitSlider(); setActive(index); setMode("view"); setCompare(false); setZoom(1); setCropBox(null); setError(null); };
  const requestClose = () => { commitSlider(); if (draftsRef.current.some(changed) || liveRef.current) setDiscard(true); else onClose(); };

  const loadResource = useCallback(async (index: number): Promise<Resource> => {
    if (resources.current.has(index)) return resources.current.get(index)!;
    if (loading.current.has(index)) return loading.current.get(index)!;
    const lifetime = life.current;
    const promise = (async () => {
      const image = images[index];
      const blob = await fetchPhotoBlob(image.photoEditor?.originalUrl || photoSrc(image), lifetime.signal);
      const decoded = await decodePhoto(blob);
      if (!alive.current || lifetime.signal.aborted) { decoded.close(); throw new DOMException("Abgebrochen", "AbortError"); }
      const resource = { ...decoded, blob };
      resources.current.set(index, resource);
      // Keep only three decoded originals resident. Drafts contain small recipes, not full images.
      for (const [key, old] of resources.current) {
        if (resources.current.size <= 3) break;
        if (key === index || key === activeRef.current) continue;
        old.close(); old.mask?.close(); resources.current.delete(key);
      }
      return resource;
    })();
    loading.current.set(index, promise);
    try { return await promise; } finally { if (loading.current.get(index) === promise) loading.current.delete(index); }
  }, [images]);

  const loadMask = useCallback(async (resource: Resource, state: EditState) => {
    const key = state.maskId || state.maskUrl;
    if (!key) return null;
    if (resource.maskKey !== key) {
      const blob = state.maskBlob || await fetchPhotoBlob(state.maskUrl!, life.current.signal);
      const decoded = await decodePhoto(blob);
      if (!alive.current) { decoded.close(); throw new DOMException("Abgebrochen", "AbortError"); }
      resource.mask?.close(); resource.mask = decoded; resource.maskKey = key;
    }
    return resource.mask!.source;
  }, []);

  useEffect(() => {
    alive.current = true;
    if (life.current.signal.aborted) life.current = new AbortController();
    const focus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const beforeUnload = (event: BeforeUnloadEvent) => { if (draftsRef.current.some(changed) || liveRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      alive.current = false; life.current.abort(); operation.current?.abort();
      loading.current.clear();
      resources.current.forEach(resource => { resource.close(); resource.mask?.close(); }); resources.current.clear();
      document.body.style.overflow = overflow; window.removeEventListener("beforeunload", beforeUnload); focus?.focus();
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      setStageSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let valid = true;
    setError(null);
    loadResource(active).then(() => { if (valid) setLoaded(value => value + 1); }).catch(reason => { if (valid && reason?.name !== "AbortError") setError(reason.message); });
    return () => { valid = false; };
  }, [active, loadResource]);

  useEffect(() => {
    let valid = true;
    const frame = requestAnimationFrame(() => {
      void (async () => {
        const resource = resources.current.get(active);
        const target = canvasRef.current;
        if (!resource || !target) return;
        const sourceMode = mode === "crop" || mode === "whitepoint";
        const maskMode = mode === "erase" || mode === "restore" || mode === "fill";
        const mask = compare || sourceMode ? null : await loadMask(resource, edit);
        if (!valid) return;
        const shown = compare || sourceMode ? defaultRecipe() : maskMode ? { ...defaultRecipe(), background: "transparent" as const, maskStrokes: recipe.maskStrokes } : recipe;
        const result = renderPhoto(resource.source, resource.width, resource.height, shown, mask, 1000);
        target.width = result.width; target.height = result.height;
        target.getContext("2d")?.drawImage(result, 0, 0);
        setSize({ width: result.width, height: result.height });
      })().catch(reason => { if (valid && reason?.name !== "AbortError") setError(reason.message); });
    });
    return () => { valid = false; cancelAnimationFrame(frame); };
  }, [active, recipe, edit.maskId, edit.maskUrl, compare, loaded, mode, loadMask]);

  const auto = async () => {
    try {
      commitSlider();
      const resource = await loadResource(active);
      const canvas = renderPhoto(resource.source, resource.width, resource.height, defaultRecipe(), null, 512);
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
      commit(active, { ...edit, recipe: autoRecipe(pixels, recipe) }, "Licht automatisch"); setCompare(false); setMode("view");
    } catch (reason) { setError((reason as Error).message); }
  };

  const removeBackground = async (indexes: number[]) => {
    if (operation.current) return;
    commitSlider(); setMode("view"); setCompare(false); setError(null);
    const controller = new AbortController(); operation.current = controller;
    try {
      for (let n = 0; n < indexes.length; n++) {
        if (controller.signal.aborted) break;
        const index = indexes[n];
        setBusy(`Bild ${index + 1} freistellen · ${n + 1}/${indexes.length}`); setPercent(undefined);
        const resource = await loadResource(index);
        if (controller.signal.aborted) break;
        const maskBlob = await removePhotoBackground(resource.blob, { quality, signal: controller.signal, onProgress: progress => {
          if (alive.current) { setBusy(`Bild ${index + 1} · ${progress.message}`); setPercent(progress.percent); }
        } });
        if (!alive.current || controller.signal.aborted) break;
        const state = current(draftsRef.current[index]);
        commit(index, { recipe: { ...state.recipe, background: "white", maskStrokes: [] }, maskBlob, maskId: ++strokeId.current }, "Hintergrund entfernt");
      }
    } catch (reason) { if (alive.current && (reason as Error).name !== "AbortError") setError((reason as Error).message); }
    finally { operation.current = null; if (alive.current) { setBusy(null); setPercent(undefined); setLoaded(value => value + 1); } }
  };

  const copyLook = () => {
    commitSlider();
    const { exposure, shadows, highlights, contrast, temperature, tint, saturation, sharpness, background, frame, padding, shadow } = recipe;
    for (const index of selected) {
      if (index === active) continue;
      const state = current(draftsRef.current[index]);
      // A mask and a crop belong to their own photo; never copy them to another product view.
      commit(index, { ...state, recipe: { ...state.recipe, exposure, shadows, highlights, contrast, temperature, tint, saturation, sharpness, frame, padding, shadow, background: state.maskUrl || state.maskBlob ? background : "original" } }, "Bildstil übernommen");
    }
    setBatchOpen(false);
  };

  const centerProduct = async () => {
    try {
      const resource = await loadResource(active);
      const mask = await loadMask(resource, edit);
      if (!mask) return;
      const canvas = renderPhoto(resource.source, resource.width, resource.height, { ...defaultRecipe(), background: "transparent", maskStrokes: recipe.maskStrokes }, mask, 1000);
      const bounds = findAlphaBounds(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height));
      if (!bounds) throw new Error("Kein freigestelltes Produkt erkannt. Maske nachbessern.");
      adjust({ crop: bounds, frame: "square", padding: 0.06, background: recipe.background === "original" ? "white" : recipe.background }, "Produkt zentriert");
    } catch (reason) { setError((reason as Error).message); }
  };

  const apply = async () => {
    if (operation.current) return;
    commitSlider(); setError(null);
    const controller = new AbortController(); operation.current = controller;
    try {
      const changes: PhotoChange[] = [];
      let payloadSize = 0;
      const indexes = draftsRef.current.map((draft, index) => changed(draft) ? index : -1).filter(index => index >= 0);
      for (const index of indexes) {
        setBusy(`Bild ${index + 1} vorbereiten · ${changes.length + 1}/${indexes.length}`);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        const state = current(draftsRef.current[index]);
        const resource = await loadResource(index);
        const mask = await loadMask(resource, state);
        if (controller.signal.aborted || !alive.current) return;
        const canvas = renderPhoto(resource.source, resource.width, resource.height, state.recipe, mask, 4096);
        const alpha = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
        let transparent = false;
        for (let i = 3; i < alpha.length; i += 4) if (alpha[i] < 255) { transparent = true; break; }
        const blob = await encodePhoto(canvas, transparent);
        let originalBlob = resource.blob;
        if (!images[index].photoEditor && !/^image\/(jpeg|png|webp)$/i.test(originalBlob.type)) {
          const originalCanvas = renderPhoto(resource.source, resource.width, resource.height, defaultRecipe(), null, 4096);
          originalBlob = await encodePhoto(originalCanvas, true);
        }
        let maskBlob: Blob | undefined;
        if (state.maskBlob && mask) {
          const maskCanvas = document.createElement("canvas");
          const scale = Math.min(1, 4096 / Math.max(resource.width, resource.height));
          maskCanvas.width = Math.max(1, Math.round(resource.width * scale)); maskCanvas.height = Math.max(1, Math.round(resource.height * scale));
          const context = maskCanvas.getContext("2d")!;
          context.drawImage(mask, 0, 0, maskCanvas.width, maskCanvas.height);
          context.globalCompositeOperation = "source-in"; context.fillStyle = "white"; context.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
          maskBlob = await encodePhoto(maskCanvas, true);
        }
        if ([blob, originalBlob, maskBlob].some(asset => asset && asset.size > 20 * 1024 * 1024)) throw new Error(`Bild ${index + 1} ist zu groß. Bitte eine kleinere Originaldatei verwenden (maximal 20 MB).`);
        const originalUrl = images[index].photoEditor?.originalUrl || await photoBlobToDataUrl(originalBlob);
        const maskUrl = maskBlob ? await photoBlobToDataUrl(maskBlob) : state.maskUrl;
        const image: ProductImage = { ...images[index], url_or_base64: await photoBlobToDataUrl(blob), width: canvas.width, height: canvas.height, mimeType: blob.type,
          photoEditor: { version: 1, originalUrl, originalMimeType: originalBlob.type, ...(maskUrl ? { maskUrl } : {}), recipe: state.recipe, updatedAt: new Date().toISOString() } };
        payloadSize += JSON.stringify(image).length;
        if (payloadSize > 35 * 1024 * 1024) throw new Error("Diese Bildserie ist zu groß. Bitte weniger Fotos gleichzeitig übernehmen und das Produkt zwischendurch speichern.");
        changes.push({ index, expected: images[index], image });
      }
      if (!alive.current || controller.signal.aborted) return;
      const finalImages = images.map((image, index) => changes.find(change => change.index === index)?.image || image);
      if (JSON.stringify(finalImages).length > 35 * 1024 * 1024) throw new Error("Die Bilder einschließlich ungesicherter Uploads sind zu groß. Bitte das Produkt zuerst mit einer kleineren Bildauswahl speichern.");
      onApply(changes);
    } catch (reason) { if (alive.current && (reason as Error).name !== "AbortError") setError((reason as Error).message); }
    finally { operation.current = null; if (alive.current) setBusy(null); }
  };

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 10000) / 10000, y: Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * 10000) / 10000 };
  };
  const restoreRegion = async (p: { x: number; y: number }) => {
    const index = active;
    try {
      const resource = await loadResource(index);
      const state = current(draftsRef.current[index]);
      const mask = await loadMask(resource, state);
      if (!mask) return;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 4096 / Math.max(resource.width, resource.height));
      canvas.width = Math.round(resource.width * scale); canvas.height = Math.round(resource.height * scale);
      const context = canvas.getContext("2d")!;
      context.drawImage(mask, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const count = restoreEnclosedMaskRegion(pixels.data, canvas.width, canvas.height, Math.min(canvas.width - 1, Math.floor(p.x * canvas.width)), Math.min(canvas.height - 1, Math.floor(p.y * canvas.height)));
      if (!count) { setError("Eine entfernte Innenfläche anklicken. Für offene Ränder „Zurückmalen“ verwenden."); return; }
      context.putImageData(pixels, 0, 0);
      const maskBlob = await encodePhoto(canvas, true);
      if (!alive.current || operation.current?.signal.aborted) return;
      // If another operation changed this mask while encoding, never replace it.
      if (current(draftsRef.current[index]) !== state) return;
      commit(index, { ...state, maskUrl: undefined, maskBlob, maskId: ++strokeId.current }, "Innenfläche gerettet");
    } catch (reason) { if (alive.current) setError((reason as Error).message); }
  };
  const queueRegionRepair = (p: { x: number; y: number }) => {
    if (pendingRepairs.current === 0) operation.current = new AbortController();
    const controller = operation.current!;
    pendingRepairs.current++;
    setBusy("Innenfläche wiederherstellen …");
    repairQueue.current = repairQueue.current.then(async () => {
      if (alive.current && !controller.signal.aborted) await restoreRegion(p);
    }).finally(() => {
      pendingRepairs.current--;
      if (!pendingRepairs.current) {
        operation.current = null;
        if (alive.current) setBusy(null);
      }
    });
  };
  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === "view" || (busy && !(mode === "fill" && pendingRepairs.current > 0)) || compare) return;
    const p = point(event);
    if (mode === "fill") { queueRegionRepair(p); return; }
    if (mode === "whitepoint") {
      const ctx = event.currentTarget.getContext("2d")!;
      const x = Math.min(event.currentTarget.width - 1, Math.floor(p.x * event.currentTarget.width));
      const y = Math.min(event.currentTarget.height - 1, Math.floor(p.y * event.currentTarget.height));
      const pixels = ctx.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), Math.min(5, event.currentTarget.width - Math.max(0, x - 2)), Math.min(5, event.currentTarget.height - Math.max(0, y - 2))).data;
      let r = 0, g = 0, b = 0, count = 0;
      for (let i = 0; i < pixels.length; i += 4) { if (pixels[i + 3] < 200) continue; r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; count++; }
      if (!count) return;
      r /= count; g /= count; b /= count;
      if (Math.min(r, g, b) < 40 || Math.max(r, g, b) > 250) { setError("Eine mittelhelle, neutrale graue oder weiße Stelle wählen."); return; }
      adjust(neutralPointRecipe({ r, g, b }, recipe), "Weißabgleich per Pipette");
      setMode("view"); return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { index: active, mode, points: [p] };
    if (mode === "crop") setCropBox({ x: p.x, y: p.y, width: 0, height: 0 });
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = gesture.current;
    if (!drag) return;
    const p = point(event);
    if (drag.mode === "crop") {
      const start = drag.points[0];
      setCropBox({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(start.x - p.x), height: Math.abs(start.y - p.y) });
    } else {
      drag.points.push(p);
      if (drag.points.length > 60) drag.points = drag.points.filter((_, index) => index % 2 === 0);
      const state = current(draftsRef.current[active]);
      const next = { ...state.recipe, maskStrokes: [...state.recipe.maskStrokes, { mode: drag.mode as "erase" | "restore", radius: brush, points: [...drag.points] }] };
      liveRef.current = next; setLiveRecipe(next);
    }
  };
  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = gesture.current; gesture.current = null;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.mode === "crop") {
      if (cropBox && cropBox.width > 0.025 && cropBox.height > 0.025) { adjust({ crop: cropBox }, "Zugeschnitten"); setMode("view"); }
      setCropBox(null);
    } else {
      const state = current(draftsRef.current[drag.index]);
      if (state.recipe.maskStrokes.length >= 30) { liveRef.current = null; setLiveRecipe(null); setError("30 Pinselzüge erreicht. Nicht benötigte Züge im Verlauf zurücknehmen."); return; }
      const next = { ...state.recipe, maskStrokes: [...state.recipe.maskStrokes, { mode: drag.mode as "erase" | "restore", radius: brush, points: drag.points }] };
      liveRef.current = null; setLiveRecipe(null); commit(drag.index, { ...state, recipe: next }, drag.mode === "erase" ? "Hintergrund nachgebessert" : "Bildteil wiederhergestellt");
    }
  };

  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Tab") {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') || []).filter(element => element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (mode !== "view") setMode("view"); else if (!busy) requestClose(); return; }
    if (busy) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey ? 1 : -1); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") { event.preventDefault(); undo(1); return; }
    if ((event.target as HTMLElement).matches("input,select,textarea,button")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); select(Math.min(images.length - 1, active + 1)); }
    if (event.key === "ArrowLeft") { event.preventDefault(); select(Math.max(0, active - 1)); }
    if (event.key.toLowerCase() === "r") adjust({ rotation: ((recipe.rotation + 90) % 360) as PhotoRecipe["rotation"] }, "90° gedreht");
  };

  const hasMask = Boolean(edit.maskUrl || edit.maskBlob);
  const resource = resources.current.get(active);
  const fit = Math.min(stageSize.width / size.width, stageSize.height / size.height, 1) * zoom;
  return createPortal(<div className="fixed inset-0 z-[100] bg-app-bg/95 p-0 sm:p-3 lg:p-5">
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Bildwerkstatt" onKeyDown={keyDown}
      className="flex h-full w-full flex-col overflow-hidden rounded-none sm:rounded-2xl border border-app-border bg-app-bg text-txt-primary shadow-2xl outline-none">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 py-3">
        <div className="min-w-0"><div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">Produktfotos</div><h2 className="font-semibold text-lg">Bildwerkstatt <span className="ml-2 text-sm font-normal text-txt-muted">{active + 1} / {images.length}</span></h2></div>
        <div className="flex items-center gap-2">
          <button type="button" className={button} title="Rückgängig (Strg/⌘ Z)" aria-label="Rückgängig" disabled={!!busy || drafts[active].history.position === 0} onClick={() => undo(-1)}>↶ <span className="hidden sm:inline">Rückgängig</span></button>
          <button type="button" className={button} title="Wiederholen (Strg/⌘ Umschalt Z)" aria-label="Wiederholen" disabled={!!busy || drafts[active].history.position === drafts[active].history.entries.length - 1} onClick={() => undo(1)}>↷</button>
          <button type="button" className={button} aria-label="Bildwerkstatt schließen" onClick={requestClose} disabled={!!busy}>✕</button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs">
            <div className="flex items-center gap-2"><button type="button" disabled={!resource} aria-pressed={compare} onClick={() => { commitSlider(); setCompare(!compare); setMode("view"); }} className={`${button} ${compare ? "border-accent text-accent" : ""}`}>{compare ? "Original ansehen" : "Vorher / Nachher"}</button><span className="hidden lg:inline text-txt-muted">{compare ? "Original" : "Vorschau"}</span></div>
            <div className="flex items-center gap-1"><button type="button" className={button} aria-label="Verkleinern" onClick={() => setZoom(Math.max(1, zoom - 0.5))}>−</button><button type="button" className={button} onClick={() => setZoom(1)}>{Math.round(zoom * 100)} %</button><button type="button" className={button} aria-label="Vergrößern" onClick={() => setZoom(Math.min(3, zoom + 0.5))}>+</button></div>
          </div>
          <div ref={stageRef} className="relative flex min-h-[200px] min-w-0 flex-1 items-center justify-center overflow-auto bg-app-elevated p-4 sm:p-6">
            {!resource ? <div className="text-sm text-txt-muted">{error ? "Foto nicht verfügbar" : "Original wird geladen …"}</div> : <div className="relative shrink-0" style={{ width: Math.max(1, size.width * fit), height: Math.max(1, size.height * fit) }}>
              <canvas ref={canvasRef} aria-label={`Bildvorschau ${active + 1}`} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { gesture.current = null; liveRef.current = null; setLiveRecipe(null); setCropBox(null); }}
                className={`block h-full w-full object-contain shadow-lg ${mode !== "view" ? "cursor-crosshair touch-none" : ""}`}
                style={{ background: "repeating-conic-gradient(#d8dce2 0% 25%, #f3f4f6 0% 50%) 50% / 20px 20px" }} />
              {mode === "crop" && cropBox && <div className="pointer-events-none absolute border-2 border-accent bg-accent/10" style={{ left: `${cropBox.x * 100}%`, top: `${cropBox.y * 100}%`, width: `${cropBox.width * 100}%`, height: `${cropBox.height * 100}%` }} />}
            </div>}
            {mode !== "view" && <div className="absolute left-4 top-3 rounded-lg border border-app-border bg-app-surface/95 px-3 py-2 text-xs shadow-lg">{mode === "crop" ? "Ausschnitt aufziehen" : mode === "whitepoint" ? "Neutrale graue / weiße Stelle anklicken" : mode === "erase" ? "Hintergrund wegradieren" : mode === "fill" ? "Verlorene Schrift oder Innenfläche anklicken" : "Produktteile zurückmalen"}<button type="button" className="ml-3 text-accent" onClick={() => setMode("view")}>Fertig</button></div>}
          </div>
          <div className="shrink-0 px-4 py-2 text-[11px] text-txt-muted">{resource ? `Original · ${resource.width} × ${resource.height} px` : ""}</div>
          <div className="flex shrink-0 gap-2 overflow-x-auto border-t border-app-border bg-app-surface p-3">
            {images.map((image, index) => <div key={index} className="relative shrink-0"><button type="button" disabled={!!busy} onClick={() => select(index)} aria-label={`Bild ${index + 1} bearbeiten`} aria-pressed={index === active}
              className={`relative h-16 w-16 overflow-hidden rounded-lg border-2 ${index === active ? "border-accent" : "border-app-border"}`}><img src={photoSrc(image)} alt={`Bild ${index + 1}`} className="h-full w-full object-cover" /><span className="absolute bottom-0 left-0 rounded-tr bg-app-bg/90 px-1.5 text-[10px] text-txt-primary">{index + 1}</span>{changed(drafts[index]) && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent" />}</button>{batchOpen && <input aria-label={`Bild ${index + 1} für Serie auswählen`} type="checkbox" checked={selected.has(index)} onChange={() => setSelected(previous => { const next = new Set(previous); next.has(index) ? next.delete(index) : next.add(index); return next; })} className="absolute right-1 top-1 accent-accent" />}</div>)}
          </div>
        </main>
        <aside className="flex max-h-[44vh] w-full shrink-0 flex-col border-t md:max-h-none md:w-[310px] lg:w-[336px] md:border-l md:border-t-0 border-app-border bg-app-surface">
          <div className="grid shrink-0 grid-cols-3 gap-1 border-b border-app-border p-2" role="tablist" aria-label="Bildwerkzeuge">{([["light", "Licht & Farbe"], ["background", "Freistellen"], ["geometry", "Ausrichten"]] as const).map(([key, label]) => <button type="button" key={key} role="tab" aria-selected={tab === key} onClick={() => { commitSlider(); setTab(key); setMode("view"); }} className={`rounded-lg px-1 py-2 text-xs font-medium ${tab === key ? "bg-accent/15 text-accent" : "text-txt-muted hover:bg-app-elevated"}`}>{label}</button>)}</div>
          <fieldset disabled={!!busy || !resource} className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 disabled:opacity-60">
            {tab === "light" && <>
              <div className="grid grid-cols-2 gap-2"><button type="button" className={`${button} border-accent text-accent`} onClick={() => void auto()}>✦ Auto-Licht</button><button type="button" className={button} onClick={() => adjust({ exposure: 0, shadows: 0, highlights: 0, contrast: 0, temperature: 0, tint: 0, saturation: 0, sharpness: 0 }, "Licht zurückgesetzt")}>Neutral</button><button type="button" className={button} onClick={() => adjust({ exposure: 0.35, shadows: 30, highlights: -20, contrast: 4 }, "Dunkles Foto aufgehellt")}>Dunkles Foto</button><button type="button" className={button} onClick={() => { setCompare(false); setZoom(1); setMode(mode === "whitepoint" ? "view" : "whitepoint"); }}>Weißabgleich-Pipette</button></div>
              <Slider label="Belichtung" value={recipe.exposure} min={-2} max={2} step={0.05} suffix=" EV" onChange={v => updateSlider("exposure", v)} onCommit={commitSlider} />
              {([["shadows", "Tiefen"], ["highlights", "Lichter"], ["contrast", "Kontrast"], ["temperature", "Wärme"], ["tint", "Farbton"], ["saturation", "Sättigung"]] as const).map(([key, label]) => <Slider key={key} label={label} value={recipe[key]} onChange={v => updateSlider(key, v)} onCommit={commitSlider} />)}
              <Slider label="Schärfe" value={recipe.sharpness} min={0} onChange={v => updateSlider("sharpness", v)} onCommit={commitSlider} />
            </>}
            {tab === "background" && <>
              <div className="space-y-2"><button type="button" className="w-full rounded-lg bg-accent px-3 py-3 text-sm font-semibold text-white hover:bg-accent/90" onClick={() => void removeBackground([active])}>{hasMask ? "Freistellung neu berechnen" : "Hintergrund entfernen"}</button><select aria-label="Freistellqualität" value={quality} onChange={event => setQuality(event.target.value as typeof quality)} className="w-full rounded-lg border border-app-border bg-app-elevated p-2 text-xs"><option value="fast">Schnell & fein</option><option value="best">Höchste Präzision</option></select><p className="text-[11px] text-txt-muted">Modell wird beim ersten Mal geladen; danach wiederverwendet.</p></div>
              <div><div className="mb-2 text-xs font-medium text-txt-secondary">Hintergrund</div><div className="grid grid-cols-2 gap-2">{([["original", "Original"], ["transparent", "Transparent"], ["white", "Weiß"], ["studio", "Studiograu"]] as const).map(([value, label]) => <button type="button" key={value} disabled={value !== "original" && !hasMask} aria-pressed={recipe.background === value} className={`${button} ${recipe.background === value ? "border-accent text-accent" : ""}`} onClick={() => adjust({ background: value }, `Hintergrund: ${label}`)}>{label}</button>)}</div></div>
              {hasMask && <><div><div className="mb-2 text-xs font-medium text-txt-secondary">Kanten nachbessern</div><div className="grid grid-cols-2 gap-2"><button type="button" className={`${button} ${mode === "erase" ? "border-accent" : ""}`} onClick={() => { commitSlider(); setMode("erase"); setZoom(1); setCompare(false); }}>Radieren</button><button type="button" className={`${button} ${mode === "restore" ? "border-accent" : ""}`} onClick={() => { commitSlider(); setMode("restore"); setZoom(1); setCompare(false); }}>Zurückmalen</button></div><button type="button" className={`${button} mt-2 w-full ${mode === "fill" ? "border-accent" : ""}`} onClick={() => { commitSlider(); setMode("fill"); setZoom(1); setCompare(false); }}>Schrift / Innenfläche retten</button></div><Slider label="Pinselgröße" value={brush * 100} min={0.3} max={12} step={0.1} suffix=" %" onChange={v => setBrush(v / 100)} onCommit={() => {}} /><Slider label="Schatten" value={recipe.shadow} min={0} onChange={v => updateSlider("shadow", v)} onCommit={commitSlider} /></>}
            </>}
            {tab === "geometry" && <>
              <div className="grid grid-cols-2 gap-2"><button type="button" className={button} onClick={() => adjust({ rotation: ((recipe.rotation + 270) % 360) as PhotoRecipe["rotation"] }, "Links gedreht")}>↶ 90° links</button><button type="button" className={button} onClick={() => adjust({ rotation: ((recipe.rotation + 90) % 360) as PhotoRecipe["rotation"] }, "Rechts gedreht")}>↷ 90° rechts</button><button type="button" className={button} onClick={() => adjust({ flipX: !recipe.flipX }, "Horizontal gespiegelt")}>↔ Spiegeln</button><button type="button" className={button} onClick={() => adjust({ flipY: !recipe.flipY }, "Vertikal gespiegelt")}>↕ Spiegeln</button></div>
              <Slider label="Geraderücken" value={recipe.straighten} min={-15} max={15} step={0.1} suffix="°" onChange={v => updateSlider("straighten", v)} onCommit={commitSlider} />
              <div className="grid grid-cols-2 gap-2"><button type="button" className={button} onClick={() => { commitSlider(); setMode("crop"); setCompare(false); setZoom(1); }}>Zuschneiden</button><button type="button" className={button} onClick={() => adjust({ crop: defaultRecipe().crop }, "Ausschnitt zurückgesetzt")}>Ganzes Foto</button></div>
              {hasMask && <button type="button" className={`${button} w-full`} onClick={() => void centerProduct()}>Produkt automatisch zentrieren</button>}
              <div><div className="mb-2 text-xs font-medium text-txt-secondary">Bildformat</div><div className="grid grid-cols-2 gap-2">{([["original", "Original"], ["square", "1:1 Quadrat"], ["portrait", "4:5 Hochformat"], ["landscape", "4:3 Querformat"]] as const).map(([value, label]) => <button type="button" key={value} className={`${button} ${recipe.frame === value ? "border-accent text-accent" : ""}`} onClick={() => adjust({ frame: value }, label)}>{label}</button>)}</div></div>
              <Slider label="Rand" value={recipe.padding * 100} min={0} max={25} suffix=" %" onChange={v => updateSlider("padding", v / 100)} onCommit={commitSlider} />
            </>}
            <div className="space-y-3 border-t border-app-border pt-4"><button type="button" className={`${button} w-full`} onClick={() => setBatchOpen(!batchOpen)}>Bildstil auf weitere Fotos …</button>{batchOpen && <div className="space-y-2"><div className="text-xs text-txt-muted">{selected.size} Bilder unten ausgewählt</div><button type="button" className={`${button} w-full`} disabled={selected.size === 0} onClick={copyLook}>Licht & Format übertragen</button><button type="button" className={`${button} w-full`} disabled={selected.size === 0} onClick={() => void removeBackground([...selected])}>Auswahl freistellen</button></div>}
              <details className="text-xs"><summary className="cursor-pointer text-txt-secondary">Verlauf · {drafts[active].history.position} Schritte</summary><div className="mt-2 space-y-1">{drafts[active].history.entries.map((entry, index) => <button type="button" key={index} className={`block w-full rounded px-2 py-1 text-left ${index === drafts[active].history.position ? "bg-accent/10 text-accent" : "text-txt-muted"}`} onClick={() => undo(index - drafts[active].history.position)}>{index}. {entry.label}</button>)}</div></details>
              <button type="button" className="text-xs text-txt-muted underline hover:text-txt-primary" onClick={() => { commitSlider(); commit(active, { ...edit, recipe: defaultRecipe() }, "Original wiederhergestellt"); setMode("view"); setCompare(false); }}>Original wiederherstellen</button>
            </div>
          </fieldset>
        </aside>
      </div>
      {error && <div role="alert" className="shrink-0 border-t border-danger/30 bg-danger-dim px-4 py-2 text-sm text-danger">{error}</div>}
      <footer className="shrink-0 border-t border-app-border bg-app-surface px-4 py-3">
        {busy ? <div role="status" className="flex items-center gap-3"><div className="min-w-0 flex-1"><div className="text-sm">{busy}</div>{typeof percent === "number" && <div className="mt-2 h-1 rounded-full bg-app-elevated"><div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} /></div>}</div><button type="button" className={button} onClick={() => operation.current?.abort()}>Abbrechen</button></div> : discard ? <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-sm">Ungesicherte Bildänderungen verwerfen?</span><div className="flex gap-2"><button type="button" className={button} onClick={() => setDiscard(false)}>Weiter bearbeiten</button><button type="button" className={`${button} text-danger`} onClick={onClose}>Verwerfen</button></div></div> : <div className="flex items-center justify-between gap-3"><span className="text-xs text-txt-muted">{dirtyCount ? `${dirtyCount} Foto${dirtyCount === 1 ? "" : "s"} bearbeitet` : "Originale bleiben erhalten"}</span><div className="flex items-center gap-2"><button type="button" className={button} onClick={requestClose}>Schließen</button><button type="button" disabled={!dirtyCount} className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-40" onClick={() => void apply()}>Ins Datenblatt übernehmen{dirtyCount > 1 ? ` (${dirtyCount})` : ""}</button></div></div>}
      </footer>
    </div>
  </div>, document.body);
}
