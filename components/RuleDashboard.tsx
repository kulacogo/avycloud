import React, { useCallback, useState } from "react";
import { useRules } from "../hooks/useRules";
import { useToast } from "../context/ToastContext";
import { RuleList } from "./rules/RuleList";
import { RuleForm } from "./rules/RuleForm";
import { RuleTemplates, type RuleTemplate } from "./rules/RuleTemplates";
import { RulePreview } from "./rules/RulePreview";
import { EmptyState } from "./ui/EmptyState";
import { Modal, ModalHeader, ModalBody } from "./ui/Modal";
import type { RuleData, RuleJobData } from "../api/client";

/* ─── KPI Card ─── */
const KpiCard: React.FC<{ label: string; value: string | number; tone?: string }> = ({ label, value, tone = "text-txt-primary" }) => (
  <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col gap-1">
    <span className="text-xs font-medium text-txt-muted uppercase tracking-wider">{label}</span>
    <span className={`text-2xl font-bold tabular-nums ${tone}`}>{value}</span>
  </div>
);

export const RuleDashboard: React.FC = () => {
  const { rules, loading, error, reload, create, update, remove, toggle, execute } = useRules();
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RuleData | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [executeModal, setExecuteModal] = useState<string | null>(null);
  const [executeBusy, setExecuteBusy] = useState(false);
  const [jobResult, setJobResult] = useState<RuleJobData | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  /* ─── KPIs ─── */
  const activeCount = rules.filter((r) => r.active).length;
  const lastRun = rules
    .map((r) => r.stats?.lastRunAt)
    .filter(Boolean)
    .sort()
    .pop();
  const totalAffected = rules.reduce((s, r) => s + (r.stats?.lastRunApplied || 0), 0);

  /* ─── Handlers ─── */

  const handleSave = useCallback(async (data: any) => {
    try {
      if (editingRule) {
        await update(editingRule.id, data);
        toast.success("Regel aktualisiert");
      } else {
        await create(data);
        toast.success("Regel erstellt");
      }
      setFormOpen(false);
      setEditingRule(null);
    } catch (err: any) {
      toast.error(err?.message || "Fehler beim Speichern");
    }
  }, [editingRule, create, update, toast]);

  const handleDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    try {
      await remove(deleteConfirm);
      toast.success("Regel gelöscht");
    } catch (err: any) {
      toast.error(err?.message || "Fehler beim Löschen");
    }
    setDeleteConfirm(null);
  }, [deleteConfirm, remove, toast]);

  const handleToggle = useCallback(async (ruleId: string) => {
    try {
      const result = await toggle(ruleId);
      toast.success(result.active ? "Regel aktiviert" : "Regel deaktiviert");
    } catch (err: any) {
      toast.error(err?.message || "Fehler beim Umschalten");
    }
  }, [toggle, toast]);

  const handleExecute = useCallback(async (mode: "execute" | "dry_run") => {
    if (!executeModal) return;
    setExecuteBusy(true);
    setJobResult(null);
    try {
      const job = await execute(executeModal, mode);
      setJobResult(job);
      if (mode === "execute" && job.status === "done") {
        toast.success(job.result?.summary || "Regel ausgeführt");
      }
    } catch (err: any) {
      toast.error(err?.message || "Ausführung fehlgeschlagen");
    } finally {
      setExecuteBusy(false);
    }
  }, [executeModal, execute, toast]);

  const handleTemplateSelect = useCallback((template: RuleTemplate) => {
    setTemplatesOpen(false);
    setEditingRule({
      id: "",
      name: template.name,
      description: template.description,
      active: true,
      conditions: template.conditions,
      actions: template.actions,
      stats: { lastRunAt: null, lastRunProducts: 0, lastRunApplied: 0, totalRuns: 0 },
      createdAt: "",
    });
    setFormOpen(true);
  }, []);

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-txt-primary">Regeln</h1>
          <p className="text-sm text-txt-muted">Automatisierungsregeln für Produktdaten</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTemplatesOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface text-txt-primary px-4 py-2.5 text-sm font-semibold hover:bg-app-elevated transition"
          >
            Vorlagen
          </button>
          <button
            type="button"
            onClick={() => { setEditingRule(null); setFormOpen(true); }}
            className="inline-flex items-center gap-2 rounded-xl bg-accent text-white px-4 py-2.5 text-sm font-semibold hover:bg-accent/90 transition"
          >
            + Neue Regel
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Regeln gesamt" value={rules.length} />
        <KpiCard label="Aktive Regeln" value={activeCount} tone={activeCount > 0 ? "text-success" : "text-txt-muted"} />
        <KpiCard label="Letzter Lauf" value={lastRun ? new Date(lastRun).toLocaleDateString("de-DE") : "—"} />
        <KpiCard label="Produkte betroffen" value={totalAffected} />
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-lg bg-danger-dim text-danger p-4 text-sm">{error}</div>
      ) : rules.length === 0 ? (
        <EmptyState
          title="Noch keine Regeln"
          description="Erstelle deine erste Automatisierungsregel oder wähle eine Vorlage."
          action={
            <div className="flex gap-2">
              <button type="button" onClick={() => setTemplatesOpen(true)} className="rounded-lg border border-app-border bg-app-surface text-txt-primary px-4 py-2 text-sm font-semibold hover:bg-app-elevated transition">Vorlagen</button>
              <button type="button" onClick={() => { setEditingRule(null); setFormOpen(true); }} className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-semibold hover:bg-accent/90 transition">Neue Regel</button>
            </div>
          }
        />
      ) : (
        <RuleList
          rules={rules}
          onEdit={(r) => { setEditingRule(r); setFormOpen(true); }}
          onDelete={(id) => setDeleteConfirm(id)}
          onToggle={handleToggle}
          onExecute={(id) => { setExecuteModal(id); setJobResult(null); }}
        />
      )}

      {/* Rule Form Modal */}
      <Modal open={formOpen} onClose={() => { setFormOpen(false); setEditingRule(null); }} size="lg">
        <ModalBody>
          <RuleForm
            rule={editingRule}
            onSave={handleSave}
            onCancel={() => { setFormOpen(false); setEditingRule(null); }}
          />
        </ModalBody>
      </Modal>

      {/* Templates Modal */}
      <Modal open={templatesOpen} onClose={() => setTemplatesOpen(false)} size="lg">
        <ModalBody>
          <RuleTemplates onSelect={handleTemplateSelect} onClose={() => setTemplatesOpen(false)} />
        </ModalBody>
      </Modal>

      {/* Execute Modal */}
      <Modal open={!!executeModal} onClose={() => { setExecuteModal(null); setJobResult(null); }} size="lg">
        <ModalHeader onClose={() => { setExecuteModal(null); setJobResult(null); }}>Regel ausführen</ModalHeader>
        <ModalBody>
          <div className="space-y-4">
            {jobResult ? (
              <div className="space-y-3">
                <div className="text-sm text-txt-primary font-medium">{jobResult.result?.summary || `Status: ${jobResult.status}`}</div>
                {jobResult.result?.changes && jobResult.result.changes.length > 0 && (
                  <RulePreview changes={jobResult.result.changes} mode={jobResult.mode} />
                )}
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleExecute("dry_run")}
                  disabled={executeBusy}
                  className="rounded-lg border border-app-border bg-app-surface text-txt-primary px-4 py-2 text-sm font-semibold hover:bg-app-elevated transition disabled:opacity-50"
                >
                  {executeBusy ? "Läuft..." : "Vorschau (Dry Run)"}
                </button>
                <button
                  type="button"
                  onClick={() => handleExecute("execute")}
                  disabled={executeBusy}
                  className="rounded-lg bg-accent text-white px-4 py-2 text-sm font-semibold hover:bg-accent/90 transition disabled:opacity-50"
                >
                  {executeBusy ? "Läuft..." : "Jetzt ausführen"}
                </button>
              </div>
            )}
          </div>
        </ModalBody>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} size="sm">
        <ModalHeader onClose={() => setDeleteConfirm(null)}>Regel löschen?</ModalHeader>
        <ModalBody>
          <p className="text-sm text-txt-secondary mb-4">Diese Aktion kann nicht rückgängig gemacht werden.</p>
          <div className="flex items-center justify-end gap-3">
            <button type="button" onClick={() => setDeleteConfirm(null)} className="rounded-lg border border-app-border bg-app-surface text-txt-primary px-4 py-2 text-sm font-semibold hover:bg-app-elevated transition">Abbrechen</button>
            <button type="button" onClick={handleDelete} className="rounded-lg bg-danger text-white px-4 py-2 text-sm font-semibold hover:bg-danger/90 transition">Löschen</button>
          </div>
        </ModalBody>
      </Modal>
    </div>
  );
};

export default RuleDashboard;
