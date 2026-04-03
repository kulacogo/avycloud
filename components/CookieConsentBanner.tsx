import React, { useState } from "react";
import { useCookieConsent } from "../context/CookieConsentContext";

const CookieConsentBanner: React.FC = () => {
  const { showBanner, acceptAll, rejectOptional, updateConsent } = useCookieConsent();
  const [showSettings, setShowSettings] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [tracking, setTracking] = useState(false);

  if (!showBanner) return null;

  const handleSaveCustom = () => {
    updateConsent({ analytics, tracking });
  };

  return (
    <div className="fixed bottom-0 inset-x-0 z-[9999] p-4 pointer-events-none">
      <div className="max-w-2xl mx-auto pointer-events-auto">
        <div className="bg-app-surface border border-app-border rounded-xl shadow-lg p-5">
          {/* Header */}
          <div className="flex items-start gap-3 mb-3">
            <div className="shrink-0 w-8 h-8 rounded-lg bg-accent-dim text-accent flex items-center justify-center text-base">
              🍪
            </div>
            <div>
              <h3 className="text-sm font-semibold text-txt-primary">
                Cookie-Einstellungen
              </h3>
              <p className="text-xs text-txt-secondary mt-1 leading-relaxed">
                Wir verwenden Cookies und ähnliche Technologien, um AvyCloud bereitzustellen und zu verbessern.
                Einige sind technisch notwendig, andere helfen uns, das Nutzungserlebnis zu optimieren.
              </p>
            </div>
          </div>

          {/* Settings panel */}
          {showSettings && (
            <div className="mb-4 space-y-3 pl-11">
              {/* Necessary — always on */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-txt-primary">Notwendig</span>
                  <p className="text-[10px] text-txt-muted">
                    Für Login, Sicherheit und grundlegende Funktionen erforderlich.
                  </p>
                </div>
                <div className="w-10 h-5 rounded-full bg-accent/60 relative cursor-not-allowed opacity-60">
                  <div className="absolute right-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm" />
                </div>
              </div>

              {/* Analytics */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-txt-primary">Analyse</span>
                  <p className="text-[10px] text-txt-muted">
                    Hilft uns zu verstehen, wie AvyCloud genutzt wird.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAnalytics(!analytics)}
                  className={`w-10 h-5 rounded-full relative transition-colors ${
                    analytics ? "bg-accent" : "bg-app-elevated"
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${
                      analytics ? "right-0.5" : "left-0.5"
                    }`}
                  />
                </button>
              </div>

              {/* Tracking */}
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-txt-primary">Tracking</span>
                  <p className="text-[10px] text-txt-muted">
                    Geräte- und Standortdaten für Aktivitätsprotokoll.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setTracking(!tracking)}
                  className={`w-10 h-5 rounded-full relative transition-colors ${
                    tracking ? "bg-accent" : "bg-app-elevated"
                  }`}
                >
                  <div
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${
                      tracking ? "right-0.5" : "left-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pl-11">
            <button
              type="button"
              onClick={acceptAll}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              Alle akzeptieren
            </button>
            <button
              type="button"
              onClick={rejectOptional}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-app-elevated text-txt-secondary hover:text-txt-primary border border-app-border transition-colors"
            >
              Nur notwendige
            </button>
            {!showSettings ? (
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="px-4 py-2 text-xs font-medium text-txt-muted hover:text-txt-secondary transition-colors"
              >
                Einstellungen
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSaveCustom}
                className="px-4 py-2 text-xs font-medium rounded-lg bg-app-elevated text-txt-secondary hover:text-txt-primary border border-app-border transition-colors"
              >
                Auswahl speichern
              </button>
            )}
          </div>

          {/* Legal link */}
          <p className="text-[10px] text-txt-muted mt-3 pl-11">
            Mehr Informationen in unserer Datenschutzerklärung.
          </p>
        </div>
      </div>
    </div>
  );
};

export default CookieConsentBanner;
