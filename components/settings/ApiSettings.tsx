import React, { useState, useEffect, useCallback } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { ProgressBar } from "../ui/ProgressBar";
import {
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
  fetchWebhooks,
  createWebhook,
  deleteWebhook,
} from "../../api/client";
import type { ApiKeyData, WebhookData } from "../../api/client";

const CopyIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
  </svg>
);

const KeyIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 010-7.778zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
  </svg>
);

const ExternalLinkIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const TrashIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
  </svg>
);

const PlusIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

function maskKey(key: string): string {
  return key.substring(0, 12) + "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
}

function SkeletonRow({ cols }: { cols: number }): React.ReactElement {
  return (
    <tr className="border-b border-app-border/50 last:border-0">
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className="py-3 px-3">
          <div className="h-4 bg-app-elevated rounded-lg animate-pulse w-24" />
        </td>
      ))}
    </tr>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }): React.ReactElement {
  return (
    <div className="flex items-center justify-between p-3 rounded-xl bg-danger-dim text-danger text-sm">
      <span>{message}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Erneut versuchen
      </Button>
    </div>
  );
}

export const ApiSettings: React.FC = () => {
  const [apiKeys, setApiKeys] = useState<ApiKeyData[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookData[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [loadingWebhooks, setLoadingWebhooks] = useState(true);
  const [errorKeys, setErrorKeys] = useState<string | null>(null);
  const [errorWebhooks, setErrorWebhooks] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoadingKeys(true);
    setErrorKeys(null);
    try {
      const keys = await fetchApiKeys();
      setApiKeys(keys);
    } catch (err) {
      setErrorKeys(err instanceof Error ? err.message : "API-Schlüssel konnten nicht geladen werden");
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  const loadWebhooks = useCallback(async () => {
    setLoadingWebhooks(true);
    setErrorWebhooks(null);
    try {
      const hooks = await fetchWebhooks();
      setWebhooks(hooks);
    } catch (err) {
      setErrorWebhooks(err instanceof Error ? err.message : "Webhooks konnten nicht geladen werden");
    } finally {
      setLoadingWebhooks(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
    loadWebhooks();
  }, [loadKeys, loadWebhooks]);

  const handleCopy = async (key: string, id: string) => {
    await navigator.clipboard.writeText(key);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleRevoke = async (id: string) => {
    const confirmed = window.confirm("Möchten Sie diesen API-Schlüssel wirklich widerrufen? Diese Aktion kann nicht rückgängig gemacht werden.");
    if (!confirmed) return;

    setActionLoading(id);
    try {
      await revokeApiKey(id);
      await loadKeys();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Fehler beim Widerrufen des Schlüssels");
    } finally {
      setActionLoading(null);
    }
  };

  const handleCreateKey = async () => {
    const name = window.prompt("Name für den neuen API-Schlüssel:");
    if (!name?.trim()) return;

    setActionLoading("create-key");
    try {
      await createApiKey(name.trim());
      await loadKeys();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Fehler beim Erstellen des Schlüssels");
    } finally {
      setActionLoading(null);
    }
  };

  const handleAddWebhook = async () => {
    const url = window.prompt("Webhook-URL:");
    if (!url?.trim()) return;

    setActionLoading("create-webhook");
    try {
      await createWebhook({ url: url.trim(), events: ["order.created", "order.shipped"] });
      await loadWebhooks();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Fehler beim Erstellen des Webhooks");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    const confirmed = window.confirm("Möchten Sie diesen Webhook wirklich löschen?");
    if (!confirmed) return;

    setActionLoading(id);
    try {
      await deleteWebhook(id);
      await loadWebhooks();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Fehler beim Löschen des Webhooks");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* API-Schlüssel */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
            <KeyIcon />
            API-Schlüssel
          </h3>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<PlusIcon />}
            onClick={handleCreateKey}
            disabled={actionLoading === "create-key"}
          >
            {actionLoading === "create-key" ? "Wird erstellt..." : "Neuen API-Schlüssel erstellen"}
          </Button>
        </div>

        {errorKeys && <ErrorBanner message={errorKeys} onRetry={loadKeys} />}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border">
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Name</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Schlüssel</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted hidden sm:table-cell">Erstellt</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted hidden md:table-cell">Letzter Zugriff</th>
                <th className="text-right py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {loadingKeys ? (
                <>
                  <SkeletonRow cols={5} />
                  <SkeletonRow cols={5} />
                </>
              ) : apiKeys.length === 0 && !errorKeys ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-txt-muted">
                    Keine API-Schlüssel vorhanden
                  </td>
                </tr>
              ) : (
                apiKeys.map((apiKey) => (
                  <tr key={apiKey.id} className="border-b border-app-border/50 last:border-0">
                    <td className="py-3 px-3 text-txt-primary font-medium">{apiKey.name}</td>
                    <td className="py-3 px-3">
                      <code className="text-xs text-txt-secondary bg-app-elevated px-2 py-1 rounded-lg font-mono">
                        {maskKey(apiKey.key)}
                      </code>
                    </td>
                    <td className="py-3 px-3 text-txt-muted hidden sm:table-cell">{apiKey.createdAt ?? "–"}</td>
                    <td className="py-3 px-3 text-txt-muted hidden md:table-cell">{apiKey.lastAccess ?? "–"}</td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleCopy(apiKey.key, apiKey.id)}
                          className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
                          title="Kopieren"
                        >
                          {copiedId === apiKey.id ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-success">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          ) : (
                            <CopyIcon />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRevoke(apiKey.id)}
                          disabled={actionLoading === apiKey.id}
                          className="p-1.5 rounded-lg text-txt-muted hover:text-danger hover:bg-danger-dim transition-colors disabled:opacity-50"
                          title="Widerrufen"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Webhooks */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-txt-primary">Webhooks</h3>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<PlusIcon />}
            onClick={handleAddWebhook}
            disabled={actionLoading === "create-webhook"}
          >
            {actionLoading === "create-webhook" ? "Wird erstellt..." : "Webhook hinzufügen"}
          </Button>
        </div>

        {errorWebhooks && <ErrorBanner message={errorWebhooks} onRetry={loadWebhooks} />}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border">
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">URL</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Events</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Status</th>
                <th className="text-right py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {loadingWebhooks ? (
                <SkeletonRow cols={4} />
              ) : webhooks.length === 0 && !errorWebhooks ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-sm text-txt-muted">
                    Keine Webhooks konfiguriert
                  </td>
                </tr>
              ) : (
                webhooks.map((webhook) => (
                  <tr key={webhook.id} className="border-b border-app-border/50 last:border-0">
                    <td className="py-3 px-3">
                      <code className="text-xs text-txt-secondary font-mono">{webhook.url}</code>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex flex-wrap gap-1">
                        {webhook.events.map((event) => (
                          <Badge key={event} variant="accent" size="sm">{event}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <Badge variant={webhook.active ? "success" : "neutral"} dot size="sm">
                        {webhook.active ? "Aktiv" : "Inaktiv"}
                      </Badge>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleDeleteWebhook(webhook.id)}
                          disabled={actionLoading === webhook.id}
                          className="p-1.5 rounded-lg text-txt-muted hover:text-danger hover:bg-danger-dim transition-colors disabled:opacity-50"
                          title="Löschen"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* API-Nutzung */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">API-Nutzung</h3>
        <div className="space-y-5">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-txt-secondary">Requests heute</span>
              <span className="text-sm font-medium text-txt-primary">1.247 / 10.000</span>
            </div>
            <ProgressBar value={12.47} variant="accent" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-txt-secondary">Requests diesen Monat</span>
              <span className="text-sm font-medium text-txt-primary">28.432 / 100.000</span>
            </div>
            <ProgressBar value={28.43} variant="accent" />
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-app-border">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-txt-muted shrink-0">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span className="text-xs text-txt-muted">Rate Limit: 120 Requests/Minute</span>
          </div>
        </div>
      </Card>

      {/* Dokumentation */}
      <Card>
        <a
          href="/api/docs"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between group"
        >
          <div>
            <h3 className="text-sm font-semibold text-txt-primary group-hover:text-accent transition-colors">
              API-Dokumentation öffnen
            </h3>
            <p className="text-xs text-txt-muted mt-1">
              Vollständige Referenz aller Endpunkte, Authentifizierung und Beispiele
            </p>
          </div>
          <ExternalLinkIcon />
        </a>
      </Card>
    </div>
  );
};

export default ApiSettings;
