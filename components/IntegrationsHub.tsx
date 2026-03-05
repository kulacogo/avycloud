import React, { useState, useCallback, useMemo } from "react";

/* ─── Types ─── */
type IntegrationStatus = "connected" | "not_connected" | "coming_soon";
type Category = "marketplaces" | "shipping" | "finance" | "shops" | "other";

interface Integration {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  category: Category;
  lastSync?: string;
  logoLetter?: string;
  logoColor?: string;
}

/* ─── Tab config ─── */
const TABS: { key: Category; label: string }[] = [
  { key: "marketplaces", label: "Marktpl\u00e4tze" },
  { key: "shipping", label: "Versand" },
  { key: "finance", label: "Finanzen & Steuern" },
  { key: "shops", label: "Shops" },
  { key: "other", label: "Sonstiges" },
];

/* ─── Integration data ─── */
const INTEGRATIONS: Integration[] = [
  // Marktpl\u00e4tze
  { id: "ebay", name: "eBay", description: "Online-Marktplatz f\u00fcr Auktionen und Sofortkauf", status: "connected", category: "marketplaces", lastSync: "vor 3 Minuten", logoLetter: "E", logoColor: "bg-blue-600" },
  { id: "kaufland", name: "Kaufland", description: "Deutscher Online-Marktplatz", status: "connected", category: "marketplaces", lastSync: "vor 8 Minuten", logoLetter: "K", logoColor: "bg-red-600" },
  { id: "amazon", name: "Amazon", description: "Weltgr\u00f6\u00dfter Online-Marktplatz", status: "coming_soon", category: "marketplaces", logoLetter: "A", logoColor: "bg-amber-600" },
  { id: "otto", name: "Otto Market", description: "Deutscher Premium-Marktplatz", status: "coming_soon", category: "marketplaces", logoLetter: "O", logoColor: "bg-orange-600" },
  { id: "zalando", name: "Zalando", description: "Fashion- und Lifestyle-Marktplatz", status: "coming_soon", category: "marketplaces", logoLetter: "Z", logoColor: "bg-orange-500" },
  { id: "kleinanzeigen", name: "Kleinanzeigen", description: "Lokaler Anzeigenmarkt", status: "coming_soon", category: "marketplaces", logoLetter: "K", logoColor: "bg-green-600" },
  { id: "hood", name: "Hood.de", description: "Deutscher Online-Marktplatz", status: "coming_soon", category: "marketplaces", logoLetter: "H", logoColor: "bg-indigo-600" },
  { id: "avocadostore", name: "Avocadostore", description: "Nachhaltiger Online-Marktplatz", status: "coming_soon", category: "marketplaces", logoLetter: "A", logoColor: "bg-green-500" },
  { id: "etsy", name: "Etsy DE", description: "Marktplatz f\u00fcr Handgemachtes und Vintage", status: "coming_soon", category: "marketplaces", logoLetter: "E", logoColor: "bg-orange-600" },

  // Versand
  { id: "dhl", name: "DHL", description: "Pakete bis 31,5 kg, DE + International", status: "connected", category: "shipping", lastSync: "vor 12 Minuten", logoLetter: "D", logoColor: "bg-yellow-500" },
  { id: "dpd", name: "DPD", description: "Express und Standard Paketversand", status: "not_connected", category: "shipping", logoLetter: "D", logoColor: "bg-red-700" },
  { id: "gls", name: "GLS", description: "Flexibler Paketversand in Europa", status: "not_connected", category: "shipping", logoLetter: "G", logoColor: "bg-blue-700" },
  { id: "hermes", name: "Hermes", description: "Paketversand mit Paketshop-Netzwerk", status: "not_connected", category: "shipping", logoLetter: "H", logoColor: "bg-cyan-600" },
  { id: "ups", name: "UPS", description: "Weltweiter Express- und Paketversand", status: "not_connected", category: "shipping", logoLetter: "U", logoColor: "bg-amber-800" },
  { id: "deutschepost", name: "Deutsche Post", description: "Warenpost und Briefe", status: "not_connected", category: "shipping", logoLetter: "P", logoColor: "bg-yellow-600" },
  { id: "sendcloud", name: "SendCloud", description: "Multi-Carrier Versandplattform", status: "connected", category: "shipping", lastSync: "vor 5 Minuten", logoLetter: "S", logoColor: "bg-blue-500" },

  // Finanzen & Steuern
  { id: "sevdesk", name: "SevDesk", description: "Online-Buchhaltung und Rechnungen", status: "connected", category: "finance", lastSync: "vor 15 Minuten", logoLetter: "S", logoColor: "bg-emerald-600" },
  { id: "lexoffice", name: "lexoffice", description: "Buchhaltung und Steuern f\u00fcr KMU", status: "not_connected", category: "finance", logoLetter: "L", logoColor: "bg-blue-600" },
  { id: "datev", name: "DATEV", description: "Steuerberater-Schnittstelle", status: "coming_soon", category: "finance", logoLetter: "D", logoColor: "bg-green-700" },
  { id: "stripe", name: "Stripe", description: "Online-Zahlungsabwicklung", status: "coming_soon", category: "finance", logoLetter: "S", logoColor: "bg-violet-600" },

  // Shops
  { id: "shopify", name: "Shopify", description: "E-Commerce Plattform f\u00fcr Online-Shops", status: "coming_soon", category: "shops", logoLetter: "S", logoColor: "bg-green-600" },
  { id: "woocommerce", name: "WooCommerce", description: "WordPress E-Commerce Plugin", status: "coming_soon", category: "shops", logoLetter: "W", logoColor: "bg-purple-600" },
  { id: "shopware", name: "Shopware", description: "Deutsche E-Commerce Plattform", status: "coming_soon", category: "shops", logoLetter: "S", logoColor: "bg-blue-500" },

  // Sonstiges
  { id: "baselinker", name: "BaseLinker", description: "Multi-Channel E-Commerce Middleware", status: "connected", category: "other", lastSync: "vor 2 Minuten", logoLetter: "B", logoColor: "bg-sky-600" },
  { id: "zapier", name: "Zapier", description: "Workflow-Automatisierung", status: "coming_soon", category: "other", logoLetter: "Z", logoColor: "bg-orange-500" },
  { id: "make", name: "Make.com", description: "Visuelle Automatisierungsplattform", status: "coming_soon", category: "other", logoLetter: "M", logoColor: "bg-violet-500" },
  { id: "slack", name: "Slack", description: "Team-Kommunikation und Benachrichtigungen", status: "coming_soon", category: "other", logoLetter: "S", logoColor: "bg-purple-700" },
];

