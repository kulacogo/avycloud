import React from 'react';
import { LayoutDashboard, Search, Layers } from 'lucide-react';
import { useI18n } from '../i18n';
import { useAuth } from '../context/AuthContext';

type MobileTab = 'home' | 'search' | 'operations';

interface MobileTabBarProps {
  currentView: string;
  onNavigate: (view: MobileTab) => void;
  theme: 'light' | 'dark';
}

const tabIcons: Record<MobileTab, React.ReactNode> = {
  home: <LayoutDashboard className="mobile-tab-icon" />,
  search: <Search className="mobile-tab-icon" />,
  operations: <Layers className="mobile-tab-icon" />,
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
    <nav className="mobile-tab-bar">
      {visibleTabs.map((tab) => {
        const active = isActive(currentView, tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onNavigate(tab.id)}
            className={`mobile-tab-btn${active ? ' active' : ''}`}
            aria-current={active ? 'page' : undefined}
            aria-label={t(tab.labelKey)}
          >
            {tabIcons[tab.id]}
            <span className="mobile-tab-label">{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileTabBar;
