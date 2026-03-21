import React from 'react';
import { useI18n } from '../i18n';
import { useAuth } from '../context/AuthContext';

type MobileTab = 'home' | 'search' | 'operations';

interface MobileTabBarProps {
  currentView: string;
  onNavigate: (view: MobileTab) => void;
  theme: 'light' | 'dark';
}

/* ─── Inline SVG Icons (replace pixelated PNGs) ─── */
const TabIcon: React.FC<{ id: MobileTab; active: boolean }> = ({ id, active }) => {
  const cls = `w-6 h-6 ${active ? 'text-accent' : 'text-current'}`;
  switch (id) {
    case 'home':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      );
    case 'search':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      );
    case 'operations':
      return (
        <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <line x1="8" y1="8" x2="16" y2="8" />
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="16" x2="12" y2="16" />
        </svg>
      );
  }
};

const tabs: { id: MobileTab; labelKey: string }[] = [
  { id: 'home', labelKey: 'nav.home' },
  { id: 'search', labelKey: 'nav.search' },
  { id: 'operations', labelKey: 'nav.operations' },
];

const isActive = (current: string, tab: MobileTab) => {
  if (tab === 'operations') {
    return current.startsWith('operations');
  }
  return current === tab || (tab === 'home' && current === 'dashboard');
};

const MobileTabBar: React.FC<MobileTabBarProps> = ({ currentView, onNavigate }) => {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const visibleTabs = React.useMemo(() => {
    const canOps =
      hasPermission('warehouse', 'read') ||
      hasPermission('warehouse', 'write') ||
      hasPermission('orders', 'read') ||
      hasPermission('orders', 'pick') ||
      hasPermission('orders', 'pack') ||
      hasPermission('identify', 'run');
    return tabs.filter((tab) => (tab.id === 'operations' ? canOps : true));
  }, [hasPermission]);
  return (
    <nav
      className="bg-app-sidebar/95 backdrop-blur-lg border-t border-app-border px-4 py-2 flex justify-around gap-2 safe-area-bottom shadow-app"
      role="tablist"
      aria-label="Navigation"
    >
      {visibleTabs.map((tab) => {
        const active = isActive(currentView, tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            onClick={() => onNavigate(tab.id)}
            className={`flex flex-col items-center justify-center flex-1 min-h-[48px] min-w-[48px] rounded-xl px-3 py-2 text-xs font-semibold transition-all active:scale-95 ${
              active ? 'bg-accent-dim text-accent' : 'text-txt-secondary hover:bg-app-elevated/60'
            }`}
            aria-selected={active}
            aria-label={t(tab.labelKey)}
          >
            <TabIcon id={tab.id} active={active} />
            <span className="mt-1">{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileTabBar;
