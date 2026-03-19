import React, { useState, useCallback } from "react";
import { usePricingRules } from "../hooks/usePricingRules";
import PricingRuleList from "./pricing/PricingRuleList";
import PricingSuggestions from "./pricing/PricingSuggestions";
import { saveProduct } from "../api/client";

type Tab = "rules" | "suggestions";

const PricingDashboard: React.FC = () => {
  const { rules, loading, error, addRule, deleteRule, toggleRule } = usePricingRules();
  const [activeTab, setActiveTab] = useState<Tab>("rules");

  const activeRulesCount = rules.filter((r) => r.active).length;
  const inactiveRulesCount = rules.filter((r) => !r.active).length;

  const handleAcceptSuggestion = useCallback(
    async (productId: string, suggestedPrice: number) => {
      await saveProduct({
        id: productId,
        details: {
          pricing: {
            sellPrice: suggestedPrice,
          },
        },
      } as any);
    },
    []
  );

  const handleSaveRule = useCallback(
    async (data: { productId: string; ruleType: string; params?: Record<string, any> }) => {
      await addRule(data);
    },
    [addRule]
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: "rules", label: "Regeln" },
    { id: "suggestions", label: "Vorschläge" },
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-bold text-txt-primary">Preise</h1>
        <p className="text-sm text-txt-secondary mt-0.5">
          Preisregeln verwalten und Repricing-Vorschläge prüfen
        </p>
      </div>

      {/* KPI bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-app-surface border border-app-border rounded-md px-4 py-3">
          <p className="text-xs text-txt-muted uppercase tracking-wider">Aktive Regeln</p>
          <p className="text-2xl font-bold text-txt-primary mt-1">{activeRulesCount}</p>
        </div>
        <div className="bg-app-surface border border-app-border rounded-md px-4 py-3">
          <p className="text-xs text-txt-muted uppercase tracking-wider">Inaktive Regeln</p>
          <p className="text-2xl font-bold text-txt-secondary mt-1">{inactiveRulesCount}</p>
        </div>
        <div className="bg-app-surface border border-app-border rounded-md px-4 py-3">
          <p className="text-xs text-txt-muted uppercase tracking-wider">Gesamt</p>
          <p className="text-2xl font-bold text-txt-primary mt-1">{rules.length}</p>
        </div>
        <div className="bg-app-surface border border-app-border rounded-md px-4 py-3">
          <p className="text-xs text-txt-muted uppercase tracking-wider">Strategie-Mix</p>
          <p className="text-sm font-medium text-txt-secondary mt-1.5">
            {rules.length > 0
              ? [...new Set(rules.map((r) => r.ruleType))].length + " Strategien"
              : "--"}
          </p>
        </div>
      </div>

      {error && (
        <div className="text-sm text-danger px-3 py-2 bg-danger-dim rounded-md">{error}</div>
      )}

      {/* Tabs */}
      <div className="border-b border-app-border">
        <div className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-2.5 text-sm font-medium transition-colors border-b-2 ${
                activeTab === tab.id
                  ? "border-accent text-accent"
                  : "border-transparent text-txt-secondary hover:text-txt-primary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "rules" && (
        <PricingRuleList
          rules={rules}
          loading={loading}
          onToggle={toggleRule}
          onDelete={deleteRule}
          onSave={handleSaveRule}
        />
      )}

      {activeTab === "suggestions" && (
        <PricingSuggestions onAccept={handleAcceptSuggestion} />
      )}
    </div>
  );
};

export default PricingDashboard;
