import React from "react";
import {
  adminActivateLlmVersion,
  adminCreateLlmVersion,
  adminGetLlmScope,
  adminListLlmScopes,
  type AdminLlmGenerationConfig,
  type AdminLlmMediaResolution,
  type AdminLlmScopeRecord,
  type AdminLlmScopeVersionInput,
  type AdminLlmThinkingLevel,
} from "../../api/client";
import { Notice } from "../ui/Notice";

type AdminTab = "version" | "tenant";

type GenerationConfigFormState = {
  temperature: string;
  maxOutputTokens: string;
  thinkingLevel: AdminLlmThinkingLevel;
  mediaResolution: AdminLlmMediaResolution;
};

const EMPTY_GENERATION_CONFIG: GenerationConfigFormState = {
  temperature: "",
  maxOutputTokens: "",
  thinkingLevel: "",
  mediaResolution: "",
};

const MODEL_OVERRIDE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Inherit (global default)" },
  { value: "gemini-3.7-flash", label: "gemini-3.7-flash (Politik-Modell)" },
  // Alt-Namen bleiben waehlbar, werden aber von der zentralen Modellpolitik
  // (backend/lib/model-select.js) beim Lesen auf das Politik-Modell normalisiert.
  { value: "gemini-2.5-pro", label: "gemini-2.5-pro (wird normalisiert)" },
  { value: "gemini-2.5-flash", label: "gemini-2.5-flash (wird normalisiert)" },
];

