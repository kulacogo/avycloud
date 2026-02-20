import React from 'react';
import {
  LayoutDashboard,
  Package,
  ScanBarcode,
  Warehouse,
  Truck,
  Store,
  Tags,
  Settings,
  LogOut,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useAuth } from '../context/AuthContext';

type View =
  | 'dashboard'
  | 'home'
  | 'search'
  | 'input'
  | 'sheet'
  | 'inventory'
  | 'products'
  | 'admin'
  | 'categories'
  | 'ebay-listings'
  | 'warehouse'
  | 'operations'
  | 'operations-identify'
  | 'operations-stow'
  | 'operations-pick'
  | 'operations-pack';

interface SidebarProps {
  currentView: View;
  setView: (view: View) => void;
  onClose?: () => void;
}

interface NavItem {
  id: View;
  icon: React.ReactNode;
  labelKey: string;
}

interface NavSection {
  labelKey: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    labelKey: 'nav.section.main',
    items: [
      { id: 'dashboard', icon: <LayoutDashboard size={18} />, labelKey: 'nav.dashboard' },
      { id: 'products', icon: <Package size={18} />, labelKey: 'nav.products' },
    ],
  },
  {
    labelKey: 'nav.section.operations',
    items: [
      { id: 'input', icon: <ScanBarcode size={18} />, labelKey: 'nav.input' },
      { id: 'warehouse', icon: <Warehouse size={18} />, labelKey: 'nav.warehouse' },
      { id: 'operations', icon: <Truck size={18} />, labelKey: 'nav.operations' },
    ],
  },
  {
    labelKey: 'nav.section.channels',
    items: [
      { id: 'ebay-listings', icon: <Store size={18} />, labelKey: 'nav.ebay' },
      { id: 'categories', icon: <Tags size={18} />, labelKey: 'nav.categories' },
    ],
  },
  {
    labelKey: 'nav.section.system',
    items: [
      { id: 'admin', icon: <Settings size={18} />, labelKey: 'nav.admin' },
    ],
  },
];

const SECTION_LABELS: Record<string, string> = {
  'nav.section.main': 'MAIN',
  'nav.section.operations': 'OPERATIONS',
  'nav.section.channels': 'CHANNELS',
  'nav.section.system': 'SYSTEM',
};

export const Sidebar: React.FC<SidebarProps> = ({ currentView, setView, onClose }) => {
  const { t } = useI18n();
  const { logout, hasPermission, isAdmin, user } = useAuth();

  const isNavAllowed = React.useCallback(
    (view: View) => {
      if (view === 'dashboard') return true;
      if (view === 'inventory' || view === 'products') return hasPermission('products', 'read');
      if (view === 'ebay-listings') return hasPermission('products', 'read') || hasPermission('products', 'write');
      if (view === 'input') return hasPermission('identify', 'run');
      if (view === 'categories') return hasPermission('categories', 'read') || hasPermission('categories', 'write');
      if (view === 'warehouse') return hasPermission('warehouse', 'read') || hasPermission('warehouse', 'write');
      if (view === 'operations') {
        return (
          hasPermission('warehouse', 'read') ||
          hasPermission('warehouse', 'write') ||
          hasPermission('orders', 'read') ||
          hasPermission('orders', 'pick') ||
          hasPermission('orders', 'pack') ||
          hasPermission('identify', 'run')
        );
      }
      if (view === 'admin') {
        if (isAdmin) return true;
        return (
          hasPermission('admin', 'users.read') ||
          hasPermission('admin', 'roles.read') ||
          hasPermission('admin', 'groups.read') ||
          hasPermission('admin', 'llm.read') ||
          hasPermission('admin', 'reports.read')
        );
      }
      return true;
    },
    [hasPermission, isAdmin]
  );

  const isActive = (itemView: View) => {
    if (itemView === 'operations') {
      return ['operations', 'operations-identify', 'operations-stow', 'operations-pick', 'operations-pack'].includes(currentView);
    }
    return currentView === itemView;
  };

  const handleNav = (view: View) => {
    const hashPath = view === 'ebay-listings' ? '#/ebay' : `#/${view}`;
    window.location.hash = hashPath;
    setView(view);
    onClose?.();
  };

  const userInitial = user?.email?.[0]?.toUpperCase() || 'U';
  const userName = user?.email?.split('@')[0] || 'User';

  return (
    <aside className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo">A</div>
        <span className="sidebar-brand">AvyCloud</span>
      </div>

      {/* Navigation Sections */}
      {NAV_SECTIONS.map((section) => {
        const visibleItems = section.items.filter((item) => isNavAllowed(item.id));
        if (visibleItems.length === 0) return null;
        return (
          <div key={section.labelKey} className="sidebar-section">
            <div className="sidebar-label">{SECTION_LABELS[section.labelKey] || t(section.labelKey)}</div>
            {visibleItems.map((item) => (
              <div
                key={item.id}
                className={`nav-item ${isActive(item.id) ? 'active' : ''}`}
                onClick={() => handleNav(item.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && handleNav(item.id)}
              >
                <span className="nav-icon">{item.icon}</span>
                {t(item.labelKey)}
              </div>
            ))}
          </div>
        );
      })}

      {/* Footer */}
      <div className="sidebar-footer">
        <div className="sidebar-user" onClick={() => logout()} role="button" tabIndex={0}>
          <div className="user-avatar">{userInitial}</div>
          <div>
            <div className="user-name">{userName}</div>
            <div className="user-role" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <LogOut size={11} />
              {t('common.logout')}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
