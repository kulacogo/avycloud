import { useEffect, useRef, useCallback } from "react";
import type { User } from "firebase/auth";
import {
  createSessionApi,
  heartbeatSession,
  endSessionApi,
  type SessionClientInfo,
} from "../api/client";

const HEARTBEAT_ACTIVE_MS = 60_000; // 60s when tab is visible
// MUSS unter STALE_THRESHOLD_MS in backend/services/user-sessions.js liegen
// (dort 3 min), sonst gilt jede verborgene Sitzung zwangslaeufig als tot und
// der Mensch verschwindet aus "Aktuell online", obwohl er angemeldet ist.
// 2 min laesst Luft fuer die Takt-Drosselung des Browsers in Hintergrund-Tabs.
const HEARTBEAT_HIDDEN_MS = 2 * 60_000; // 2 min when tab is hidden

/**
 * Collect all available client-side device/browser information.
 */
function getGpuInfo(): { renderer: string | null; vendor: string | null } {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!gl) return { renderer: null, vendor: null };
    const ext = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
    if (!ext) return { renderer: null, vendor: null };
    return {
      renderer: (gl as WebGLRenderingContext).getParameter(ext.UNMASKED_RENDERER_WEBGL) || null,
      vendor: (gl as WebGLRenderingContext).getParameter(ext.UNMASKED_VENDOR_WEBGL) || null,
    };
  } catch {
    return { renderer: null, vendor: null };
  }
}

async function collectClientInfoAsync(): Promise<Partial<SessionClientInfo>> {
  const extra: Partial<SessionClientInfo> = {};
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      extra.storageQuotaMb = est.quota ? Math.round(est.quota / 1024 / 1024) : null;
      extra.storageUsageMb = est.usage ? Math.round(est.usage / 1024 / 1024) : null;
    }
  } catch { /* ignore */ }
  try {
    if ((navigator as any).getBattery) {
      const bat = await (navigator as any).getBattery();
      extra.batteryLevel = bat.level ?? null;
      extra.batteryCharging = bat.charging ?? null;
    }
  } catch { /* ignore */ }
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      extra.mediaDeviceCounts = {
        audioinput: devices.filter(d => d.kind === "audioinput").length,
        videoinput: devices.filter(d => d.kind === "videoinput").length,
        audiooutput: devices.filter(d => d.kind === "audiooutput").length,
      };
    }
  } catch { /* ignore */ }
  return extra;
}

function collectClientInfo(): SessionClientInfo {
  const conn = (navigator as any).connection;
  const gpu = getGpuInfo();
  return {
    screenResolution: `${screen.width}x${screen.height}`,
    viewportSize: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: window.devicePixelRatio ?? 1,
    language: navigator.language || "",
    languages: Array.from(navigator.languages || []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    referrer: document.referrer || "",
    connectionType: conn?.effectiveType || null,
    connectionDownlink: conn?.downlink ?? null,
    connectionRtt: conn?.rtt ?? null,
    saveData: Boolean(conn?.saveData),
    isPwa: window.matchMedia("(display-mode: standalone)").matches,
    touchPoints: navigator.maxTouchPoints ?? 0,
    cookieEnabled: navigator.cookieEnabled !== false,
    doNotTrack: navigator.doNotTrack || null,
    hardwareConcurrency: (navigator as any).hardwareConcurrency ?? null,
    deviceMemory: (navigator as any).deviceMemory ?? null,
    platform: (navigator as any).platform || "",
    colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    pdfViewerEnabled: (navigator as any).pdfViewerEnabled !== false,
    screenColorDepth: screen.colorDepth ?? null,
    screenOrientation: screen.orientation?.type || null,
    gpuRenderer: gpu.renderer,
    gpuVendor: gpu.vendor,
    onLine: navigator.onLine,
    pointerType: window.matchMedia("(pointer: fine)").matches ? "fine"
      : window.matchMedia("(pointer: coarse)").matches ? "coarse" : "none",
    hoverCapable: window.matchMedia("(hover: hover)").matches,
    forcedColors: window.matchMedia("(forced-colors: active)").matches,
    prefersContrast: window.matchMedia("(prefers-contrast: more)").matches ? "more"
      : window.matchMedia("(prefers-contrast: less)").matches ? "less" : "no-preference",
    connectionPhysicalType: conn?.type || null,
  };
}

/**
 * Hook that tracks user sessions — creates a session on login,
 * sends periodic heartbeats, and ends the session on logout or tab close.
 *
 * Must be used inside AuthProvider (needs the current user).
 */
export function useSessionTracking(user: User | null) {
  const sessionIdRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevUserRef = useRef<string | null>(null);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(
    (intervalMs: number) => {
      clearHeartbeat();
      heartbeatTimerRef.current = setInterval(() => {
        const sid = sessionIdRef.current;
        if (sid) {
          heartbeatSession(sid).catch(() => {
            // Heartbeat failures are non-critical
          });
        }
      }, intervalMs);
    },
    [clearHeartbeat]
  );

  // Handle visibility changes — slow heartbeat when hidden
  useEffect(() => {
    const handleVisibility = () => {
      if (!sessionIdRef.current) return;
      if (document.visibilityState === "hidden") {
        startHeartbeat(HEARTBEAT_HIDDEN_MS);
      } else {
        // Tab became visible again — send immediate heartbeat + resume fast interval
        const sid = sessionIdRef.current;
        if (sid) heartbeatSession(sid).catch(() => {});
        startHeartbeat(HEARTBEAT_ACTIVE_MS);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [startHeartbeat]);

  // Handle beforeunload — best-effort session end
  useEffect(() => {
    const handleUnload = () => {
      const sid = sessionIdRef.current;
      if (sid) {
        // sendBeacon cannot set auth headers, so we use it as best-effort.
        // The stale-session cleanup will handle sessions that don't get properly closed.
        try {
          navigator.sendBeacon(
            `/api/sessions/${encodeURIComponent(sid)}/end`,
            ""
          );
        } catch {
          // Ignore — stale cleanup will handle it
        }
      }
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);

  // Create session when user logs in, end when user changes/logs out
  useEffect(() => {
    const currentUid = user?.uid ?? null;
    const prevUid = prevUserRef.current;

    // User logged out or changed
    if (prevUid && prevUid !== currentUid) {
      const sid = sessionIdRef.current;
      if (sid) {
        endSessionApi(sid).catch(() => {});
        sessionIdRef.current = null;
      }
      clearHeartbeat();
    }

    // User logged in (new session)
    if (currentUid && currentUid !== prevUid) {
      const clientInfo = collectClientInfo();
      // Collect async data (battery, storage, media devices) then create session
      collectClientInfoAsync().then((asyncData) => {
        const fullInfo = { ...clientInfo, ...asyncData };
        return createSessionApi(fullInfo);
      }).then((result) => {
          if (result.ok && result.sessionId) {
            sessionIdRef.current = result.sessionId;
            startHeartbeat(HEARTBEAT_ACTIVE_MS);
          }
        })
        .catch(() => {
          // Session creation failure is non-critical
        });
    }

    prevUserRef.current = currentUid;
  }, [user?.uid, clearHeartbeat, startHeartbeat]);

  /**
   * Call this before signing out to properly end the session.
   * Returns a promise that resolves when the session end request completes.
   */
  const endCurrentSession = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (sid) {
      clearHeartbeat();
      try {
        await endSessionApi(sid);
      } catch {
        // Non-critical
      }
      sessionIdRef.current = null;
    }
  }, [clearHeartbeat]);

  return { endCurrentSession };
}
