
import React from 'react';
import { useI18n } from '../i18n';
import { useAuth } from '../context/AuthContext';

interface HeaderProps {
  currentView:
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
    | 'operations-pack'
    ;
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
    view: 'ebay-listings',
    label: 'nav.ebay',
    iconNode: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        {/* Storefront with awning waves */}
        <path d="M3 9.5h18L18.5 5a1.5 1.5 0 0 0-1.4-1H6.9A1.5 1.5 0 0 0 5.5 5L3 9.5Z"
          stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M3 9.5C3 10.88 4.12 12 5.5 12S8 10.88 8 9.5M8 9.5C8 10.88 9.12 12 10.5 12S13 10.88 13 9.5M13 9.5c0 1.38 1.12 2.5 2.5 2.5S18 10.88 18 9.5M18 9.5c0 1.38 1.12 2.5 2.5 2.5"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"
          stroke="currentColor" strokeWidth="1.6" />
        <rect x="9" y="14" width="6" height="6" rx="0.5" stroke="currentColor" strokeWidth="1.4" />
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
  const { t, locale, setLocale } = useI18n();
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
            ? 'bg-sky-600 text-white shadow-md shadow-sky-900/40'
            : 'bg-slate-800/60 text-slate-400 hover:bg-slate-700 hover:text-white'
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

  const navIcons = React.useMemo(() => NAV_ICONS.filter((nav) => isNavAllowed(nav.view)), [isNavAllowed]);

  return (
    <>
      <header className="safe-area-header bg-slate-900/90 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/50 border-b border-white/[0.06]">
        <div className="w-full px-3 sm:px-5 lg:px-8 py-2">
          <div className="flex items-center gap-4 w-full">

            {/* Logo — slightly inset from left edge, scales at larger viewports */}
            <div className="flex-shrink-0 ml-2 sm:ml-6 lg:ml-10">
              <img
                src="/avy_logo.png"
                alt="avycloud"
                draggable={false}
                style={{ height: 'clamp(2rem, 5vw, 7rem)', width: 'auto', objectFit: 'contain' }}
              />
            </div>

            {/* Desktop Navigation */}
            <nav className="hidden sm:flex flex-1 items-center justify-center gap-1.5">
              {navIcons.map((nav) => (
                <DesktopNavButton key={nav.view} nav={nav} />
              ))}
            </nav>

            {/* Right controls */}
            <div className="flex items-center gap-2 ml-auto">

              {/* Language selector with globe icon */}
              <div className="relative flex items-center">
                <svg
                  className="absolute left-2.5 pointer-events-none text-slate-400"
                  style={{ width: '1.1rem', height: '1.1rem' }}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3.6 9h16.8M3.6 15h16.8" strokeLinecap="round" />
                  <path d="M12 3c-2.5 3-4 6-4 9s1.5 6 4 9M12 3c2.5 3 4 6 4 9s-1.5 6-4 9" strokeLinecap="round" />
                </svg>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as any)}
                  className="bg-slate-800/70 text-slate-200 font-medium pl-9 pr-3 rounded-xl border border-white/[0.08] focus:outline-none focus:border-sky-500/50 cursor-pointer appearance-none"
                  style={{ height: '3.5rem' }}
                  style={{ fontSize: '0.875rem' }}
                  aria-label={t('lang.label')}
                >
                  <option value="de">DE</option>
                  <option value="en">EN</option>
                  <option value="tr">TR</option>
                </select>
              </div>

              {/* Theme toggle */}
              <button
                type="button"
                onClick={onToggleTheme}
                className="flex items-center justify-center rounded-xl bg-slate-800/70 border border-white/[0.08] text-slate-400 hover:text-white hover:bg-slate-700 transition-all"
                style={{ width: '3.5rem', height: '3.5rem' }}
                aria-label={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
                title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
              >
                {theme === 'dark' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.1rem', height: '1.1rem' }} aria-hidden="true">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.1rem', height: '1.1rem' }} aria-hidden="true">
                    <path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8Z" />
                  </svg>
                )}
              </button>

              {/* Logout — icon only */}
              <button
                type="button"
                onClick={() => logout()}
                className="hidden sm:inline-flex items-center justify-center rounded-xl bg-slate-800/70 border border-white/[0.08] text-slate-400 hover:text-white hover:bg-slate-700 transition-all"
                style={{ width: '3.5rem', height: '3.5rem' }}
                aria-label={t('common.logout')}
                title={t('common.logout')}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: '1.3rem', height: '1.3rem' }} aria-hidden="true">
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
