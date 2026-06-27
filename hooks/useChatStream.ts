import { useCallback, useRef, useState } from 'react';
import { startChatStream, ChatAssistantPayload } from '../api/client';

export type StreamEventType =
  | 'start'
  | 'thinking'
  | 'grounding'
  | 'tool_start'
  | 'tool_done'
  | 'needs_human'
  | 'result'
  | 'done'
  | 'error';

export type GroundingChunk = { uri: string; title?: string };

export type StreamEvent =
  | { type: 'start'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'grounding'; chunks?: GroundingChunk[]; urls?: string[] }
  | { type: 'tool_start'; tool: string; query?: string; url?: string; args?: any; error?: string }
  | { type: 'tool_done'; tool: string; count?: number; status?: number; fields?: number; ok?: boolean }
  | { type: 'needs_human'; reason?: string; suggestions?: string[] }
  | { type: 'result'; data: ChatAssistantPayload; model?: string; pipeline?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

interface UseChatStreamState {
  events: StreamEvent[];
  result: ChatAssistantPayload | null;
  isStreaming: boolean;
  error: string | null;
  thoughts: string;
  groundingUrls: GroundingChunk[];
  needsHuman: { reason?: string; suggestions?: string[] } | null;
  pipeline: string | null;
}

interface SendOptions {
  productId: string;
  message: string;
  attachments?: File[];
  scope?: string | null;
}

const INITIAL_STATE: UseChatStreamState = {
  events: [],
  result: null,
  isStreaming: false,
  error: null,
  thoughts: '',
  groundingUrls: [],
  needsHuman: null,
  pipeline: null,
};

/**
 * Hook for streaming chat responses via SSE from POST /api/chat?stream=true.
 *
 * Uses fetch() + response.body ReadableStream to read SSE events progressively.
 * This works with POST requests (unlike EventSource which only supports GET).
 *
 * Events emitted by the backend:
 *   { type: 'start' }
 *   { type: 'thinking', text }                 // Gemini Thought-Summary (V3)
 *   { type: 'grounding', chunks?, urls? }      // Web source grounding (V3)
 *   { type: 'tool_start', tool, query? }
 *   { type: 'tool_done', tool, count? }
 *   { type: 'needs_human', reason?, suggestions? }  // Low-confidence flag (V3)
 *   { type: 'result', data: ChatAssistantPayload, pipeline? }
 *   { type: 'done' }
 *   { type: 'error', message }
 */
export function useChatStream() {
  const [state, setState] = useState<UseChatStreamState>(INITIAL_STATE);

  // Used to cancel in-flight stream
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const send = useCallback(async ({ productId, message, attachments = [], scope }: SendOptions): Promise<ChatAssistantPayload | null> => {
    // Cancel any previous stream
    if (abortRef.current) {
      abortRef.current.abort();
    }

    // Wire a fresh AbortController for THIS stream so cancel()/a 2nd send()
    // can actually abort the in-flight fetch+reader.
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...INITIAL_STATE, isStreaming: true });

    let finalResult: ChatAssistantPayload | null = null;

    try {
      const response = await startChatStream(productId, message, attachments, scope, controller.signal);

      if (!response.ok || !response.body) {
        // Non-streaming error: try to parse body as JSON
        let errorMsg = `HTTP ${response.status}`;
        try {
          const errData = await response.json();
          errorMsg = errData?.error?.message || errorMsg;
        } catch {
          // ignore parse error
        }
        setState((prev) => ({ ...prev, isStreaming: false, error: errorMsg }));
        return null;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by \n\n
        const parts = buffer.split('\n\n');
        // Last part may be incomplete — keep it in buffer
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice('data: '.length);
          let event: StreamEvent;
          try {
            event = JSON.parse(jsonStr) as StreamEvent;
          } catch {
            continue;
          }

          if (event.type === 'result') {
            finalResult = event.data;
            const eventPipeline = (event as { pipeline?: string }).pipeline
              || (event.data && (event.data as ChatAssistantPayload).pipeline)
              || null;
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
              result: event.data,
              pipeline: eventPipeline ?? prev.pipeline,
              // Also surface needsHumanReview from the payload as a needsHuman flag if not already set
              needsHuman: prev.needsHuman || (event.data?.needsHumanReview
                ? {
                    reason: event.data.lowConfidenceFields?.length
                      ? `Folgende Felder benötigen Review: ${event.data.lowConfidenceFields.join(', ')}`
                      : undefined,
                  }
                : null),
            }));
          } else if (event.type === 'done') {
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
              isStreaming: false,
            }));
          } else if (event.type === 'error') {
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
              isStreaming: false,
              error: (event as { type: 'error'; message: string }).message,
            }));
          } else if (event.type === 'thinking') {
            const chunk = (event as { text?: string }).text || '';
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
              thoughts: prev.thoughts ? `${prev.thoughts}${chunk}` : chunk,
            }));
          } else if (event.type === 'grounding') {
            const chunks = Array.isArray(event.chunks) ? event.chunks : [];
            const urls = Array.isArray(event.urls) ? event.urls : [];
            // Normalize urls array into chunks if chunks missing
            const derivedFromUrls: GroundingChunk[] = urls
              .filter((u) => typeof u === 'string' && u)
              .map((u) => ({ uri: u }));
            const incoming: GroundingChunk[] = [...chunks, ...derivedFromUrls].filter(
              (c) => c && typeof c.uri === 'string' && c.uri
            );
            setState((prev) => {
              if (!incoming.length) {
                return { ...prev, events: [...prev.events, event] };
              }
              const seen = new Set(prev.groundingUrls.map((c) => c.uri));
              const deduped = [...prev.groundingUrls];
              for (const c of incoming) {
                if (!seen.has(c.uri)) {
                  seen.add(c.uri);
                  deduped.push(c);
                }
              }
              return {
                ...prev,
                events: [...prev.events, event],
                groundingUrls: deduped,
              };
            });
          } else if (event.type === 'needs_human') {
            const reason = (event as { reason?: string }).reason;
            const suggestions = Array.isArray((event as { suggestions?: string[] }).suggestions)
              ? (event as { suggestions?: string[] }).suggestions
              : undefined;
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
              needsHuman: { reason, suggestions },
            }));
          } else if (event.type === 'start' || event.type === 'tool_start' || event.type === 'tool_done') {
            // Progress events
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
            }));
          } else {
            // Unknown event type — ignore silently but do not crash
            // (future-proofing for additional backend events)
          }
        }
      }
      } finally {
        // Guarantee the spinner stops even on a mid-read network drop —
        // terminal done/error events are no longer the only off-switch.
        try {
          reader.releaseLock();
        } catch {
          // ignore — lock may already be released
        }
        setState((prev) => (prev.isStreaming ? { ...prev, isStreaming: false } : prev));
      }
    } catch (error: any) {
      const msg = error?.name === 'AbortError' ? null : (error?.message || 'Stream abgebrochen');
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        error: msg,
      }));
    } finally {
      // Only clear if this send() still owns the controller — a newer send()
      // may have already replaced it.
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }

    return finalResult;
  }, []);

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setState((prev) => ({ ...prev, isStreaming: false }));
  }, []);

  return {
    ...state,
    send,
    reset,
    cancel,
  };
}
