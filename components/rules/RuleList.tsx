import React from "react";
import type { RuleData } from "../../api/client";

interface Props {
  rules: RuleData[];
  onEdit: (rule: RuleData) => void;
  onDelete: (ruleId: string) => void;
  onToggle: (ruleId: string) => void;
  onExecute: (ruleId: string) => void;
}

export const RuleList: React.FC<Props> = ({ rules, onEdit, onDelete, onToggle, onExecute }) => (
  <div className="rounded-2xl border border-app-border bg-app-surface overflow-hidden">
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-app-border bg-app-bg/50">
          <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Name</th>
          <th className="text-center px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Bedingungen</th>
          <th className="text-center px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Aktionen</th>
          <th className="text-center px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Aktiv</th>
          <th className="text-left px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Letzter Lauf</th>
          <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider">Betroffen</th>
          <th className="text-right px-4 py-3 text-xs font-semibold text-txt-muted uppercase tracking-wider"></th>
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <tr key={rule.id} className={`border-b border-app-border last:border-0 hover:bg-app-elevated/50 transition ${!rule.active ? "opacity-50" : ""}`}>
            <td className="px-4 py-3">
              <div className="font-medium text-txt-primary">{rule.name}</div>
              {rule.description && <div className="text-xs text-txt-muted mt-0.5">{rule.description}</div>}
            </td>
            <td className="px-4 py-3 text-center">
              <span className="inline-flex items-center rounded-md bg-info-dim text-info px-2 py-0.5 text-xs font-semibold">
                {rule.conditions?.length || 0}
              </span>
            </td>
            <td className="px-4 py-3 text-center">
              <span className="inline-flex items-center rounded-md bg-accent-dim text-accent px-2 py-0.5 text-xs font-semibold">
                {rule.actions?.length || 0}
              </span>
            </td>
            <td className="px-4 py-3 text-center">
              <button
                type="button"
                onClick={() => onToggle(rule.id)}
                className={`relative w-10 h-5 rounded-full transition-colors ${rule.active ? "bg-accent" : "bg-app-border"}`}
                aria-label={rule.active ? "Deaktivieren" : "Aktivieren"}
              >
                <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${rule.active ? "left-[22px]" : "left-0.5"}`} />
              </button>
            </td>
            <td className="px-4 py-3 text-txt-muted text-xs">
              {rule.stats?.lastRunAt
                ? new Date(rule.stats.lastRunAt).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })
                : "—"}
            </td>
            <td className="px-4 py-3 text-right text-txt-secondary tabular-nums text-xs">
              {rule.stats?.lastRunApplied ?? 0}
            </td>
            <td className="px-4 py-3 text-right">
              <div className="flex items-center justify-end gap-1">
                <button type="button" onClick={() => onExecute(rule.id)} className="rounded-lg bg-accent-dim p-1.5 text-accent hover:opacity-80 transition" title="Ausführen">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><polygon points="5 3 19 12 5 21 5 3" /></svg>
                </button>
                <button type="button" onClick={() => onEdit(rule)} className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-txt-primary transition" title="Bearbeiten">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                </button>
                <button type="button" onClick={() => onDelete(rule.id)} className="rounded-lg bg-app-elevated p-1.5 text-txt-muted hover:text-danger transition" title="Löschen">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
