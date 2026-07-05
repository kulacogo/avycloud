import React, { useState, useEffect, useCallback } from "react";
import {
  fetchIntegrationConfig,
  syncIntegration,
  saveIntegrationDefaults,
  fetchIntegrationProviders,
  fetchIntegrationStatus,
} from "../../api/client";
import type { IntegrationConfig, IntegrationProvider, IntegrationStatusEntry } from "../../api/client";
import IntegrationWizard from "../IntegrationWizard";

/* ─── Integration Metadata ─── */

type IntegrationId = "ebay" | "kaufland" | "sendcloud" | "sevdesk";

interface PolicySection {
  key: string;
  label: string;
  defaultKey: string;
  columns: { key: string; label: string; width?: string }[];
}

const INTEGRATION_META: Record<
  IntegrationId,
  { name: string; color: string; letter: string; sections: PolicySection[] }
> = {
  ebay: {
    name: "eBay",
    color: "bg-blue-600",
    letter: "eB",
    sections: [
      {
        key: "shipping",
        label: "Versand",
        defaultKey: "shippingPolicyId",
        columns: [
          { key: "id", label: "ID", width: "w-24" },
          { key: "name", label: "Name" },
        ],
      },
      {
        key: "return",
        label: "Ruecknahme",
        defaultKey: "returnPolicyId",
        columns: [
          { key: "id", label: "ID", width: "w-24" },
          { key: "name", label: "Name" },
        ],
      },
      {
        key: "payment",
        label: "Zahlung",
        defaultKey: "paymentPolicyId",
        columns: [
          { key: "id", label: "ID", width: "w-24" },
          { key: "name", label: "Name" },
        ],
      },
    ],
  },
  kaufland: {
    name: "Kaufland",
    color: "bg-red-600",
    letter: "KL",
    sections: [
      {
        key: "shippingGroups",
        label: "Versandgruppen",
        defaultKey: "shippingGroupId",
        columns: [
          { key: "id", label: "ID", width: "w-24" },
          { key: "name", label: "Name" },
          { key: "type", label: "Typ", width: "w-28" },
          { key: "storefront", label: "Storefront", width: "w-24" },
        ],
      },
      {
        key: "warehouses",
        label: "Lager",
        defaultKey: "warehouseId",
        columns: [
          { key: "id", label: "ID", width: "w-24" },
          { key: "name", label: "Name" },
          { key: "type", label: "Typ", width: "w-28" },
        ],
      },
    ],
  },
  sendcloud: {
    name: "SendCloud",
    color: "bg-blue-500",
    letter: "SC",
    sections: [
      {
        key: "senderAddresses",
        label: "Absenderadressen",
        defaultKey: "senderAddressId",
        columns: [
          { key: "id", label: "ID", width: "w-16" },
          { key: "companyName", label: "Firma" },
          { key: "city", label: "Stadt", width: "w-32" },
          { key: "country", label: "Land", width: "w-16" },
        ],
      },
      {
        key: "shippingMethods",
        label: "Versandmethoden",
        defaultKey: "shippingMethodId",
        columns: [
          { key: "id", label: "ID", width: "w-16" },
          { key: "name", label: "Name" },
          { key: "carrier", label: "Carrier", width: "w-28" },
        ],
      },
    ],
  },
  sevdesk: {
    name: "SevDesk",
    color: "bg-emerald-600",
    letter: "SD",
    sections: [
      {
        key: "taxRates",
        label: "Steuerraten",
        defaultKey: "taxRateId",
        columns: [
          { key: "id", label: "ID", width: "w-16" },
          { key: "name", label: "Name" },
          { key: "taxRate", label: "Satz (%)", width: "w-24" },
        ],
      },
      {
        key: "checkAccounts",
        label: "Bankkonten",
        defaultKey: "checkAccountId",
        columns: [
          { key: "id", label: "ID", width: "w-16" },
          { key: "name", label: "Name" },
          { key: "iban", label: "IBAN", width: "w-48" },
          { key: "currency", label: "Waehrung", width: "w-20" },
        ],
      },
    ],
  },
};

/* ─── Props ─── */

interface IntegrationConfigPageProps {
  integration: IntegrationId;
  onBack: () => void;
}

/* ─── Component ─── */

