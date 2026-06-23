
import React from 'react';
import { useI18n } from '../i18n';
import { useAuth } from '../context/AuthContext';
import type { View } from '../types';

interface HeaderProps {
  currentView: View;
  setView: (view: HeaderProps['currentView']) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

type NavIconConfig = {
  view: HeaderProps['currentView'];
  label: string;
  iconNode: React.ReactNode;
};

/* ─── Nav Icons — expressive, purpose-built SVGs ─── */
const NAV_ICONS: NavIconConfig[] = [
  {
    view: 'dashboard',
    label: 'nav.dashboard',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Dashboard: 4-widget grid layout */}
        <rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13" y="3" width="8" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13" y="10" width="8" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
        <rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    view: 'input',
    label: 'nav.input',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Scan frame (corner brackets) + plus — "identify / add" */}
        <path d="M8 3H5a2 2 0 0 0-2 2v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16 3h3a2 2 0 0 1 2 2v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 21H5a2 2 0 0 1-2-2v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16 21h3a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'inventory',
    label: 'nav.inventory',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Open crate / box */}
        <path d="M3 9l9-6 9 6v11H3V9Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M3 9h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M12 9v11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 9l1.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M16 9l-1.5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'products',
    label: 'nav.products',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Product catalog: list with thumbnails */}
        <rect x="3" y="4" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 6h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M10 7.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.45" />
        <rect x="3" y="11" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 13h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M10 14.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.45" />
        <rect x="3" y="18" width="4.5" height="4.5" rx="1" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10 20h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M10 21.5h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.45" />
      </svg>
    ),
  },
  {
    view: 'admin',
    label: 'nav.admin',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Shield with lock */}
        <path d="M12 2L4 5.5v6.5C4 17.11 7.41 21.37 12 22c4.59-.63 8-4.89 8-10V5.5L12 2Z"
          stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="12" cy="11.5" r="2.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 14v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'categories',
    label: 'nav.categories',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Category grid: 4 distinct app tiles */}
        <rect x="2.5" y="2.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13.5" y="2.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <rect x="2.5" y="13.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <rect x="13.5" y="13.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    ),
  },
  {
    view: 'warehouse',
    label: 'nav.warehouse',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Warehouse building with racking shelves */}
        <path d="M3 21V9L12 4l9 5v12H3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M3 21h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M9 21v-7h6v7" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M4.5 13h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M16.5 13h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M4.5 16.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M16.5 16.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'operations',
    label: 'nav.operations',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Two people — team / operations */}
        <circle cx="8" cy="7" r="3.5" stroke="currentColor" strokeWidth="1.6" />
        <path d="M1.5 21v-1.5A5.5 5.5 0 0 1 7 14h2a5.5 5.5 0 0 1 5.5 5.5V21"
          stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16 10a3.5 3.5 0 1 0 0-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M22 21v-1a5 5 0 0 0-4-4.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
] as const;

export const Header: React.FC<HeaderProps> = ({ currentView, setView, theme, onToggleTheme }) => {
  const { t } = useI18n();
  const { logout, hasPermission, isAdmin } = useAuth();

  const DesktopNavButton = ({ nav }: { nav: NavIconConfig }) => {
    const targetHash = nav.view === 'ebay-listings' ? '#/ebay' : `#/${nav.view}`;
    const isActive = currentView === nav.view;
    return (
      <a
        href={targetHash}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) return;
          e.preventDefault();
          window.location.hash = targetHash;
          setView(nav.view);
        }}
        className={`hidden sm:inline-flex items-center justify-center rounded-xl transition-all ${
          isActive
            ? 'bg-accent text-txt-primary shadow-md shadow-accent/20'
            : 'bg-app-surface text-txt-muted hover:bg-app-elevated hover:text-txt-primary'
        }`}
        style={{ width: '3.5rem', height: '3.5rem' }}
        aria-current={isActive ? 'page' : undefined}
        aria-label={t(nav.label)}
        title={t(nav.label)}
      >
        {nav.iconNode}
      </a>
    );
  };

  const isNavAllowed = React.useCallback(
    (view: NavIconConfig['view']) => {
      if (view === 'dashboard') return true;
      if (view === 'inventory') return hasPermission('products', 'read');
      if (view === 'products') return hasPermission('products', 'read');
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

  const navIcons = React.useMemo(() => NAV_ICONS.filter((nav) => isNavAllowed(nav.view)), [isNavAllowed]);

  return (
    <>
      <header className="safe-area-header bg-app-bg/90 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/50 border-b border-white/[0.06]">
        <div className="w-full px-3 sm:px-5 lg:px-8 py-1.5">
          <div className="flex items-center gap-4 w-full h-[50px]">

            {/* Logo — Wortmarke "avycloud" (Light/Dark via logo-light/logo-dark) */}
            <div className="flex-shrink-0 sm:ml-2 lg:ml-4">
              <img
                src="/avycloud_logo_name_darkmode.png"
                alt="avycloud"
                draggable={false}
                className="h-9 object-contain logo-dark"
              />
              <img
                src="/avycloud_logo_name.png"
                alt="avycloud"
                draggable={false}
                className="h-9 object-contain logo-light"
              />
            </div>

            {/* Desktop Navigation */}
            <nav className="hidden sm:flex flex-1 items-center justify-center gap-1.5">
              {navIcons.map((nav) => (
                <DesktopNavButton key={nav.view} nav={nav} />
              ))}
            </nav>

            {/* Right controls */}
            <div className="flex items-center justify-start box-content text-left gap-px ml-auto">

              {/* Theme toggle */}
              <button
                type="button"
                onClick={onToggleTheme}
                className="flex items-center justify-center rounded-lg bg-[var(--page-bg)] border-0 border-transparent text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-all"
                style={{ width: '2.25rem', height: '2.25rem', borderImage: 'none' }}
                aria-label={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
                title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
              >
                {theme === 'dark' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: '0.9rem', height: '0.9rem' }} aria-hidden="true">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: '0.9rem', height: '0.9rem' }} aria-hidden="true">
                    <path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8Z" />
                  </svg>
                )}
              </button>

              {/* Logout — icon only */}
              <button
                type="button"
                onClick={() => logout()}
                className="hidden sm:inline-flex items-center justify-center rounded-xl bg-transparent border-0 border-transparent text-txt-muted hover:text-txt-primary hover:bg-app-elevated transition-all"
                style={{ width: '3.5rem', height: '3.5rem', borderImage: 'none' }}
                aria-label={t('common.logout')}
                title={t('common.logout')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: '20px', height: '20px' }} aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </header>
    </>
  );
};
