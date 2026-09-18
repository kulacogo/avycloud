import React, { useEffect, useRef } from "react";
import type { ProductWorkspaceState } from "../utils/productWorkspace";

export function ProductWorkspaceTabs({ workspace, onActivate, onClose }: {
  workspace: ProductWorkspaceState; onActivate: (id: string | null) => void; onClose: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previousCount = useRef(workspace.products.length);
  useEffect(() => {
    if (workspace.products.length < previousCount.current) {
      root.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
    }
    previousCount.current = workspace.products.length;
  }, [workspace.products.length]);
  const tabs = [{ id: null, label: "Übersicht", sku: "" }, ...workspace.products.map(p => ({
    id: p.id, label: p.identification?.name || p.id, sku: p.identification?.sku || "",
  }))];
  return <div ref={root} role="tablist" aria-label="Geöffnete Produktdatenblätter"
    className="mb-3 flex gap-1 overflow-x-auto border-b border-app-border"
    onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (target.getAttribute("role") !== "tab") return;
      const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || []);
      const index = buttons.indexOf(target as HTMLButtonElement);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next !== null) { event.preventDefault(); onActivate(tabs[next].id); buttons[next]?.focus(); }
      if (event.key === "Delete" && tabs[index]?.id) { event.preventDefault(); onClose(tabs[index].id!); }
    }}>
    {tabs.map(tab => {
      const active = workspace.activeId === tab.id;
      const dirty = tab.id && workspace.dirtyIds.includes(tab.id);
      return <div key={tab.id || "overview"} className={`group flex max-w-[180px] shrink-0 items-center border-b-2 ${active ? "border-accent bg-accent-dim" : "border-transparent hover:bg-app-surface"} rounded-t-md`}>
        <button type="button" role="tab" id={`workspace-tab-${tab.id || "overview"}`} aria-controls={`workspace-panel-${tab.id || "overview"}`} aria-selected={active}
          tabIndex={active ? 0 : -1} onClick={() => onActivate(tab.id)} title={[tab.label, tab.sku].filter(Boolean).join(" · ")}
          className={`flex h-9 min-w-0 items-center gap-1.5 px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${active ? "text-accent" : "text-txt-secondary"}`}>
          {tab.id && <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 12h8M8 16h6" /></svg>}
          <span className="max-w-[112px] truncate">{tab.label}</span>
          {dirty && <span className="shrink-0 text-warning" aria-label="Ungespeicherte Änderungen">●</span>}
        </button>
        {tab.id && <button type="button" onClick={() => onClose(tab.id!)} aria-label={`Datenblatt schließen: ${tab.label}`} title="Datenblatt schließen" className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-txt-muted hover:bg-app-elevated hover:text-txt-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">×</button>}
      </div>;
    })}
  </div>;
}
