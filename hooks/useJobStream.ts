import { useEffect, useRef, useState, useCallback } from "react";
import { IdentificationJob } from "../types";
import { getBackendUrl, fetchJobStatus } from "../api/client";

/** How often to poll as a fallback when SSE is unavailable (ms). */
const POLL_INTERVAL_MS = 3000;
/** Max time to wait for a job before giving up (ms). */
const JOB_STREAM_TIMEOUT_MS = 5 * 60 * 1000;

type JobStreamStatus = "idle" | "connecting" | "streaming" | "polling" | "done" | "error";

interface UseJobStreamOptions {
  /** Firebase ID token to authenticate the SSE connection. */
  token: string | null;
  /** Called whenever the job data updates (from SSE or poll). */
  onUpdate?: (job: IdentificationJob) => void;
  /** Called when the job reaches a terminal state (done/failed). */
  onComplete?: (job: IdentificationJob) => void;
  /** Override default poll interval (ms). */
  pollIntervalMs?: number;
  /** Override default timeout (ms). */
  timeoutMs?: number;
}

/**
 * Streams real-time updates for a single identification job via SSE.
 * Automatically falls back to polling if SSE connection fails.
 *
 * Usage:
 * ```tsx
 * const { job, status } = useJobStream(jobId, { token });
 * ```
 */
export const useJobStream = (jobId: string | null, options: UseJobStreamOptions) => {
  const { token, onUpdate, onComplete, pollIntervalMs = POLL_INTERVAL_MS, timeoutMs = JOB_STREAM_TIMEOUT_MS } = options;
  const [job, setJob] = useState<IdentificationJob | null>(null);
  const [status, setStatus] = useState<JobStreamStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdate);
  const onCompleteRef = useRef(onComplete);

  // Keep callback refs fresh without retriggering effect.
  onUpdateRef.current = onUpdate;
  onCompleteRef.current = onComplete;

  const cleanup = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const handleJobData = useCallback(
    (data: IdentificationJob) => {
      setJob(data);
      onUpdateRef.current?.(data);

      if (data.status === "done" || data.status === "failed") {
        setStatus("done");
        onCompleteRef.current?.(data);
        cleanup();
      }
    },
    [cleanup]
  );

  // Start polling as fallback.
  const startPolling = useCallback(() => {
    if (!jobId || !token) return;
    setStatus("polling");

    const poll = async () => {
      try {
        const data = await fetchJobStatus(jobId);
        if (data) {
          handleJobData(data as IdentificationJob);
        }
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          console.warn("[useJobStream] poll error:", err?.message || err);
        }
      }
    };

    // Immediate first poll.
    poll();
    pollTimerRef.current = setInterval(poll, pollIntervalMs);
  }, [jobId, token, pollIntervalMs, handleJobData]);

  useEffect(() => {
    if (!jobId || !token) {
      setStatus("idle");
      setJob(null);
      setError(null);
      return;
    }

    cleanup();
    setStatus("connecting");
    setError(null);

    // Global timeout — stop waiting after timeoutMs.
    timeoutRef.current = setTimeout(() => {
      cleanup();
      setStatus("error");
      setError("Job stream timed out.");
    }, timeoutMs);

    // Try SSE first (fetch-based to avoid token in URL query param).
    const controller = new AbortController();
    abortControllerRef.current = controller;

    (async () => {
      try {
        const backendUrl = getBackendUrl();
        const sseUrl = `${backendUrl}/api/jobs/${encodeURIComponent(jobId)}/stream`;
        const response = await fetch(sseUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`SSE connect failed: ${response.status}`);
        if (!response.body) throw new Error("No response body");

        setStatus("streaming");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split("\n\n");
          buffer = messages.pop() ?? "";

          for (const message of messages) {
            if (!message.trim()) continue;

            let data = "";
            for (const line of message.split("\n")) {
              if (line.startsWith("data: ")) {
                data = line.slice(6);
              }
            }
            if (!data) continue;

            try {
              const parsed = JSON.parse(data) as IdentificationJob;
              handleJobData(parsed);
            } catch {
              // Ignore malformed messages.
            }
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        // SSE failed — fall back to polling.
        startPolling();
      }
    })();

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, token]);

  return { job, status, error };
};
