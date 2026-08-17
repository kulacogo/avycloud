import React from 'react';

import {
  istNachladeFehler,
  sollNeuLaden,
  meldeErfolgreichenStart,
  nachladeFehlerText,
} from '../utils/chunkReload';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** Es wird gerade von selbst neu geladen — dann keine Fehlerkarte zeigen. */
  laedtNeu: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, laedtNeu: false };
  }

  static getDerivedStateFromError(error: Error): State {
    // `laedtNeu` MUSS schon hier stehen: getDerivedStateFromError laeuft vor
    // componentDidCatch. Wuerde es erst dort gesetzt, blitzte einmal die
    // Fehlerkarte auf, bevor das Neuladen greift.
    return { hasError: true, error, laedtNeu: istNachladeFehler(error) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Unhandled error:', error, info.componentStack);

    // Fehlt nach einer Veroeffentlichung ein Programmteil, ist das selbstheilbar:
    // Neuladen holt die neue Fassung. Statt dem Menschen "Unexpected token '<'"
    // hinzustellen, laedt die Anwendung hoechstens zweimal von selbst neu.
    // Der Schleifenschutz liegt in utils/chunkReload.ts.
    if (sollNeuLaden(error)) {
      window.location.reload();
      return;
    }
    // Kein Neuladen mehr moeglich (Budget aufgebraucht) — dann die erklaerende
    // Karte zeigen statt eines leeren Bildschirms.
    if (this.state.laedtNeu) {
      this.setState({ laedtNeu: false });
    }
  }

  render() {
    if (this.state.hasError) {
      // Waehrend des eigenen Neuladens: ruhige Zeile statt Fehlermeldung.
      if (this.state.laedtNeu) {
        return (
          <div className="flex flex-col items-center justify-center min-h-[40vh] gap-3 p-8" role="status" aria-live="polite">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-app-border border-t-accent" />
            <p className="text-sm text-txt-muted">Neue Version wird geladen …</p>
          </div>
        );
      }

      if (this.props.fallback) return this.props.fallback;

      // Ein Nachladefehler, der auch das Neuladen ueberlebt hat: erklaeren statt
      // die rohe Browsermeldung zu zeigen — "Unexpected token '<'" sagt einem
      // Betreiber nichts.
      const nachladen = istNachladeFehler(this.state.error);
      return (
        <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4 text-txt-secondary p-8">
          <div className="text-5xl">⚠️</div>
          <h2 className="text-xl font-semibold text-txt-primary">
            {nachladen ? 'Neue Version verfügbar' : 'Etwas ist schiefgelaufen'}
          </h2>
          {nachladen ? (
            <>
              <p className="text-sm text-txt-muted bg-app-elevated rounded-lg px-4 py-3 max-w-xl text-center leading-relaxed">
                {nachladeFehlerText()}
              </p>
              {this.state.error && (
                <details className="max-w-xl w-full">
                  <summary className="text-xs text-txt-muted cursor-pointer text-center hover:text-txt-secondary transition">
                    Details
                  </summary>
                  <p className="mt-2 text-xs text-txt-muted font-mono bg-app-elevated rounded-lg px-3 py-2 break-all">
                    {this.state.error.message}
                  </p>
                </details>
              )}
            </>
          ) : this.state.error ? (
            <p className="text-sm text-txt-muted font-mono bg-app-elevated rounded-lg px-4 py-2 max-w-xl text-center break-all">
              {this.state.error.message}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => {
              // Ein Klick eines Menschen kann keine Endlosschleife erzeugen —
              // deshalb darf er den Zaehler zuruecksetzen.
              meldeErfolgreichenStart({ sofort: true });
              window.location.reload();
            }}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-txt-primary hover:bg-accent/80 transition-colors"
          >
            Seite neu laden
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