/* ─── Status helpers ─── */
const StatusIndicator: React.FC<{ status: IntegrationStatus; lastSync?: string }> = ({ status, lastSync }) => {
  if (status === "connected") {
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full bg-success" />
          <span className="text-xs font-medium text-success">Verbunden</span>
        </div>
        {lastSync && (
          <span className="text-[11px] text-txt-muted ml-3.5">Letzter Sync: {lastSync}</span>
        )}
      </div>
    );
  }
  if (status === "not_connected") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-block w-2 h-2 rounded-full bg-txt-muted/40" />
        <span className="text-xs text-txt-muted">Nicht verbunden</span>
      </div>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-app-elevated text-txt-muted">
      Demn\u00e4chst verf\u00fcgbar
    </span>
  );
};

/* ─── Integration Card ─── */
const IntegrationCard: React.FC<{
  integration: Integration;
  onDisconnect: (id: string, name: string) => void;
}> = ({ integration, onDisconnect }) => {
  const { id, name, description, status, logoLetter, logoColor } = integration;
  const isComingSoon = status === "coming_soon";

  return (
    <div
      className={`
        relative bg-app-surface rounded-xl border transition-all
        ${status === "connected" ? "border-success/30 border-t-2 border-t-success" : "border-app-border"}
        ${isComingSoon ? "opacity-60" : "hover:border-accent/40 hover:shadow-md"}
      `}
    >
      <div className="p-5">
        {/* Logo + Name + Description */}
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`
              w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0
              ${isComingSoon ? "bg-app-elevated text-txt-muted" : (logoColor || "bg-accent")}
            `}
          >
            {logoLetter || name.charAt(0)}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-txt-primary truncate">{name}</h3>
            <p className="text-xs text-txt-muted mt-0.5 line-clamp-1">{description}</p>
          </div>
        </div>

        {/* Status */}
        <div className="mb-4">
          <StatusIndicator status={status} lastSync={integration.lastSync} />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {status === "connected" && (
            <>
              <button className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors">
                Konfigurieren
              </button>
              <button
                onClick={() => onDisconnect(id, name)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg text-danger hover:bg-danger-dim transition-colors"
              >
                Trennen
              </button>
            </>
          )}
          {status === "not_connected" && (
            <button
              // TODO: Open integration wizard / OAuth flow for this service
              className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Verbinden
            </button>
          )}
          {status === "coming_soon" && (
            <button className="flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-app-border text-txt-secondary hover:bg-app-elevated transition-colors">
              Benachrichtigen
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/* ─── Main Component ─── */
export const IntegrationsHub: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Category>("marketplaces");
  const [integrations, setIntegrations] = useState<Integration[]>(INTEGRATIONS);

  const connectedCount = useMemo(
    () => integrations.filter((i) => i.status === "connected").length,
    [integrations]
  );

  const filtered = useMemo(
    () => integrations.filter((i) => i.category === activeTab),
    [integrations, activeTab]
  );

  const handleDisconnect = useCallback(
    (id: string, name: string) => {
      const confirmed = window.confirm(`M\u00f6chtest du ${name} wirklich trennen?`);
      if (!confirmed) return;
      setIntegrations((prev) =>
        prev.map((i) =>
          i.id === id ? { ...i, status: "not_connected" as IntegrationStatus, lastSync: undefined } : i
        )
      );
    },
    []
  );

  return (
    <div className="min-h-full bg-app-bg">
      {/* ─── Page Header ─── */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-txt-primary">Integrationen</h1>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-success-dim text-success">
            Verbundene Services: {connectedCount}
          </span>
        </div>
        <p className="mt-1 text-sm text-txt-secondary">
          Verwalte deine verbundenen Services und f\u00fcge neue hinzu.
        </p>
      </div>

      {/* ─── Tab Bar ─── */}
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

      {/* ─── Integration Cards Grid ─── */}
      <div className="px-6 pb-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              onDisconnect={handleDisconnect}
            />
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="flex items-center justify-center py-16 text-txt-muted text-sm">
            Keine Integrationen in dieser Kategorie.
          </div>
        )}
      </div>
    </div>
  );
};

export default IntegrationsHub;
