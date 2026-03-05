import React from 'react';
import homeLight from '../mobile icons/mobile home.png';
import homeDark from '../mobile icons/mobile home dm.png';
import searchLight from '../mobile icons/mobile search.png';
import searchDark from '../mobile icons/mobile search dm.png';
import opsLight from '../mobile icons/mobile operation.png';
import opsDark from '../mobile icons/mobile operation dm.png';
import { useI18n } from '../i18n';
import { useAuth } from '../context/AuthContext';

type MobileTab = 'home' | 'search' | 'operations';

interface MobileTabBarProps {
  currentView: string;
  onNavigate: (view: MobileTab) => void;
  theme: 'light' | 'dark';
}

const tabIcons = {
  home: { light: homeLight, dark: homeDark },
  search: { light: searchLight, dark: searchDark },
  operations: { light: opsLight, dark: opsDark },
} as const;

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

const MobileTabBar: React.FC<MobileTabBarProps> = ({ currentView, onNavigate, theme }) => {
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
      className="bg-app-sidebar/95 backdrop-blur-lg border-t border-app-border px-4 py-2 flex justify-around gap-2 pb-4 safe-area-bottom shadow-app"
      role="tablist"
      aria-label="Navigation"
    >
      {visibleTabs.map((tab) => {
        const active = isActive(currentView, tab.id);
        const iconSrc = theme === 'dark' ? tabIcons[tab.id].dark : tabIcons[tab.id].light;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            onClick={() => onNavigate(tab.id)}
            className={`flex flex-col items-center justify-center flex-1 rounded-md px-3 py-2 text-xs font-semibold transition ${
              active ? 'bg-accent-dim text-accent' : 'text-txt-secondary bg-app-elevated/40'
            }`}
            aria-selected={active}
            aria-label={t(tab.labelKey)}
          >
            <img src={iconSrc} alt="" className="w-[30px] h-[30px]" draggable={false} />
            <span className="mt-1">{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileTabBar;
