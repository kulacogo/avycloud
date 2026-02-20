import React from 'react';
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Globe,
  Upload,
  Columns2,
  Warehouse,
  FolderOpen,
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
  productCount?: number;
  openOrderCount?: number;
}

interface NavItem {
  id: View;
  icon: React.ReactNode;
  label: string;
  badge?: number | string;
  permCheck?: () => boolean;
}

interface NavSection {
  label?: string;
  items: NavItem[];
}

export const Sidebar: React.FC<SidebarProps> = ({ currentView, setView, onClose, productCount, openOrderCount }) => {
  const { t } = useI18n();
  const { logout, hasPermission, isAdmin, user } = useAuth();

  const canProducts = hasPermission('products', 'read');
  const canOrders = hasPermission('orders', 'read') || hasPermission('orders', 'pick') || hasPermission('orders', 'pack');
  const canIdentify = hasPermission('identify', 'run');
  const canWarehouse = hasPermission('warehouse', 'read') || hasPermission('warehouse', 'write');
  const canOps = canWarehouse || canOrders || canIdentify;
  const canCategories = hasPermission('categories', 'read') || hasPermission('categories', 'write');
  const canAdmin = isAdmin || hasPermission('admin', 'users.read') || hasPermission('admin', 'roles.read') || hasPermission('admin', 'groups.read') || hasPermission('admin', 'llm.read') || hasPermission('admin', 'reports.read');

  const sections: NavSection[] = [
    {
      /* No label for MAIN - matches mockup */
      items: [
        { id: 'dashboard', icon: <LayoutDashboard size={18} />, label: t('nav.dashboard') },
        { id: 'products', icon: <Package size={18} />, label: t('nav.products'), badge: productCount || undefined, permCheck: () => canProducts },
        { id: 'ebay-listings', icon: <Globe size={18} />, label: 'eBay Listings', permCheck: () => canProducts },
      ],
    },
    {
      label: 'OPERATIONS',
      items: [
        { id: 'input', icon: <Upload size={18} />, label: t('nav.input') || 'Identifizieren', permCheck: () => canIdentify },
        { id: 'operations', icon: <Columns2 size={18} />, label: 'Stow / Pick', permCheck: () => canOps },
        { id: 'warehouse', icon: <Warehouse size={18} />, label: 'Warehouse', permCheck: () => canWarehouse },
      ],
    },
    {
      label: 'SYSTEM',
      items: [
        { id: 'categories', icon: <FolderOpen size={18} />, label: t('nav.categories'), permCheck: () => canCategories },
        { id: 'admin', icon: <Settings size={18} />, label: t('nav.admin'), permCheck: () => canAdmin },
      ],
    },
  ];

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
      {sections.map((section, idx) => {
        const visibleItems = section.items.filter((item) => !item.permCheck || item.permCheck());
        if (visibleItems.length === 0) return null;
        return (
          <React.Fragment key={idx}>
            {idx > 0 && <div className="sidebar-divider" />}
            <div className="sidebar-section">
              {section.label && <div className="sidebar-label">{section.label}</div>}
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
                  <span className="nav-label">{item.label}</span>
                  {item.badge != null && (
                    <span className="nav-badge">{typeof item.badge === 'number' && item.badge > 999 ? `${Math.round(item.badge / 1000 * 10) / 10}k` : item.badge}</span>
                  )}
                </div>
              ))}
            </div>
          </React.Fragment>
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
              {t('common.logout') || 'Abmelden'}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
};
