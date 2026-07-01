/**
 * Merging of chat-proposed datasheet changes from their two possible sources.
 *
 * The backend can surface the same edit in TWO ways within one chat response:
 *   1. `data.datasheetChanges` — the canonical, structured change objects
 *      produced by the pipeline's tool calls.
 *   2. A ```json block embedded in the assistant's message TEXT — which the UI
 *      strips from display but historically also parsed into change cards.
 *
 * Merging both unconditionally showed the SAME change twice (one chat request
 * -> two identical "Übernehmen" cards). The message-parsed source is only a
 * fallback for older pipelines that never emit structured changes.
 *
 * Rules:
 *   - If structured changes exist, they are canonical -> ignore the
 *     message-parsed source entirely.
 *   - Otherwise fall back to the message-parsed changes.
 *   - Deduplicate by content signature so an identical change never appears
 *     twice (defense in depth against a pipeline emitting it more than once).
 */

/** Deterministic, key-order-independent JSON stringify for signature hashing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Stable content signature used to detect duplicate change objects. */
export function datasheetChangeSignature(change: unknown): string {
  return stableStringify(change);
}

function isNonEmptyObject(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.keys(value as object).length > 0;
}

/**
 * Merge the two sources of chat datasheet changes into the list to display.
 *
 * @param structured  data.datasheetChanges (canonical structured output)
 * @param fromMessage changes parsed out of the assistant message text (fallback)
 */
export function mergeIncomingDatasheetChanges<T>(
  structured: T[] = [],
  fromMessage: T[] = []
): T[] {
  const base = structured && structured.length ? structured : fromMessage || [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const change of base) {
    if (!isNonEmptyObject(change)) continue;
    const sig = datasheetChangeSignature(change);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(change);
  }
  return out;
}
