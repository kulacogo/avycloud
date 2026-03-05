import React, { useRef, useCallback } from "react";
import { cn } from "./cn";

export interface Tab {
  id: string;
  label: string;
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({ tabs, activeTab, onTabChange, className }) => {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const enabledTabs = tabs.filter((t) => !t.disabled);
      const currentEnabledIdx = enabledTabs.findIndex((t) => t.id === tabs[index].id);
      let nextIdx = -1;

      if (e.key === "ArrowRight") {
        nextIdx = (currentEnabledIdx + 1) % enabledTabs.length;
      } else if (e.key === "ArrowLeft") {
        nextIdx = (currentEnabledIdx - 1 + enabledTabs.length) % enabledTabs.length;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = enabledTabs.length - 1;
      }

      if (nextIdx >= 0) {
        e.preventDefault();
        const nextTab = enabledTabs[nextIdx];
        const realIdx = tabs.findIndex((t) => t.id === nextTab.id);
        tabRefs.current[realIdx]?.focus();
        onTabChange(nextTab.id);
      }
    },
    [tabs, onTabChange]
  );

  return (
    <div className={cn("flex items-center gap-1 border-b border-app-border", className)} role="tablist">
      {tabs.map((tab, i) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            ref={(el) => { tabRefs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={cn(
              "relative px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap",
              isActive
                ? "text-accent"
                : "text-txt-muted hover:text-txt-primary",
              tab.disabled && "opacity-40 cursor-not-allowed"
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={cn(
                "ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-md px-1 text-[10px] font-bold",
                isActive ? "bg-accent-dim text-accent" : "bg-app-elevated text-txt-muted"
              )}>
                {tab.count}
              </span>
            )}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
};

export interface TabPanelProps {
  tabId: string;
  activeTab: string;
  children: React.ReactNode;
  className?: string;
}

export const TabPanel: React.FC<TabPanelProps> = ({ tabId, activeTab, children, className }) => {
  if (tabId !== activeTab) return null;
  return (
    <div id={`tabpanel-${tabId}`} role="tabpanel" aria-labelledby={tabId} className={className}>
      {children}
    </div>
  );
};

Tabs.displayName = "Tabs";
export default Tabs;
