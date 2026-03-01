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
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdate);
  const onCompleteRef = useRef(onComplete);

  // Keep callback refs fresh without retriggering effect.
  onUpdateRef.current = onUpdate;
  onCompleteRef.current = onComplete;

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
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

    // Try SSE first.
    try {
      const backendUrl = getBackendUrl();
      const sseUrl = `${backendUrl}/api/jobs/${encodeURIComponent(jobId)}/stream?token=${encodeURIComponent(token)}`;
      const es = new EventSource(sseUrl);
      eventSourceRef.current = es;

      es.onopen = () => {
        setStatus("streaming");
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as IdentificationJob;
          handleJobData(data);
        } catch {
          // Ignore malformed messages.
        }
      };

      es.onerror = () => {
        // SSE failed — close and fall back to polling.
        es.close();
        eventSourceRef.current = null;
        startPolling();
      };
    } catch {
      // EventSource constructor failed — fall back to polling.
      startPolling();
    }

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, token]);

  return { job, status, error };
};
