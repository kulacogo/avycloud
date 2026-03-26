import { useCallback, useRef, useState } from 'react';
import { startChatStream, ChatAssistantPayload } from '../api/client';

export type StreamEventType =
  | 'start'
  | 'tool_start'
  | 'tool_done'
  | 'result'
  | 'done'
  | 'error';

export type StreamEvent =
  | { type: 'start'; text: string }
  | { type: 'tool_start'; tool: string; query?: string; url?: string; error?: string }
  | { type: 'tool_done'; tool: string; count?: number; status?: number; fields?: number }
  | { type: 'result'; data: ChatAssistantPayload; model?: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

interface UseChatStreamState {
  events: StreamEvent[];
  result: ChatAssistantPayload | null;
  isStreaming: boolean;
  error: string | null;
}

interface SendOptions {
  productId: string;
  message: string;
  attachments?: File[];
  scope?: string | null;
}

/**
 * Hook for streaming chat responses via SSE from POST /api/chat?stream=true.
 *
 * Uses fetch() + response.body ReadableStream to read SSE events progressively.
 * This works with POST requests (unlike EventSource which only supports GET).
 *
 * Events emitted by the backend:
 *   { type: 'start' }
 *   { type: 'tool_start', tool, query? }
 *   { type: 'tool_done', tool, count? }
 *   { type: 'result', data: ChatAssistantPayload }
 *   { type: 'done' }
 *   { type: 'error', message }
 */
export function useChatStream() {
  const [state, setState] = useState<UseChatStreamState>({
    events: [],
    result: null,
    isStreaming: false,
    error: null,
  });

  // Used to cancel in-flight stream
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    setState({ events: [], result: null, isStreaming: false, error: null });
  }, []);

  const send = useCallback(async ({ productId, message, attachments = [], scope }: SendOptions): Promise<ChatAssistantPayload | null> => {
    // Cancel any previous stream
    if (abortRef.current) {
      abortRef.current.abort();
    }

    setState({ events: [], result: null, isStreaming: true, error: null });

    let finalResult: ChatAssistantPayload | null = null;

    try {
      const response = await startChatStream(productId, message, attachments, scope);

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
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
              result: event.data,
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
          } else {
            // Progress events (start, tool_start, tool_done)
            setState((prev) => ({
              ...prev,
              events: [...prev.events, event],
            }));
          }
        }
      }

    } catch (error: any) {
      const msg = error?.name === 'AbortError' ? null : (error?.message || 'Stream abgebrochen');
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        error: msg,
      }));
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
