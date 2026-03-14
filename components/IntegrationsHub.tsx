import React, { useState, useEffect, useCallback, useMemo } from "react";
import { fetchIntegrationStatus, fetchIntegrationProviders } from "../api/client";
import type { IntegrationStatusEntry, IntegrationProvider } from "../api/client";
import IntegrationWizard from "./IntegrationWizard";

/* ─── Types ─── */
type Category = "all" | "marketplaces" | "shipping" | "finance" | "other";

const TABS: { key: Category; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "marketplaces", label: "Marktplätze" },
  { key: "shipping", label: "Versand" },
  { key: "finance", label: "Finanzen" },
  { key: "other", label: "Sonstiges" },
];

const LOGO_CONFIG: Record<string, { letter: string; color: string }> = {
  ebay: { letter: "eB", color: "bg-blue-600" },
  kaufland: { letter: "KL", color: "bg-red-600" },
  sendcloud: { letter: "SC", color: "bg-blue-500" },
  sevdesk: { letter: "SD", color: "bg-emerald-600" },
  dhl: { letter: "DHL", color: "bg-yellow-500" },
};

/* ─── Status Indicator ─── */
const StatusIndicator: React.FC<{ status: string; connectedAt?: string | null }> = ({ status, connectedAt }) => {
  if (status === "connected") {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-success" />
          <span className="text-xs font-medium text-success">Verbunden</span>
        </div>
        {connectedAt && (
          <span className="text-[11px] text-txt-muted ml-3.5">
            Seit {new Date(connectedAt).toLocaleDateString("de-DE")}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block w-2 h-2 rounded-full bg-txt-muted/40" />
      <span className="text-xs text-txt-muted">Nicht verbunden</span>
    </div>
  );
};

/* ─── Integration Card ─── */
interface IntegrationCardProps {
  integration: IntegrationStatusEntry;
  provider: IntegrationProvider | null;
  onConfigure: () => void;
}

const IntegrationCard: React.FC<IntegrationCardProps> = ({ integration, provider, onConfigure }) => {
  const logo = LOGO_CONFIG[integration.id] || { letter: integration.name.charAt(0), color: "bg-accent" };
  const isConnected = integration.status === "connected";
  const isConfigurable = provider?.authType === "oauth2" || provider?.authType === "api_key";
  const isDependency = provider?.authType === "none";

  return (
    <div
      className={`
        relative bg-app-surface rounded-xl border transition-all hover:shadow-md cursor-pointer group
        ${isConnected ? "border-success/30 border-t-2 border-t-success" : "border-app-border hover:border-accent/40"}
      `}
      onClick={onConfigure}
    >
      <div className="p-5">
        {/* Logo + Name + Description */}
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0 ${logo.color}`}
          >
            {logo.letter}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-txt-primary truncate">{integration.name}</h3>
            <p className="text-xs text-txt-muted mt-0.5 line-clamp-2">{integration.description}</p>
          </div>
          {/* Configure icon */}
          <svg
            className="w-4 h-4 text-txt-muted/0 group-hover:text-txt-muted transition-colors shrink-0 mt-0.5"
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </div>

        {/* Status */}
        <div className="mb-4">
          <StatusIndicator status={integration.status} connectedAt={integration.connectedAt} />
        </div>

        {/* Details for connected integrations */}
        {isConnected && integration.details && (
          <div className="mb-4 space-y-1">
            {integration.details.env && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-txt-muted">Umgebung:</span>
                <span className="text-txt-secondary font-medium uppercase">{integration.details.env}</span>
              </div>
            )}
            {integration.details.accessTokenExpiresAt && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-txt-muted">Token läuft ab:</span>
                <span className="text-txt-secondary font-medium">
                  {new Date(integration.details.accessTokenExpiresAt).toLocaleString("de-DE")}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Dependency note */}
        {isDependency && integration.dependsOn && (
          <div className="mb-4">
            <span className="text-[11px] text-txt-muted">via {integration.dependsOn}</span>
          </div>
        )}

        {/* Action */}
        <div className="flex items-center gap-2">
          {isConnected ? (
            <span className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-success-dim text-success text-center">
              Aktiv
            </span>
          ) : isConfigurable ? (
            <span className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent/10 text-accent text-center group-hover:bg-accent group-hover:text-white transition-colors">
              Verbinden
            </span>
          ) : (
            <span className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-app-elevated text-txt-muted text-center">
              Nicht konfiguriert
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

/* ─── Main Component ─── */
export const IntegrationsHub: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Category>("all");
  const [integrations, setIntegrations] = useState<IntegrationStatusEntry[]>([]);
  const [providers, setProviders] = useState<IntegrationProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardProvider, setWizardProvider] = useState<IntegrationProvider | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusData, providerData] = await Promise.all([
        fetchIntegrationStatus(),
        fetchIntegrationProviders().catch(() => []),
      ]);
      setIntegrations(statusData);
      setProviders(providerData);
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden der Integrationen");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const connectedCount = useMemo(
    () => integrations.filter((i) => i.status === "connected").length,
    [integrations]
  );

  const filtered = useMemo(
    () => activeTab === "all" ? integrations : integrations.filter((i) => i.category === activeTab),
    [integrations, activeTab]
  );

  const providerMap = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers]
  );

  const openWizard = useCallback((integrationId: string) => {
    const provider = providerMap.get(integrationId);
    if (provider) {
      setWizardProvider(provider);
    }
  }, [providerMap]);

  const closeWizard = useCallback(() => {
    setWizardProvider(null);
  }, []);

  const handleWizardSuccess = useCallback(() => {
    loadData();
  }, [loadData]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-full bg-app-bg p-6 space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-app-elevated rounded-lg" />
        <div className="h-10 w-full bg-app-elevated rounded-xl" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="bg-app-surface border border-app-border rounded-xl p-5 h-40" />
          ))}
        </div>
      </div>
    );
  }

  // Error state
  if (error && integrations.length === 0) {
    return (
      <div className="min-h-full bg-app-bg p-6">
        <div className="bg-danger-dim border border-app-border rounded-xl p-6 text-center">
          <p className="text-danger font-semibold mb-2">Fehler beim Laden der Integrationen</p>
          <p className="text-txt-secondary text-sm mb-4">{error}</p>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Erneut versuchen
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-app-bg">
      {/* Page Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-txt-primary">Integrationen</h1>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-success-dim text-success">
            {connectedCount} verbunden
          </span>
        </div>
        <p className="mt-1 text-sm text-txt-secondary">
          Verbinde Marktplätze, Versanddienstleister und Buchhaltungssoftware mit AvyCloud.
        </p>
      </div>

      {/* Tab Bar */}
      <div className="px-6 mb-6">
        <div className="flex items-center gap-1 p-1 bg-app-elevated rounded-xl overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`
                px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-all
                ${activeTab === tab.key
                  ? "bg-app-surface text-txt-primary shadow-sm"
                  : "text-txt-secondary hover:text-txt-primary hover:bg-app-surface/50"
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Integration Cards Grid */}
      <div className="px-6 pb-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              provider={providerMap.get(integration.id) || null}
              onConfigure={() => openWizard(integration.id)}
            />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="flex items-center justify-center py-16 text-txt-muted text-sm">
            Keine Integrationen in dieser Kategorie.
          </div>
        )}
      </div>

      {/* Integration Wizard Modal */}
      {wizardProvider && (
        <IntegrationWizard
          provider={wizardProvider}
          currentStatus={integrations.find((i) => i.id === wizardProvider.id) || null}
          onClose={closeWizard}
          onSuccess={handleWizardSuccess}
        />
      )}
    </div>
  );
};

export default IntegrationsHub;
