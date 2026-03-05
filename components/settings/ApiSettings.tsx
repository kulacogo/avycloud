import React, { useState } from "react";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { ProgressBar } from "../ui/ProgressBar";

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

interface ApiKey {
  id: string;
  name: string;
  key: string;
  created: string;
  lastAccess: string;
}

interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}

const initialKeys: ApiKey[] = [
  {
    id: "1",
    name: "Production Backend",
    key: "avyc_pk_8f3a2b1c9d4e5f6a7b8c9d0e1f2a3b4c",
    created: "12.01.2026",
    lastAccess: "05.03.2026",
  },
  {
    id: "2",
    name: "Staging Integration",
    key: "avyc_sk_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    created: "28.02.2026",
    lastAccess: "04.03.2026",
  },
];

const initialWebhooks: Webhook[] = [
  {
    id: "1",
    url: "https://hooks.muster-gmbh.de/avycloud/orders",
    events: ["order.created", "order.shipped"],
    active: true,
  },
];

const maskKey = (key: string): string => {
  return key.substring(0, 12) + "••••••••••••••••••••";
};

export const ApiSettings: React.FC = () => {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>(initialKeys);
  const [webhooks] = useState<Webhook[]>(initialWebhooks);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (key: string, id: string) => {
    // TODO: In production, fetch the full key from the API (GET /api/settings/api-keys/:id)
    await navigator.clipboard.writeText(key);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleRevoke = (id: string) => {
    // TODO: API call to revoke key (DELETE /api/settings/api-keys/:id)
    setApiKeys((prev) => prev.filter((k) => k.id !== id));
  };

  const handleCreateKey = () => {
    // TODO: API call to create new key (POST /api/settings/api-keys)
  };

  const handleAddWebhook = () => {
    // TODO: Open modal to add webhook (POST /api/settings/webhooks)
  };

  return (
    <div className="space-y-6">
      {/* API-Schlussel */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
            <KeyIcon />
            API-Schlussel
          </h3>
          <Button variant="primary" size="sm" iconLeft={<PlusIcon />} onClick={handleCreateKey}>
            Neuen API-Schlussel erstellen
          </Button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border">
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Name</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Schlussel</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted hidden sm:table-cell">Erstellt</th>
                <th className="text-left py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted hidden md:table-cell">Letzter Zugriff</th>
                <th className="text-right py-2.5 px-3 text-xs font-medium uppercase tracking-wide text-txt-muted">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((apiKey) => (
                <tr key={apiKey.id} className="border-b border-app-border/50 last:border-0">
                  <td className="py-3 px-3 text-txt-primary font-medium">{apiKey.name}</td>
                  <td className="py-3 px-3">
                    <code className="text-xs text-txt-secondary bg-app-elevated px-2 py-1 rounded-lg font-mono">
                      {maskKey(apiKey.key)}
                    </code>
                  </td>
                  <td className="py-3 px-3 text-txt-muted hidden sm:table-cell">{apiKey.created}</td>
                  <td className="py-3 px-3 text-txt-muted hidden md:table-cell">{apiKey.lastAccess}</td>
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
                        className="p-1.5 rounded-lg text-txt-muted hover:text-danger hover:bg-danger-dim transition-colors"
                        title="Widerrufen"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Webhooks */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-txt-primary">Webhooks</h3>
          <Button variant="primary" size="sm" iconLeft={<PlusIcon />} onClick={handleAddWebhook}>
            Webhook hinzufugen
          </Button>
        </div>

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
              {webhooks.map((webhook) => (
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
                        className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
                        title="Bearbeiten"
                      >
                        {/* TODO: Open edit webhook modal */}
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="p-1.5 rounded-lg text-txt-muted hover:text-danger hover:bg-danger-dim transition-colors"
                        title="Loschen"
                      >
                        {/* TODO: API call to delete webhook (DELETE /api/settings/webhooks/:id) */}
                        <TrashIcon />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
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
              API-Dokumentation offnen
            </h3>
            <p className="text-xs text-txt-muted mt-1">
              Vollstandige Referenz aller Endpunkte, Authentifizierung und Beispiele
            </p>
          </div>
          <ExternalLinkIcon />
        </a>
      </Card>
    </div>
  );
};

export default ApiSettings;