export const IntegrationConfigPage: React.FC<IntegrationConfigPageProps> = ({
  integration,
  onBack,
}) => {
  const meta = INTEGRATION_META[integration];
  const [config, setConfig] = useState<IntegrationConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [localDefaults, setLocalDefaults] = useState<Record<string, any>>({});
  const [provider, setProvider] = useState<IntegrationProvider | null>(null);
  const [statusEntry, setStatusEntry] = useState<IntegrationStatusEntry | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchIntegrationConfig(integration);
      setConfig(data);
      setLocalDefaults(data.defaults || {});
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden der Konfiguration");
    } finally {
      setLoading(false);
    }
  }, [integration]);

  // Provider-Definition (Felder für den Wizard) + Verbindungs-Status laden —
  // best effort, die Seite funktioniert auch ohne.
  const loadConnectionState = useCallback(async () => {
    try {
      const [providers, statuses] = await Promise.all([
        fetchIntegrationProviders().catch(() => [] as IntegrationProvider[]),
        fetchIntegrationStatus().catch(() => [] as IntegrationStatusEntry[]),
      ]);
      setProvider(providers.find((p) => p.id === integration) || null);
      setStatusEntry(statuses.find((s) => s.id === integration) || null);
    } catch {
      /* keine harte Abhängigkeit */
    }
  }, [integration]);

  useEffect(() => {
    loadConfig();
    loadConnectionState();
  }, [loadConfig, loadConnectionState]);

  // Wizard nur öffnen, wenn die Provider-Definition geladen ist — sonst wäre
  // der Knopf ein stiller No-op (Review-Fix): Fehler zeigen + Neuladen anstoßen.
  const openWizard = useCallback(() => {
    if (provider) {
      setWizardOpen(true);
    } else {
      setError("Integrations-Definition konnte nicht geladen werden — bitte Seite neu laden.");
      loadConnectionState();
    }
  }, [provider, loadConnectionState]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    setSuccess(null);
    try {
      const data = await syncIntegration(integration);
      setConfig(data);
      setLocalDefaults(data.defaults || {});
      setSuccess("Synchronisierung erfolgreich");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.message || "Fehler bei der Synchronisierung");
    } finally {
      setSyncing(false);
    }
  }, [integration]);

  const handleSaveDefaults = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const data = await saveIntegrationDefaults(integration, localDefaults);
      setConfig(data);
      setSuccess("Bevorzugte Einstellungen gespeichert");
      setTimeout(() => setSuccess(null), 3000);
    } catch (err: any) {
      setError(err.message || "Fehler beim Speichern");
    } finally {
      setSaving(false);
    }
  }, [integration, localDefaults]);

  const setDefault = useCallback((key: string, value: any) => {
    setLocalDefaults((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Check if defaults changed
  const defaultsChanged =
    JSON.stringify(localDefaults) !== JSON.stringify(config?.defaults || {});

  const lastSyncLabel = config?.lastSyncedAt
    ? new Date(config.lastSyncedAt).toLocaleString("de-DE")
    : "Nie";

  if (loading) {
    return (
      <div className="min-h-full bg-app-bg p-6 space-y-6 animate-pulse">
        <div className="h-8 w-64 bg-app-elevated rounded-lg" />
        <div className="h-10 w-full bg-app-elevated rounded-xl" />
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-app-surface border border-app-border rounded-xl p-6 h-48"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="min-h-full bg-app-bg">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={onBack}
            className="p-1.5 rounded-lg text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold text-sm ${meta.color}`}
          >
            {meta.letter}
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-txt-primary">
              {meta.name} Konfiguration
            </h1>
            <p className="text-xs text-txt-muted mt-0.5">
              Letzter Sync: {lastSyncLabel}
            </p>
          </div>
          {provider && (
            <button
              onClick={openWizard}
              className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity flex items-center gap-2"
              title={
                integration === "ebay"
                  ? "Erneut bei eBay autorisieren — erneuert Token und Berechtigungen"
                  : "Zugangsdaten eingeben oder aktualisieren — z. B. nach einem Konto-Wechsel"
              }
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {integration === "ebay" ? "Neu verbinden" : "Zugangsdaten"}
            </button>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-4 py-2 bg-app-elevated border border-app-border rounded-lg text-sm font-medium text-txt-primary hover:bg-app-surface transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <svg
              className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {syncing ? "Synchronisiere..." : "Synchronisieren"}
          </button>
        </div>

        {/* eBay: Angebots-Abgleich gestört (ehrlicher Sync-Zustand) */}
        {integration === "ebay" &&
          statusEntry?.details?.listingSync &&
          statusEntry.details.listingSync.healthy === false && (
            <div className="bg-danger-dim border border-app-border rounded-xl px-4 py-3 mb-4">
              <p className="text-sm text-danger font-semibold mb-1">
                Angebots-Abgleich mit eBay gestört
              </p>
              <p className="text-xs text-txt-secondary mb-1">
                {statusEntry.details.listingSync.lastSuccessAtIso
                  ? `Letzter erfolgreicher Abruf: ${new Date(statusEntry.details.listingSync.lastSuccessAtIso).toLocaleString("de-DE")}.`
                  : "Es gab noch keinen erfolgreichen Abruf."}{" "}
                Die angezeigten eBay-Angebote können veraltet sein.
              </p>
              {statusEntry.details.listingSync.lastError?.message && (
                <p className="text-xs text-txt-muted mb-3">
                  Letzter Fehler: {statusEntry.details.listingSync.lastError.message}
                </p>
              )}
              <button
                onClick={openWizard}
                className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                eBay neu verbinden
              </button>
            </div>
          )}

        {/* Banners */}
        {error && (
          <div className="bg-danger-dim border border-app-border rounded-xl px-4 py-3 flex items-center gap-3 mb-4">
            <span className="text-sm text-danger flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-txt-muted hover:text-txt-primary text-sm"
            >
              Schliessen
            </button>
          </div>
        )}
        {success && (
          <div className="bg-success-dim border border-app-border rounded-xl px-4 py-3 text-sm text-success font-medium mb-4">
            {success}
          </div>
        )}
        {/* eBay: missing scope warning */}
        {integration === "ebay" &&
          config?.lastSyncedAt &&
          !error &&
          meta.sections.every(
            (s) => ((config?.cachedData?.[s.key] as any[]) || []).length === 0
          ) && (
            <div className="bg-warning-dim border border-app-border rounded-xl px-4 py-3 mb-4">
              <p className="text-sm text-warning font-medium mb-1">
                Keine Rahmenbedingungen geladen
              </p>
              <p className="text-xs text-txt-secondary mb-3">
                Der eBay OAuth-Token hat nicht die noetige Berechtigung
                (sell.account.readonly). Bitte eBay neu autorisieren, damit die
                Rahmenbedingungen abgerufen werden koennen.
              </p>
              <button
                onClick={openWizard}
                className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                eBay neu autorisieren
              </button>
            </div>
          )}
      </div>

      {/* Policy Sections */}
      <div className="px-6 pb-8 space-y-6">
        {meta.sections.map((section) => {
          const items: any[] =
            (config?.cachedData?.[section.key] as any[]) || [];
          const currentDefault = localDefaults[section.defaultKey];

          return (
            <div
              key={section.key}
              className="bg-app-surface border border-app-border rounded-xl overflow-hidden"
            >
              {/* Section Header */}
              <div className="px-5 py-4 border-b border-app-border flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-txt-primary">
                    {section.label}
                  </h3>
                  <p className="text-xs text-txt-muted mt-0.5">
                    {items.length} Eintraege gefunden
                  </p>
                </div>
                {currentDefault && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-accent/10 text-accent">
                    <svg
                      className="w-3 h-3"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Standard gesetzt
                  </span>
                )}
              </div>

              {/* Table */}
              {items.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-txt-muted">
                  Keine Daten vorhanden. Bitte synchronisieren.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-app-border bg-app-elevated/50">
                        <th className="px-5 py-2.5 text-left text-xs font-medium text-txt-muted w-12">
                          Standard
                        </th>
                        {section.columns.map((col) => (
                          <th
                            key={col.key}
                            className={`px-3 py-2.5 text-left text-xs font-medium text-txt-muted ${col.width || ""}`}
                          >
                            {col.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item: any) => {
                        const itemId = String(item.id ?? item.ID ?? "");
                        const isDefault = String(currentDefault) === itemId;
                        return (
                          <tr
                            key={itemId}
                            className={`border-b border-app-border last:border-0 transition-colors cursor-pointer hover:bg-app-elevated/30 ${
                              isDefault ? "bg-accent/[0.04]" : ""
                            }`}
                            onClick={() =>
                              setDefault(
                                section.defaultKey,
                                isDefault ? null : itemId
                              )
                            }
                          >
                            <td className="px-5 py-3">
                              <div
                                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                                  isDefault
                                    ? "border-accent bg-accent"
                                    : "border-app-border"
                                }`}
                              >
                                {isDefault && (
                                  <div className="w-1.5 h-1.5 rounded-full bg-white" />
                                )}
                              </div>
                            </td>
                            {section.columns.map((col) => (
                              <td
                                key={col.key}
                                className={`px-3 py-3 ${
                                  isDefault
                                    ? "text-txt-primary font-medium"
                                    : "text-txt-secondary"
                                } ${col.width || ""}`}
                              >
                                {String(item[col.key] ?? "—")}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        {/* Save Button */}
        {defaultsChanged && (
          <div className="flex justify-end">
            <button
              onClick={handleSaveDefaults}
              disabled={saving}
              className="px-6 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? "Speichere..." : "Bevorzugte Einstellungen speichern"}
            </button>
          </div>
        )}
      </div>

      {/* Verbinden / Zugangsdaten (gleicher Wizard wie im IntegrationsHub) */}
      {wizardOpen && provider && (
        <IntegrationWizard
          provider={provider}
          currentStatus={statusEntry}
          onClose={() => setWizardOpen(false)}
          onSuccess={() => {
            loadConnectionState();
            loadConfig();
          }}
        />
      )}
    </div>
  );
};

export default IntegrationConfigPage;
