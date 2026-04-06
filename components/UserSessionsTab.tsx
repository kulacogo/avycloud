import React, { useState, useEffect, useCallback } from "react";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { useToast } from "../context/ToastContext";
import {
  fetchSessions,
  fetchActiveSessions,
  type UserSession,
} from "../api/client";

// --- Helpers ---

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min} Min.`;
  const hrs = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hrs} Std. ${remainMin} Min.`;
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeAgo(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Gerade eben";
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  if (diffMin < 1440) return `vor ${Math.floor(diffMin / 60)} Std.`;
  return formatTimestamp(ts);
}

function getDeviceIcon(type: string): string {
  switch (type) {
    case "mobile":
      return "📱";
    case "tablet":
      return "📱";
    default:
      return "💻";
  }
}

function getStatusBadge(status: string) {
  switch (status) {
    case "active":
      return <Badge variant="success" size="sm">Online</Badge>;
    case "idle":
      return <Badge variant="warning" size="sm">Idle</Badge>;
    default:
      return <Badge variant="neutral" size="sm">Offline</Badge>;
  }
}

function getInitial(email: string): string {
  return (email || "?")[0].toUpperCase();
}

function getLocationString(geo: UserSession["geo"]): string {
  if (!geo) return "—";
  const parts = [geo.city, geo.region, geo.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "—";
}

// --- Types ---

interface GroupedUser {
  userId: string;
  userEmail: string;
  sessions: UserSession[];
  latestSession: UserSession;
  isOnline: boolean;
}

// --- Component ---

const UserSessionsTab: React.FC = () => {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [activeSessions, setActiveSessions] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const { addToast } = useToast();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sessionsResult, activeResult] = await Promise.all([
        fetchSessions({ limit: 200 }),
        fetchActiveSessions(),
      ]);

      if (sessionsResult.ok && sessionsResult.data) {
        setSessions(sessionsResult.data);
        setHasMore(sessionsResult.data.length === 200);
      }
      if (activeResult.ok && activeResult.data) {
        setActiveSessions(activeResult.data);
      }
    } catch (err: any) {
      addToast("error", `Fehler: ${err?.message || "Sessions konnten nicht geladen werden."}`);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh active sessions every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const result = await fetchActiveSessions();
        if (result.ok && result.data) {
          setActiveSessions(result.data);
        }
      } catch {
        // Silent refresh failure
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const loadMore = async () => {
    const last = sessions[sessions.length - 1];
    if (!last?.loginAt) return;
    try {
      const result = await fetchSessions({ limit: 200, startAfter: last.loginAt });
      if (result.ok && result.data) {
        setSessions((prev) => [...prev, ...result.data!]);
        setHasMore(result.data.length === 200);
      }
    } catch (err: any) {
      addToast("error", `Fehler: ${err?.message || "Laden fehlgeschlagen."}`);
    }
  };

  // Group sessions by user
  const groupedUsers: GroupedUser[] = React.useMemo(() => {
    const map = new Map<string, UserSession[]>();
    for (const s of sessions) {
      const key = s.userId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }

    const activeUserIds = new Set(activeSessions.map((s) => s.userId));

    return Array.from(map.entries())
      .map(([userId, userSessions]) => ({
        userId,
        userEmail: userSessions[0].userEmail,
        sessions: userSessions,
        latestSession: userSessions[0],
        isOnline: activeUserIds.has(userId),
      }))
      .sort((a, b) => {
        // Online users first, then by latest session
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        return new Date(b.latestSession.loginAt).getTime() - new Date(a.latestSession.loginAt).getTime();
      });
  }, [sessions, activeSessions]);

  return (
    <div className="space-y-6">
      {/* Active Users */}
      <div>
        <h3 className="text-sm font-semibold text-txt-secondary mb-3">
          Aktuell online ({activeSessions.length})
        </h3>
        {activeSessions.length === 0 ? (
          <div className="text-sm text-txt-muted">Keine Benutzer online.</div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {activeSessions.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-app-elevated border border-app-border"
              >
                <div className="relative">
                  <div className="w-8 h-8 rounded-full bg-accent-dim text-accent flex items-center justify-center text-sm font-bold">
                    {getInitial(s.userEmail)}
                  </div>
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-success border-2 border-app-elevated" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-txt-primary truncate max-w-[140px]">
                    {s.userEmail.split("@")[0]}
                  </div>
                  <div className="text-[10px] text-txt-muted">
                    {s.browser.name} · {s.os.name} · {getLocationString(s.geo)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-txt-secondary">
          Session-Verlauf ({sessions.length} Sessions, {groupedUsers.length} Benutzer)
        </h3>
        <Button variant="secondary" size="sm" onClick={loadData} loading={loading}>
          Aktualisieren
        </Button>
      </div>

      {/* Loading */}
      {loading && sessions.length === 0 && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-app-elevated animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && groupedUsers.length === 0 && (
        <Card padding="lg" className="text-center">
          <p className="text-txt-muted py-6">
            Noch keine Sessions protokolliert.
          </p>
        </Card>
      )}

      {/* User cards */}
      {groupedUsers.length > 0 && (
        <div className="space-y-2">
          {groupedUsers.map((gu) => {
            const isExpanded = expandedUser === gu.userId;
            const latest = gu.latestSession;

            return (
              <Card key={gu.userId} padding="none">
                {/* User header */}
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-app-elevated/50 transition-colors text-left"
                  onClick={() => setExpandedUser(isExpanded ? null : gu.userId)}
                >
                  {/* Avatar */}
                  <div className="relative shrink-0">
                    <div className="w-10 h-10 rounded-full bg-accent-dim text-accent flex items-center justify-center text-base font-bold">
                      {getInitial(gu.userEmail)}
                    </div>
                    {gu.isOnline && (
                      <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-success border-2 border-app-surface" />
                    )}
                  </div>

                  {/* User info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-txt-primary truncate">
                        {gu.userEmail}
                      </span>
                      {gu.isOnline ? (
                        <Badge variant="success" size="sm">Online</Badge>
                      ) : (
                        <span className="text-xs text-txt-muted">
                          Zuletzt: {timeAgo(latest.lastActiveAt)}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-txt-muted mt-0.5">
                      {gu.sessions.length} Sessions ·
                      Letztes Gerät: {latest.browser.name} {latest.browser.version?.split(".")[0]} / {latest.os.name} ·
                      {getLocationString(latest.geo)}
                    </div>
                  </div>

                  {/* Expand indicator */}
                  <span className={`text-txt-muted transition-transform ${isExpanded ? "rotate-180" : ""}`}>
                    ▾
                  </span>
                </button>

                {/* Expanded session list */}
                {isExpanded && (
                  <div className="border-t border-app-border">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-txt-muted border-b border-app-border">
                            <th className="px-4 py-2 text-left font-medium">Login</th>
                            <th className="px-4 py-2 text-left font-medium">Logout</th>
                            <th className="px-4 py-2 text-left font-medium">Dauer</th>
                            <th className="px-4 py-2 text-left font-medium">Status</th>
                            <th className="px-4 py-2 text-left font-medium">Gerät</th>
                            <th className="px-4 py-2 text-left font-medium">Browser / OS</th>
                            <th className="px-4 py-2 text-left font-medium">Standort</th>
                            <th className="px-4 py-2 text-left font-medium">IP</th>
                            <th className="px-4 py-2 text-left font-medium">Details</th>
                          </tr>
                        </thead>
                        <tbody>
                          {gu.sessions.map((s) => {
                            const isDetailExpanded = expandedSession === s.id;
                            return (
                              <React.Fragment key={s.id}>
                                <tr className="border-b border-app-border/50 hover:bg-app-elevated/30 transition-colors">
                                  <td className="px-4 py-2 text-txt-primary whitespace-nowrap">
                                    {formatTimestamp(s.loginAt)}
                                  </td>
                                  <td className="px-4 py-2 text-txt-secondary whitespace-nowrap">
                                    {formatTimestamp(s.logoutAt)}
                                  </td>
                                  <td className="px-4 py-2 text-txt-secondary whitespace-nowrap">
                                    {formatDuration(s.durationSeconds)}
                                  </td>
                                  <td className="px-4 py-2">{getStatusBadge(s.status)}</td>
                                  <td className="px-4 py-2 whitespace-nowrap">
                                    <span title={`${s.device.vendor} ${s.device.model}`.trim()}>
                                      {getDeviceIcon(s.device.type)}{" "}
                                      <span className="text-txt-secondary capitalize">{s.device.type}</span>
                                    </span>
                                  </td>
                                  <td className="px-4 py-2 text-txt-secondary whitespace-nowrap">
                                    {s.browser.name} {s.browser.version?.split(".")[0]} / {s.os.name} {s.os.version}
                                  </td>
                                  <td className="px-4 py-2 text-txt-secondary whitespace-nowrap">
                                    {getLocationString(s.geo)}
                                  </td>
                                  <td className="px-4 py-2 text-txt-muted font-mono whitespace-nowrap">
                                    {s.ip || "—"}
                                  </td>
                                  <td className="px-4 py-2">
                                    <button
                                      type="button"
                                      className="text-accent hover:underline"
                                      onClick={() => setExpandedSession(isDetailExpanded ? null : s.id)}
                                    >
                                      {isDetailExpanded ? "Weniger" : "Mehr"}
                                    </button>
                                  </td>
                                </tr>

                                {/* Expanded detail row */}
                                {isDetailExpanded && (
                                  <tr>
                                    <td colSpan={9} className="px-4 py-3 bg-app-elevated/50">
                                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-2 text-xs">
                                        <DetailItem label="Auth Provider" value={s.authProvider} />
                                        <DetailItem label="Bildschirm" value={s.client.screenResolution} />
                                        <DetailItem label="Viewport" value={s.client.viewportSize} />
                                        <DetailItem label="Pixel Ratio" value={s.client.devicePixelRatio?.toString() || "—"} />
                                        <DetailItem label="Sprache" value={s.client.language} />
                                        <DetailItem label="Alle Sprachen" value={s.client.languages?.join(", ") || "—"} />
                                        <DetailItem label="Zeitzone" value={s.client.timezone} />
                                        <DetailItem label="Verbindung" value={s.client.connectionType || "—"} />
                                        <DetailItem label="Bandbreite" value={s.client.connectionDownlink != null ? `${s.client.connectionDownlink} Mbps` : "—"} />
                                        <DetailItem label="Latenz" value={s.client.connectionRtt != null ? `${s.client.connectionRtt}ms` : "—"} />
                                        <DetailItem label="Datensparmodus" value={s.client.saveData ? "Ja" : "Nein"} />
                                        <DetailItem label="PWA" value={s.client.isPwa ? "Ja" : "Nein"} />
                                        <DetailItem label="Touch-Punkte" value={String(s.client.touchPoints ?? 0)} />
                                        <DetailItem label="Cookies" value={s.client.cookieEnabled ? "Ja" : "Nein"} />
                                        <DetailItem label="Do-Not-Track" value={s.client.doNotTrack || "—"} />
                                        <DetailItem label="CPU-Kerne" value={s.client.hardwareConcurrency?.toString() || "—"} />
                                        <DetailItem label="RAM" value={s.client.deviceMemory != null ? `${s.client.deviceMemory} GB` : "—"} />
                                        <DetailItem label="Platform" value={s.client.platform || "—"} />
                                        <DetailItem label="Farbschema" value={s.client.colorScheme === "dark" ? "Dunkel" : "Hell"} />
                                        <DetailItem label="Reduzierte Bewegung" value={s.client.reducedMotion ? "Ja" : "Nein"} />
                                        <DetailItem label="PDF Viewer" value={s.client.pdfViewerEnabled ? "Ja" : "Nein"} />
                                        <DetailItem label="Referrer" value={s.client.referrer || "—"} />
                                        <DetailItem label="Farbtiefe" value={s.client.screenColorDepth != null ? `${s.client.screenColorDepth} Bit` : "—"} />
                                        <DetailItem label="Orientierung" value={s.client.screenOrientation || "—"} />
                                        <DetailItem label="GPU" value={s.client.gpuRenderer || "—"} />
                                        <DetailItem label="GPU Vendor" value={s.client.gpuVendor || "—"} />
                                        <DetailItem label="Online" value={s.client.onLine != null ? (s.client.onLine ? "Ja" : "Nein") : "—"} />
                                        <DetailItem label="Speicher (Quota)" value={s.client.storageQuotaMb != null ? `${s.client.storageQuotaMb.toLocaleString("de-DE")} MB` : "—"} />
                                        <DetailItem label="Speicher (Belegt)" value={s.client.storageUsageMb != null ? `${s.client.storageUsageMb.toLocaleString("de-DE")} MB` : "—"} />
                                        <DetailItem label="Akku" value={s.client.batteryLevel != null ? `${Math.round(s.client.batteryLevel * 100)}%${s.client.batteryCharging ? " ⚡" : ""}` : "—"} />
                                        <DetailItem label="Mediengeräte" value={s.client.mediaDeviceCounts ? `🎤${s.client.mediaDeviceCounts.audioinput} 📷${s.client.mediaDeviceCounts.videoinput} 🔊${s.client.mediaDeviceCounts.audiooutput}` : "—"} />
                                        <DetailItem label="Pointer" value={s.client.pointerType || "—"} />
                                        <DetailItem label="Hover" value={s.client.hoverCapable != null ? (s.client.hoverCapable ? "Ja" : "Nein") : "—"} />
                                        <DetailItem label="Forced Colors" value={s.client.forcedColors ? "Ja" : "Nein"} />
                                        <DetailItem label="Kontrast" value={s.client.prefersContrast || "—"} />
                                        <DetailItem label="Netzwerk (physisch)" value={s.client.connectionPhysicalType || "—"} />
                                        {s.geo?.lat != null && s.geo?.lon != null && (
                                          <DetailItem label="Koordinaten" value={`${s.geo.lat.toFixed(2)}, ${s.geo.lon.toFixed(2)}`} />
                                        )}
                                        <DetailItem label="User-Agent" value={s.userAgent} fullWidth />
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="secondary" size="sm" onClick={loadMore}>
            Weitere laden
          </Button>
        </div>
      )}
    </div>
  );
};

// --- Detail Item ---

const DetailItem: React.FC<{ label: string; value: string; fullWidth?: boolean }> = ({
  label,
  value,
  fullWidth,
}) => (
  <div className={fullWidth ? "col-span-full" : ""}>
    <span className="text-txt-muted">{label}:</span>{" "}
    <span className={`text-txt-secondary ${fullWidth ? "break-all" : ""}`}>{value || "—"}</span>
  </div>
);

export default UserSessionsTab;
