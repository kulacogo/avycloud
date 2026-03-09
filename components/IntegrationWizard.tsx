import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  connectIntegration,
  testIntegration,
  startEbayOAuth,
  disconnectIntegration,
} from "../api/client";
import type { IntegrationProvider, IntegrationStatusEntry } from "../api/client";

/* ─── Props ─── */
interface IntegrationWizardProps {
  provider: IntegrationProvider;
  currentStatus: IntegrationStatusEntry | null;
  onClose: () => void;
  onSuccess: () => void;
}

/* ─── Wizard Steps ─── */
type WizardStep = "overview" | "credentials" | "testing" | "success" | "disconnect-confirm";

const LOGO_CONFIG: Record<string, { letter: string; color: string }> = {
  ebay: { letter: "eB", color: "bg-blue-600" },
  kaufland: { letter: "KL", color: "bg-red-600" },
  baselinker: { letter: "BL", color: "bg-sky-600" },
  sendcloud: { letter: "SC", color: "bg-blue-500" },
  sevdesk: { letter: "SD", color: "bg-emerald-600" },
  dhl: { letter: "DHL", color: "bg-yellow-500" },
};

/* ─── Component ─── */
export const IntegrationWizard: React.FC<IntegrationWizardProps> = ({
  provider,
  currentStatus,
  onClose,
  onSuccess,
}) => {
  const isConnected = currentStatus?.status === "connected";
  const [step, setStep] = useState<WizardStep>(isConnected ? "overview" : "overview");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string>("");
  const backdropRef = useRef<HTMLDivElement>(null);

  // Initialize credential fields
  useEffect(() => {
    if (provider.fields) {
      const initial: Record<string, string> = {};
      for (const f of provider.fields) {
        initial[f.key] = "";
      }
      setCredentials(initial);
    }
  }, [provider.fields]);

  // Backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) {
      onClose();
    }
  }, [onClose]);

  // Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // ─── OAuth Flow ───
  const handleOAuthConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const url = await startEbayOAuth({ locale: "de-DE" });
      const popup = window.open(url, "ebay_oauth", "width=600,height=700,scrollbars=yes");

      // Listen for OAuth completion
      // Backend callback sends { type: 'avycloud:ebay_oauth_complete' }
      const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (
          msg === "avycloud:ebay_oauth_complete" ||
          msg?.type === "avycloud:ebay_oauth_complete"
        ) {
          window.removeEventListener("message", handler);
          setConnecting(false);
          setSuccessMessage("eBay wurde erfolgreich verbunden!");
          setStep("success");
        }
      };
      window.addEventListener("message", handler);

      // Check if popup was blocked
      if (!popup) {
        window.removeEventListener("message", handler);
        setConnecting(false);
        setError("Popup wurde blockiert. Bitte erlaube Popups für diese Seite.");
      }
    } catch (err: any) {
      setConnecting(false);
      setError(err.message || "OAuth-Flow konnte nicht gestartet werden");
    }
  }, []);

  // ─── API Key Test ───
  const handleTest = useCallback(async () => {
    setError(null);
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testIntegration(provider.id, credentials);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message || "Test fehlgeschlagen" });
    } finally {
      setTesting(false);
    }
  }, [provider.id, credentials]);

  // ─── API Key Connect ───
  const handleConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const result = await connectIntegration(provider.id, credentials);
      setSuccessMessage(result.testMessage || `${provider.name} wurde erfolgreich verbunden!`);
      setStep("success");
    } catch (err: any) {
      setError(err.message || "Verbindung fehlgeschlagen");
    } finally {
      setConnecting(false);
    }
  }, [provider.id, provider.name, credentials]);

  // ─── Disconnect ───
  const handleDisconnect = useCallback(async () => {
    setError(null);
    setDisconnecting(true);
    try {
      await disconnectIntegration(provider.id);
      setSuccessMessage(`${provider.name} wurde getrennt.`);
      setStep("success");
    } catch (err: any) {
      setError(err.message || "Trennung fehlgeschlagen");
    } finally {
      setDisconnecting(false);
    }
  }, [provider.id, provider.name]);

  // ─── Credential field validation ───
  const allFieldsFilled = provider.fields?.every((f) => {
    const val = credentials[f.key];
    return val && val.trim().length >= (f.minLength || 1);
  }) ?? false;

  const logo = LOGO_CONFIG[provider.id] || { letter: provider.name.charAt(0), color: "bg-accent" };

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div className="bg-app-surface border border-app-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-3 p-6 border-b border-app-border">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0 ${logo.color}`}>
            {logo.letter}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-txt-primary">{provider.name}</h2>
            <p className="text-xs text-txt-muted">{provider.description}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-app-elevated text-txt-muted hover:text-txt-primary transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* ── Step: Overview ── */}
          {step === "overview" && (
            <div className="space-y-5">
              {/* Features */}
              {provider.features && provider.features.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-txt-primary mb-2">Funktionen</h3>
                  <ul className="space-y-1.5">
                    {provider.features.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm text-txt-secondary">
                        <svg className="w-4 h-4 text-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Help text */}
              {provider.helpText && (
                <div className="bg-info-dim rounded-lg p-3">
                  <p className="text-sm text-info">{provider.helpText}</p>
                  {provider.helpUrl && (
                    <a
                      href={provider.helpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-accent hover:underline"
                    >
                      Anleitung öffnen
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    </a>
                  )}
                </div>
              )}

              {/* Connected status */}
              {isConnected && (
                <div className="bg-success-dim rounded-lg p-3 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-success" />
                  <span className="text-sm text-success font-medium">Verbunden</span>
                  {currentStatus?.connectedAt && (
                    <span className="text-xs text-txt-muted ml-auto">
                      seit {new Date(currentStatus.connectedAt).toLocaleDateString("de-DE")}
                    </span>
                  )}
                </div>
              )}

              {/* Dependency info */}
              {provider.authType === "none" && provider.dependsOn && (
                <div className="bg-warning-dim rounded-lg p-3">
                  <p className="text-sm text-warning">
                    Diese Integration wird automatisch über{" "}
                    <span className="font-semibold">{provider.dependsOn}</span> verbunden.
                    Verbinde zuerst {provider.dependsOn}.
                  </p>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3 pt-2">
                {provider.authType === "oauth2" && !isConnected && (
                  <button
                    onClick={handleOAuthConnect}
                    disabled={connecting}
                    className="flex-1 px-4 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {connecting ? "Verbinde..." : "Jetzt verbinden"}
                  </button>
                )}
                {provider.authType === "api_key" && !isConnected && (
                  <button
                    onClick={() => setStep("credentials")}
                    className="flex-1 px-4 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                  >
                    Zugangsdaten eingeben
                  </button>
                )}
                {isConnected && provider.authType !== "none" && (
                  <>
                    {provider.authType === "api_key" && (
                      <button
                        onClick={() => setStep("credentials")}
                        className="flex-1 px-4 py-2.5 bg-app-elevated text-txt-primary rounded-lg text-sm font-medium hover:bg-app-border transition-colors"
                      >
                        Zugangsdaten aktualisieren
                      </button>
                    )}
                    <button
                      onClick={() => setStep("disconnect-confirm")}
                      className="px-4 py-2.5 text-danger border border-danger/30 rounded-lg text-sm font-medium hover:bg-danger-dim transition-colors"
                    >
                      Trennen
                    </button>
                  </>
                )}
                {provider.authType === "none" && (
                  <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-app-elevated text-txt-primary rounded-lg text-sm font-medium hover:bg-app-border transition-colors">
                    Schließen
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Step: Credentials ── */}
          {step === "credentials" && (
            <div className="space-y-5">
              <p className="text-sm text-txt-secondary">
                Gib die Zugangsdaten für {provider.name} ein. Die Verbindung wird automatisch getestet.
              </p>

              {/* Input fields */}
              <div className="space-y-4">
                {provider.fields?.map((field) => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium text-txt-primary mb-1.5">
                      {field.label}
                      {field.required && <span className="text-danger ml-0.5">*</span>}
                    </label>
                    <input
                      type={field.type === "password" ? "password" : "text"}
                      placeholder={field.placeholder}
                      value={credentials[field.key] || ""}
                      onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      className="w-full px-3 py-2 bg-app-bg border border-app-border rounded-lg text-sm text-txt-primary placeholder:text-txt-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                      autoComplete="off"
                    />
                    {field.minLength && (
                      <p className="text-[11px] text-txt-muted mt-1">Mindestens {field.minLength} Zeichen</p>
                    )}
                  </div>
                ))}
              </div>

              {/* Test result */}
              {testResult && (
                <div className={`rounded-lg p-3 ${testResult.ok ? "bg-success-dim" : "bg-danger-dim"}`}>
                  <div className="flex items-center gap-2">
                    {testResult.ok ? (
                      <svg className="w-4 h-4 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    ) : (
                      <svg className="w-4 h-4 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    )}
                    <span className={`text-sm font-medium ${testResult.ok ? "text-success" : "text-danger"}`}>
                      {testResult.message}
                    </span>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="bg-danger-dim rounded-lg p-3">
                  <p className="text-sm text-danger">{error}</p>
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => { setStep("overview"); setError(null); setTestResult(null); }}
                  className="px-4 py-2.5 bg-app-elevated text-txt-primary rounded-lg text-sm font-medium hover:bg-app-border transition-colors"
                >
                  Zurück
                </button>
                <button
                  onClick={handleTest}
                  disabled={testing || !allFieldsFilled}
                  className="px-4 py-2.5 bg-app-elevated text-txt-primary rounded-lg text-sm font-medium hover:bg-app-border transition-colors disabled:opacity-50"
                >
                  {testing ? "Teste..." : "Verbindung testen"}
                </button>
                <button
                  onClick={handleConnect}
                  disabled={connecting || !allFieldsFilled}
                  className="flex-1 px-4 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {connecting ? "Verbinde..." : "Verbinden & Speichern"}
                </button>
              </div>
            </div>
          )}

          {/* ── Step: Success ── */}
          {step === "success" && (
            <div className="text-center py-4 space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-success-dim flex items-center justify-center">
                <svg className="w-8 h-8 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              </div>
              <div>
                <h3 className="text-lg font-semibold text-txt-primary">Erfolgreich!</h3>
                <p className="text-sm text-txt-secondary mt-1">{successMessage}</p>
              </div>
              <button
                onClick={() => { onSuccess(); onClose(); }}
                className="px-6 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Schließen
              </button>
            </div>
          )}

          {/* ── Step: Disconnect Confirm ── */}
          {step === "disconnect-confirm" && (
            <div className="space-y-5">
              <div className="bg-danger-dim rounded-lg p-4">
                <h3 className="text-sm font-semibold text-danger mb-1">Integration trennen?</h3>
                <p className="text-sm text-txt-secondary">
                  Die Verbindung zu {provider.name} wird getrennt und die gespeicherten Zugangsdaten werden gelöscht.
                  Du kannst die Integration jederzeit erneut verbinden.
                </p>
              </div>

              {error && (
                <div className="bg-danger-dim rounded-lg p-3">
                  <p className="text-sm text-danger">{error}</p>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={() => { setStep("overview"); setError(null); }}
                  className="flex-1 px-4 py-2.5 bg-app-elevated text-txt-primary rounded-lg text-sm font-medium hover:bg-app-border transition-colors"
                >
                  Abbrechen
                </button>
                <button
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="flex-1 px-4 py-2.5 bg-danger text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {disconnecting ? "Trenne..." : "Endgültig trennen"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default IntegrationWizard;
