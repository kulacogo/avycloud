import React, { useState, useCallback } from "react";
import { runRepricingBatch } from "../../api/client";

export interface SuggestionRow {
  productId: string;
  productName?: string;
  currentPrice: number;
  suggestedPrice: number;
  margin: number | null;
  confidence: number;
  strategy: string;
  pricingTier: number | null;
  matchBasis: string | null;
}

interface PricingSuggestionsProps {
  onAccept: (productId: string, suggestedPrice: number) => Promise<void>;
}

const fmt = (amount: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(amount);

const confidenceLabel = (c: number): { text: string; cls: string } => {
  if (c >= 0.8) return { text: "Hoch", cls: "text-success bg-success-dim" };
  if (c >= 0.5) return { text: "Mittel", cls: "text-warning bg-warning-dim" };
  return { text: "Niedrig", cls: "text-danger bg-danger-dim" };
};

const PricingSuggestions: React.FC<PricingSuggestionsProps> = ({ onAccept }) => {
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<{
    processed: number;
    updated: number;
    errors: number;
  } | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  const handleReprice = useCallback(async () => {
    setRunning(true);
    setError(null);
    setBatchResult(null);
    setSuggestions([]);
    try {
      const result = await runRepricingBatch();
      setBatchResult({
        processed: result.processed ?? 0,
        updated: result.updated ?? 0,
        errors: result.errors ?? 0,
      });
      const rows: SuggestionRow[] = (result.suggestions || [])
        .filter((s: any) => s.suggestedPrice != null)
        .map((s: any) => ({
          productId: s.productId,
          currentPrice: s.currentPrice ?? 0,
          suggestedPrice: s.suggestedPrice,
          margin: s.margin ?? null,
          confidence: s.confidence ?? 0,
          strategy: s.strategy ?? "",
          pricingTier: s.pricingTier ?? null,
          matchBasis: s.matchBasis ?? null,
        }));
      setSuggestions(rows);
    } catch (err: any) {
      setError(err?.message || "Fehler beim Repricing");
    } finally {
      setRunning(false);
    }
  }, []);

  const handleAccept = async (row: SuggestionRow) => {
    setAcceptingId(row.productId);
    try {
      await onAccept(row.productId, row.suggestedPrice);
      setSuggestions((prev) => prev.filter((s) => s.productId !== row.productId));
    } catch {
      // error handled by parent
    } finally {
      setAcceptingId(null);
    }
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-txt-secondary">
          {suggestions.length > 0
            ? `${suggestions.length} Vorschlag${suggestions.length !== 1 ? "e" : ""}`
            : "Starte Repricing um Vorschläge zu generieren"}
        </p>
        <button
          onClick={handleReprice}
          disabled={running}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md
            bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
        >
          {running ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Repricing läuft...
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0011.664 0l3.181-3.183" />
              </svg>
              Repricing starten
            </>
          )}
        </button>
      </div>

      {/* Batch result summary */}
      {batchResult && (
        <div className="mb-4 flex items-center gap-4 px-4 py-2.5 rounded-lg bg-app-surface border border-app-border text-xs">
          <span className="text-txt-secondary">
            Verarbeitet: <span className="font-semibold text-txt-primary">{batchResult.processed}</span>
          </span>
          <span className="text-txt-secondary">
            Aktualisiert: <span className="font-semibold text-success">{batchResult.updated}</span>
          </span>
          {batchResult.errors > 0 && (
            <span className="text-txt-secondary">
              Fehler: <span className="font-semibold text-danger">{batchResult.errors}</span>
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 text-sm text-danger px-3 py-2 bg-danger-dim rounded-md">{error}</div>
      )}

      {suggestions.length === 0 && !running && !error && (
        <div className="text-center py-12 bg-app-surface border border-app-border rounded-lg space-y-2">
          <p className="text-txt-muted text-sm">
            {batchResult && batchResult.processed === 0
              ? "Noch keine Preisregeln vorhanden. Erstelle zuerst Regeln im Tab \"Regeln\", dann starte das Repricing."
              : batchResult
                ? "Keine offenen Vorschläge nach dem Repricing."
                : "Noch kein Repricing durchgeführt. Klicke \"Repricing starten\" um Vorschläge zu generieren."}
          </p>
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="bg-app-surface border border-app-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border text-left">
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                  Produkt
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider text-right">
                  Aktuell
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider text-right">
                  Vorschlag
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider text-right hidden md:table-cell">
                  Marge
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider hidden lg:table-cell">
                  Konfidenz
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider text-right">
                  Aktion
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {suggestions.map((row) => {
                const conf = confidenceLabel(row.confidence);
                const priceDiff = row.suggestedPrice - row.currentPrice;
                return (
                  <tr key={row.productId} className="hover:bg-app-elevated/50 transition-colors">
                    <td className="px-4 py-2.5 text-txt-primary font-mono text-xs truncate max-w-[180px]">
                      {row.productId}
                    </td>
                    <td className="px-4 py-2.5 text-right text-txt-secondary">
                      {row.currentPrice > 0 ? fmt(row.currentPrice) : "--"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="font-semibold text-accent">{fmt(row.suggestedPrice)}</span>
                      {row.currentPrice > 0 && (
                        <span
                          className={`ml-1.5 text-xs ${priceDiff >= 0 ? "text-success" : "text-danger"}`}
                        >
                          {priceDiff >= 0 ? "+" : ""}
                          {priceDiff.toFixed(2)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right hidden md:table-cell">
                      {row.margin != null ? (
                        <span className={row.margin >= 0 ? "text-success" : "text-danger"}>
                          {row.margin.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-txt-muted">--</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 hidden lg:table-cell">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${conf.cls}`}>
                        {conf.text}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => handleAccept(row)}
                        disabled={acceptingId === row.productId}
                        className="px-2.5 py-1 text-xs font-medium rounded-md
                          bg-success-dim text-success hover:bg-success/25 transition-colors
                          disabled:opacity-50"
                        title={row.matchBasis || "Vorschlag übernehmen"}
                      >
                        {acceptingId === row.productId ? "..." : "Übernehmen"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default PricingSuggestions;
