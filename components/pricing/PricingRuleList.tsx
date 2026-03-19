import React, { useState } from "react";
import { PricingRule } from "../../hooks/usePricingRules";
import PricingRuleForm, { PricingRuleFormData, strategyLabel } from "./PricingRuleForm";

interface PricingRuleListProps {
  rules: PricingRule[];
  loading: boolean;
  onToggle: (ruleId: string) => Promise<void>;
  onDelete: (ruleId: string) => Promise<void>;
  onSave: (data: { productId: string; ruleType: string; params?: Record<string, any> }) => Promise<void>;
}

const fmt = (amount: number) =>
  new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(amount);

const timeAgo = (iso: string | null) => {
  if (!iso) return "--";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "gerade eben";
  if (mins < 60) return `vor ${mins} Min.`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `vor ${hrs} Std.`;
  const days = Math.floor(hrs / 24);
  return `vor ${days} Tag${days !== 1 ? "en" : ""}`;
};

const StrategyBadge: React.FC<{ ruleType: string }> = ({ ruleType }) => {
  const colorMap: Record<string, string> = {
    competitor_median: "bg-accent-dim text-accent",
    category_match: "bg-info-dim text-info",
    cost_plus: "bg-warning-dim text-warning",
    manual: "bg-app-elevated text-txt-secondary",
  };
  const cls = colorMap[ruleType] || "bg-app-elevated text-txt-secondary";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {strategyLabel(ruleType)}
    </span>
  );
};

const PricingRuleList: React.FC<PricingRuleListProps> = ({
  rules,
  loading,
  onToggle,
  onDelete,
  onSave,
}) => {
  const [showForm, setShowForm] = useState(false);
  const [editRule, setEditRule] = useState<PricingRule | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleEdit = (rule: PricingRule) => {
    setEditRule(rule);
    setShowForm(true);
  };

  const handleSave = async (data: PricingRuleFormData) => {
    await onSave({
      productId: data.productId,
      ruleType: data.ruleType,
      params: data.params,
    });
    setShowForm(false);
    setEditRule(null);
  };

  const handleDelete = async (ruleId: string) => {
    await onDelete(ruleId);
    setDeleteConfirm(null);
  };

  const paramsDisplay = (params: Record<string, any>) => {
    const parts: string[] = [];
    if (params.minMargin != null) parts.push(`Marge >= ${(params.minMargin * 100).toFixed(0)}%`);
    if (params.minPrice != null) parts.push(`Min ${fmt(params.minPrice)}`);
    if (params.maxPrice != null) parts.push(`Max ${fmt(params.maxPrice)}`);
    return parts.length > 0 ? parts.join(" | ") : "--";
  };

  if (loading && rules.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-pulse text-sm text-txt-muted">Regeln werden geladen...</div>
      </div>
    );
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-txt-secondary">
          {rules.length} Regel{rules.length !== 1 ? "n" : ""}
        </p>
        <button
          onClick={() => {
            setEditRule(null);
            setShowForm(true);
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md
            bg-accent text-white hover:bg-accent/90 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Neue Regel
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="text-center py-12 bg-app-surface border border-app-border rounded-lg">
          <p className="text-txt-muted text-sm">Noch keine Preisregeln vorhanden.</p>
          <button
            onClick={() => {
              setEditRule(null);
              setShowForm(true);
            }}
            className="mt-3 text-sm text-accent hover:underline"
          >
            Erste Regel erstellen
          </button>
        </div>
      ) : (
        <div className="bg-app-surface border border-app-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-app-border text-left">
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                  Produkt
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                  Strategie
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider hidden lg:table-cell">
                  Parameter
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider">
                  Aktiv
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider hidden md:table-cell">
                  Zuletzt
                </th>
                <th className="px-4 py-2.5 text-xs font-semibold text-txt-muted uppercase tracking-wider text-right">
                  Aktionen
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {rules.map((rule) => (
                <tr key={rule.id} className="hover:bg-app-elevated/50 transition-colors">
                  <td className="px-4 py-2.5 text-txt-primary font-mono text-xs truncate max-w-[180px]">
                    {rule.productId}
                  </td>
                  <td className="px-4 py-2.5">
                    <StrategyBadge ruleType={rule.ruleType} />
                  </td>
                  <td className="px-4 py-2.5 text-txt-secondary text-xs hidden lg:table-cell">
                    {paramsDisplay(rule.params || {})}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => onToggle(rule.id)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        rule.active ? "bg-accent" : "bg-app-elevated"
                      }`}
                      title={rule.active ? "Deaktivieren" : "Aktivieren"}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          rule.active ? "translate-x-[18px]" : "translate-x-[3px]"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-2.5 text-txt-muted text-xs hidden md:table-cell">
                    {timeAgo(rule.lastApplied)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => handleEdit(rule)}
                        className="p-1.5 rounded-md text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-colors"
                        title="Bearbeiten"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                        </svg>
                      </button>
                      {deleteConfirm === rule.id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => handleDelete(rule.id)}
                            className="px-2 py-1 text-xs font-medium rounded bg-danger text-white hover:bg-danger/90 transition-colors"
                          >
                            Ja
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(null)}
                            className="px-2 py-1 text-xs font-medium rounded bg-app-elevated text-txt-secondary hover:text-txt-primary transition-colors"
                          >
                            Nein
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(rule.id)}
                          className="p-1.5 rounded-md text-txt-muted hover:text-danger hover:bg-danger-dim transition-colors"
                          title="Löschen"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <PricingRuleForm
          initial={
            editRule
              ? {
                  productId: editRule.productId,
                  ruleType: editRule.ruleType,
                  params: editRule.params,
                  active: editRule.active,
                }
              : null
          }
          onSave={handleSave}
          onCancel={() => {
            setShowForm(false);
            setEditRule(null);
          }}
        />
      )}
    </div>
  );
};

export default PricingRuleList;