const THINKING_LEVEL_OPTIONS: ReadonlyArray<{ value: AdminLlmThinkingLevel; label: string }> = [
  { value: "", label: "Inherit" },
  { value: "none", label: "none" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
];

const MEDIA_RESOLUTION_OPTIONS: ReadonlyArray<{ value: AdminLlmMediaResolution; label: string }> = [
  { value: "", label: "Inherit" },
  { value: "LOW", label: "LOW" },
  { value: "MEDIUM", label: "MEDIUM" },
  { value: "HIGH", label: "HIGH" },
];

// Tenants placeholder — kein /api/admin/tenants Endpoint vorhanden (Stand 2026-05).
const TENANT_PLACEHOLDERS: ReadonlyArray<string> = ["trendocean", "avycloud"];

function buildGenerationConfigPayload(form: GenerationConfigFormState): AdminLlmGenerationConfig | undefined {
  const payload: AdminLlmGenerationConfig = {};
  const tempStr = form.temperature.trim();
  if (tempStr !== "") {
    const t = Number(tempStr);
    if (!Number.isNaN(t)) payload.temperature = t;
  }
  const maxStr = form.maxOutputTokens.trim();
  if (maxStr !== "") {
    const m = Number(maxStr);
    if (!Number.isNaN(m)) payload.maxOutputTokens = m;
  }
  if (form.thinkingLevel) {
    payload.thinkingConfig = { level: form.thinkingLevel };
  }
  if (form.mediaResolution) {
    payload.mediaResolution = form.mediaResolution;
  }
  return Object.keys(payload).length ? payload : undefined;
}

function hydrateGenerationConfigForm(cfg: AdminLlmGenerationConfig | null | undefined): GenerationConfigFormState {
  if (!cfg || typeof cfg !== "object") return { ...EMPTY_GENERATION_CONFIG };
  return {
    temperature:
      typeof cfg.temperature === "number" && !Number.isNaN(cfg.temperature) ? String(cfg.temperature) : "",
    maxOutputTokens:
      typeof cfg.maxOutputTokens === "number" && !Number.isNaN(cfg.maxOutputTokens)
        ? String(cfg.maxOutputTokens)
        : "",
    thinkingLevel: (cfg.thinkingConfig?.level as AdminLlmThinkingLevel) || "",
    mediaResolution: (cfg.mediaResolution as AdminLlmMediaResolution) || "",
  };
}

export const AdminLlmManagement: React.FC = () => {
  const [scopes, setScopes] = React.useState<AdminLlmScopeRecord[]>([]);
  const [selectedScopeId, setSelectedScopeId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<AdminTab>("version");

  const [promptText, setPromptText] = React.useState("");
  const [rulesText, setRulesText] = React.useState("");
  const [promptMode, setPromptMode] = React.useState<"append" | "replace">("append");
  const [rulesMode, setRulesMode] = React.useState<"append" | "replace">("append");
  const [note, setNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: "success" | "info" | "warning" | "error"; title: string; details?: string } | null>(null);

  // F.1a additive form fields
  const [userTemplate, setUserTemplate] = React.useState("");
  const [outputSchemaHint, setOutputSchemaHint] = React.useState("");
  const [modelOverride, setModelOverride] = React.useState("");
  const [genConfig, setGenConfig] = React.useState<GenerationConfigFormState>({ ...EMPTY_GENERATION_CONFIG });

  const loadScopes = React.useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const list = await adminListLlmScopes();
      const sorted = [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      setScopes(sorted);
      if (!selectedScopeId && sorted.length) setSelectedScopeId(sorted[0].id);
    } catch (e: any) {
      setError(e?.message || "Failed to load scopes");
    } finally {
      setLoading(false);
    }
  }, [selectedScopeId]);

  const loadDetail = React.useCallback(async (scopeId: string) => {
    setError(null);
    setLoading(true);
    try {
      const d = await adminGetLlmScope(scopeId);
      setDetail(d);
      // Prefill editor with the active version so current prompts/rules are visible.
      const active =
        d?.scope?.activeVersionId && Array.isArray(d?.versions)
          ? d.versions.find((v: any) => String(v?.id) === String(d.scope.activeVersionId))
          : undefined;

      setPromptText(active?.promptText || "");
      setRulesText(active?.rulesText || "");
      setPromptMode(active?.promptMode === "replace" ? "replace" : "append");
      setRulesMode(active?.rulesMode === "replace" ? "replace" : "append");
      setNote(active?.note || "");
      setUserTemplate(active?.userTemplate || "");
      setOutputSchemaHint(active?.outputSchemaHint || "");
      setModelOverride(active?.modelOverride || "");
      setGenConfig(hydrateGenerationConfigForm(active?.generationConfig));
    } catch (e: any) {
      setError(e?.message || "Failed to load scope");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadScopes();
  }, [loadScopes]);

  React.useEffect(() => {
    if (selectedScopeId) {
      loadDetail(selectedScopeId);
    }
  }, [selectedScopeId, loadDetail]);

  const createVersion = async () => {
    if (!selectedScopeId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload: AdminLlmScopeVersionInput = {
        promptText,
        rulesText,
        promptMode,
        rulesMode,
        note: note || undefined,
      };
      const trimmedTemplate = userTemplate.trim();
      if (trimmedTemplate) payload.userTemplate = userTemplate;
      const trimmedSchema = outputSchemaHint.trim();
      if (trimmedSchema) payload.outputSchemaHint = outputSchemaHint;
      if (modelOverride) payload.modelOverride = modelOverride;
      const generationConfig = buildGenerationConfigPayload(genConfig);
      if (generationConfig) payload.generationConfig = generationConfig;

      await adminCreateLlmVersion(selectedScopeId, payload);
      await loadDetail(selectedScopeId);
      setNotice({ tone: "success", title: "Neue Version gespeichert und aktiviert" });
    } catch (e: any) {
      setError(e?.message || "Failed to save version");
    } finally {
      setSaving(false);
    }
  };

  const activate = async (versionId: string) => {
    if (!selectedScopeId) return;
    setSaving(true);
    setError(null);
    try {
      await adminActivateLlmVersion(selectedScopeId, versionId);
      await loadDetail(selectedScopeId);
    } catch (e: any) {
      setError(e?.message || "Failed to activate");
    } finally {
      setSaving(false);
    }
  };

  const scope = detail?.scope;
  const versions = Array.isArray(detail?.versions) ? detail.versions : [];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold">Admin: LLM Management</h2>
        <p className="text-sm text-txt-muted">
          Listet die vorhandenen LLM-Einsatzbereiche (Scopes) und erlaubt Prompt/Rules Edits mit Versionierung.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {notice ? (
        <Notice tone={notice.tone} title={notice.title} details={notice.details} onDismiss={() => setNotice(null)} />
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="rounded-2xl border border-app-border bg-app-surface p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Scopes</h3>
            <button
              type="button"
              onClick={loadScopes}
              disabled={loading}
              className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-3 py-2 text-sm font-semibold text-txt-primary"
            >
              Refresh
            </button>
          </div>
          <div className="space-y-1">
            {scopes.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedScopeId(s.id)}
                className={`w-full text-left rounded-xl px-3 py-2 text-sm transition-colors ${
                  selectedScopeId === s.id ? "bg-accent/50 text-txt-primary" : "bg-app-bg/30 text-txt-secondary hover:bg-app-elevated/40"
                }`}
              >
                <div className="font-semibold">{s.name || s.id}</div>
                <div className="text-xs text-txt-muted">{s.id}</div>
              </button>
            ))}
            {scopes.length === 0 && <div className="text-sm text-txt-muted">Keine Scopes.</div>}
          </div>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-app-border bg-app-surface p-5 space-y-4">
          <div className="space-y-1">
            <div className="text-sm font-semibold">{scope?.name || scope?.id || "—"}</div>
            <div className="text-xs text-txt-muted">{scope?.purpose || ""}</div>
            <div className="text-xs text-txt-muted">
              Default Model Env: <code>{scope?.defaultModelEnvKey || "—"}</code> · Active Version:{" "}
              <code>{scope?.activeVersionId || "—"}</code>
            </div>
          </div>

          <div role="tablist" aria-label="LLM Scope Editor Tabs" className="flex flex-wrap gap-2 border-b border-app-border pb-1">
            <button
              role="tab"
              type="button"
              aria-selected={activeTab === "version"}
              onClick={() => setActiveTab("version")}
              className={`rounded-t-xl px-3 py-2 text-xs font-semibold transition-colors ${
                activeTab === "version"
                  ? "bg-accent/40 text-txt-primary"
                  : "bg-app-bg/30 text-txt-secondary hover:bg-app-elevated/40"
              }`}
            >
              Version Editor
            </button>
            <button
              role="tab"
              type="button"
              aria-selected={activeTab === "tenant"}
              onClick={() => setActiveTab("tenant")}
              className={`rounded-t-xl px-3 py-2 text-xs font-semibold transition-colors ${
                activeTab === "tenant"
                  ? "bg-accent/40 text-txt-primary"
                  : "bg-app-bg/30 text-txt-secondary hover:bg-app-elevated/40"
              }`}
            >
              Tenant-Overrides
            </button>
          </div>

          {activeTab === "version" ? (
            <>
              {scope?.activeVersionId && (
                <div className="rounded-xl border border-app-border bg-app-bg/40 p-3 text-xs text-txt-secondary">
                  <div className="flex flex-wrap gap-3 items-center">
                    <span className="font-semibold text-txt-primary">Aktive Version:</span>
                    <span className="text-txt-primary">{scope.activeVersionId}</span>
                  </div>
                  <p className="mt-2 text-txt-muted">
                    Felder unten sind mit der aktuell aktiven Version vorbelegt. Änderungen werden als neue Version
                    gespeichert und automatisch aktiviert.
                  </p>
                </div>
              )}

              <div className="rounded-xl border border-app-border bg-app-bg/20 p-4 space-y-3">
                <div className="flex flex-wrap gap-3">
                  <label className="text-xs text-txt-secondary" htmlFor="llm-prompt-mode">
                    Prompt Mode
                    <select
                      id="llm-prompt-mode"
                      className="ml-2 bg-app-bg/60 border border-app-border rounded-xl px-2 py-1 text-txt-primary"
                      value={promptMode}
                      onChange={(e) => setPromptMode(e.target.value as any)}
                    >
                      <option value="append">append</option>
                      <option value="replace">replace</option>
                    </select>
                  </label>
                  <label className="text-xs text-txt-secondary" htmlFor="llm-rules-mode">
                    Rules Mode
                    <select
                      id="llm-rules-mode"
                      className="ml-2 bg-app-bg/60 border border-app-border rounded-xl px-2 py-1 text-txt-primary"
                      value={rulesMode}
                      onChange={(e) => setRulesMode(e.target.value as any)}
                    >
                      <option value="append">append</option>
                      <option value="replace">replace</option>
                    </select>
                  </label>
                </div>
                <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-prompt-text">
                  <span>Prompt Text (delta)</span>
                  <textarea
                    id="llm-prompt-text"
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    rows={6}
                    className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent font-mono text-xs"
                  />
                </label>
                <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-rules-text">
                  <span>Rules Text (delta)</span>
                  <textarea
                    id="llm-rules-text"
                    value={rulesText}
                    onChange={(e) => setRulesText(e.target.value)}
                    rows={6}
                    className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent font-mono text-xs"
                  />
                </label>

                {/* F.1a — userTemplate */}
                <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-user-template">
                  <span>User Template (optional)</span>
                  <textarea
                    id="llm-user-template"
                    aria-describedby="llm-user-template-hint"
                    value={userTemplate}
                    onChange={(e) => setUserTemplate(e.target.value)}
                    rows={4}
                    className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent font-mono text-xs"
                    placeholder="z.B. Beschreibe das Produkt {{productName}} (EAN {{ean}})."
                  />
                  <span id="llm-user-template-hint" className="block text-[11px] text-txt-muted">
                    Template-String mit <code>{"{{productName}}"}</code>-Placeholders. Leer = kein Template.
                  </span>
                </label>

                {/* F.1a — outputSchemaHint */}
                <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-output-schema-hint">
                  <span>Output Schema Hint (optional)</span>
                  <textarea
                    id="llm-output-schema-hint"
                    aria-describedby="llm-output-schema-hint-hint"
                    value={outputSchemaHint}
                    onChange={(e) => setOutputSchemaHint(e.target.value)}
                    rows={5}
                    spellCheck={false}
                    className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent font-mono text-xs"
                    placeholder='{"type":"object","properties":{"title":{"type":"string"}}}'
                  />
                  <span id="llm-output-schema-hint-hint" className="block text-[11px] text-txt-muted">
                    JSON-Schema-Hint für zod-Validation (Phase F.3). Leer = keine Validation.
                  </span>
                </label>

                {/* F.1a — modelOverride */}
                <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-model-override">
                  <span>Model Override (optional)</span>
                  <select
                    id="llm-model-override"
                    aria-describedby="llm-model-override-hint"
                    value={modelOverride}
                    onChange={(e) => setModelOverride(e.target.value)}
                    className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent"
                  >
                    {MODEL_OVERRIDE_OPTIONS.map((opt) => (
                      <option key={opt.value || "_inherit"} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <span id="llm-model-override-hint" className="block text-[11px] text-txt-muted">
                    Leer = nutze globalen Default aus <code>gemini-config.js</code>.
                  </span>
                </label>

                {/* F.1a — generationConfig group */}
                <fieldset className="rounded-xl border border-app-border bg-app-bg/30 p-3 space-y-3">
                  <legend className="px-2 text-[11px] uppercase tracking-wide text-txt-muted">
                    Generation Config (optional, leer = inherit)
                  </legend>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-gen-temperature">
                      <span>Temperature</span>
                      <input
                        id="llm-gen-temperature"
                        aria-describedby="llm-gen-temperature-hint"
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={2}
                        step={0.1}
                        value={genConfig.temperature}
                        onChange={(e) => setGenConfig((prev) => ({ ...prev, temperature: e.target.value }))}
                        className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent"
                        placeholder="inherit"
                      />
                      <span id="llm-gen-temperature-hint" className="block text-[11px] text-txt-muted">
                        0..2, Schritt 0.1
                      </span>
                    </label>
                    <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-gen-max-tokens">
                      <span>Max Output Tokens</span>
                      <input
                        id="llm-gen-max-tokens"
                        aria-describedby="llm-gen-max-tokens-hint"
                        type="number"
                        inputMode="numeric"
                        min={256}
                        max={32000}
                        step={256}
                        value={genConfig.maxOutputTokens}
                        onChange={(e) => setGenConfig((prev) => ({ ...prev, maxOutputTokens: e.target.value }))}
                        className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent"
                        placeholder="inherit"
                      />
                      <span id="llm-gen-max-tokens-hint" className="block text-[11px] text-txt-muted">
                        256..32000, Schritt 256
                      </span>
                    </label>
                    <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-gen-thinking">
                      <span>Thinking Level</span>
                      <select
                        id="llm-gen-thinking"
                        value={genConfig.thinkingLevel}
                        onChange={(e) =>
                          setGenConfig((prev) => ({ ...prev, thinkingLevel: e.target.value as AdminLlmThinkingLevel }))
                        }
                        className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent"
                      >
                        {THINKING_LEVEL_OPTIONS.map((opt) => (
                          <option key={opt.value || "_inherit"} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-gen-media-res">
                      <span>Media Resolution</span>
                      <select
                        id="llm-gen-media-res"
                        value={genConfig.mediaResolution}
                        onChange={(e) =>
                          setGenConfig((prev) => ({ ...prev, mediaResolution: e.target.value as AdminLlmMediaResolution }))
                        }
                        className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent"
                      >
                        {MEDIA_RESOLUTION_OPTIONS.map((opt) => (
                          <option key={opt.value || "_inherit"} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </fieldset>

                <label className="block text-xs text-txt-secondary space-y-1" htmlFor="llm-version-note">
                  <span>Note (optional)</span>
                  <input
                    id="llm-version-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2 text-txt-primary outline-none focus:border-accent"
                  />
                </label>
                <button
                  type="button"
                  onClick={createVersion}
                  disabled={!selectedScopeId || saving}
                  className="rounded-xl bg-accent hover:bg-accent/80 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
                >
                  {saving ? "Speichere…" : "Neue Version speichern & aktivieren"}
                </button>
              </div>

              <div className="space-y-2">
                <div className="text-sm font-semibold">Versions</div>
                <div className="space-y-2 max-h-[260px] overflow-auto">
                  {versions.map((v: any) => (
                    <div key={v.id} className="rounded-xl border border-app-border bg-app-bg/20 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-txt-secondary">
                          <div>
                            <code>{v.id}</code> {scope?.activeVersionId === v.id ? <span className="text-accent">ACTIVE</span> : null}
                          </div>
                          {v.note ? <div className="text-txt-muted">{v.note}</div> : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => activate(v.id)}
                          disabled={saving || scope?.activeVersionId === v.id}
                          className="rounded-xl bg-app-elevated border border-white/[0.08] hover:bg-white/10 disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-txt-primary"
                        >
                          Activate
                        </button>
                      </div>
                      <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                        <div className="text-txt-muted">
                          promptMode: <code>{v.promptMode || "append"}</code>
                        </div>
                        <div className="text-txt-muted">
                          rulesMode: <code>{v.rulesMode || "append"}</code>
                        </div>
                        {v.modelOverride ? (
                          <div className="text-txt-muted">
                            model: <code>{v.modelOverride}</code>
                          </div>
                        ) : null}
                        {v.userTemplate ? (
                          <div className="text-txt-muted">userTemplate: <code>set</code></div>
                        ) : null}
                        {v.outputSchemaHint ? (
                          <div className="text-txt-muted">schemaHint: <code>set</code></div>
                        ) : null}
                        {v.generationConfig ? (
                          <div className="text-txt-muted">generationConfig: <code>set</code></div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {versions.length === 0 && <div className="text-sm text-txt-muted">Noch keine Versionen.</div>}
                </div>
              </div>
            </>
          ) : (
            <div role="tabpanel" aria-labelledby="Tenant-Overrides" className="space-y-3">
              <div className="rounded-xl border border-app-border bg-app-bg/40 p-3 text-xs text-txt-secondary">
                <div className="font-semibold text-txt-primary">Per-Tenant Overrides</div>
                <p className="mt-1 text-txt-muted">
                  Pro Tenant lassen sich Version-Pin, Model-Override und Generation-Config übersteuern.
                  <br />
                  Coming in Phase F.1a-Frontend-V2.
                </p>
              </div>
              <ul className="space-y-2">
                {TENANT_PLACEHOLDERS.map((t) => (
                  <li
                    key={t}
                    className="rounded-xl border border-app-border bg-app-bg/20 p-3 text-xs text-txt-secondary"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <code className="text-txt-primary">{t}</code>
                      <span className="text-[11px] text-txt-muted">no overrides</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
