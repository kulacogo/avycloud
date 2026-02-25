
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

const NAV_ICONS: NavIconConfig[] = [
  {
    view: 'dashboard',
    label: 'nav.dashboard',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9 21V12h6v9" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    view: 'input',
    label: 'nav.input',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.7" />
        <path d="M11 8v6M8 11h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'inventory',
    label: 'nav.inventory',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2" y="7" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M12 12v4M10 14h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'products',
    label: 'nav.products',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M7 6h14M7 12h14M7 18h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'admin',
    label: 'nav.admin',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3l7 4v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9.5 12.3l1.8 1.8 3.7-3.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    view: 'categories',
    label: 'nav.categories',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 6.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2v-4Z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M14 6.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2v-4Z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M4 16.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v1c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2v-1Z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M14 16.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v1c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2v-1Z" stroke="currentColor" strokeWidth="1.7" />
      </svg>
    ),
  },
  {
    view: 'ebay-listings',
    label: 'nav.ebay',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7.5h16M4 12h16M4 16.5h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="7.5" r="1.2" fill="currentColor" />
        <circle cx="7" cy="12" r="1.2" fill="currentColor" />
        <circle cx="7" cy="16.5" r="1.2" fill="currentColor" />
      </svg>
    ),
  },
  {
    view: 'warehouse',
    label: 'nav.warehouse',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 21V10l9-7 9 7v11" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M9 21v-6h6v6" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M3 21h18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    view: 'operations',
    label: 'nav.operations',
    iconNode: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2a10 10 0 1 1 0 20A10 10 0 0 1 12 2Z" stroke="currentColor" strokeWidth="1.7" />
        <path d="M9.5 9a2.5 2.5 0 1 1 5 0v2a2.5 2.5 0 0 1-5 0V9Z" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5 19a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    ),
  },
] as const;

export const Header: React.FC<HeaderProps> = ({ currentView, setView, theme, onToggleTheme }) => {
  const { t, locale, setLocale } = useI18n();
  const { logout, hasPermission, isAdmin } = useAuth();

  const renderNavIcon = (nav: NavIconConfig) => (
    <span className="w-5 h-5 flex items-center justify-center">{nav.iconNode}</span>
  );

  const DesktopNavButton = ({ nav }: { nav: NavIconConfig }) => {
    const targetHash = nav.view === 'ebay-listings' ? '#/ebay' : `#/${nav.view}`;
    const baseClass = `hidden sm:inline-flex w-11 h-11 rounded-xl items-center justify-center transition-all ${
      currentView === nav.view
        ? 'bg-sky-600 text-white shadow-md shadow-sky-900/40'
        : 'bg-slate-800/70 text-slate-400 hover:bg-slate-700 hover:text-white'
    }`;
    return (
      <a
        href={targetHash}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) return;
          e.preventDefault();
          window.location.hash = targetHash;
          setView(nav.view);
        }}
        className={baseClass}
        aria-current={currentView === nav.view ? 'page' : undefined}
        aria-label={t(nav.label)}
        title={t(nav.label)}
      >
        {renderNavIcon(nav)}
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
      <header className="safe-area-header bg-slate-900/80 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/40 border-b border-white/5">
        <div className="w-full px-3 sm:px-4 lg:px-8 py-1.5">
          <div className="flex items-center gap-3 w-full">
            {/* Logo */}
            <div className="flex items-center gap-2.5 flex-shrink-0">
              <img src="/avy_logo.png" alt="avycloud" className="h-7 sm:h-9 lg:h-10 w-auto object-contain" draggable={false} />
              <span className="sr-only">avycloud</span>
            </div>

            {/* Desktop Navigation */}
            <div className="hidden sm:flex flex-1 items-center justify-center gap-1.5">
              {navIcons.map((nav) => (
                <DesktopNavButton key={nav.view} nav={nav} />
              ))}
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-2 ml-auto">
              {/* Language selector */}
              <div className="relative flex items-center">
                <svg className="absolute left-2 w-4 h-4 text-slate-400 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3.6 9h16.8M3.6 15h16.8" strokeLinecap="round" />
                  <path d="M12 3c-2.5 3-4 6-4 9s1.5 6 4 9M12 3c2.5 3 4 6 4 9s-1.5 6-4 9" strokeLinecap="round" />
                </svg>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as any)}
                  className="bg-slate-800/60 text-slate-200 text-[13px] font-medium pl-7 pr-2 h-9 rounded-lg border border-white/[0.08] focus:outline-none focus:border-sky-500/50 cursor-pointer appearance-none"
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
                className="w-9 h-9 flex items-center justify-center rounded-lg bg-slate-800/60 border border-white/[0.08] text-slate-300 hover:text-white hover:bg-slate-700 transition-all"
                aria-label={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
                title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
              >
                {theme === 'dark' ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
                    <path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8Z" />
                  </svg>
                )}
              </button>

              {/* Logout */}
              <button
                type="button"
                onClick={() => logout()}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-lg bg-slate-800/60 border border-white/[0.08] hover:bg-slate-700 px-3 h-9 text-xs font-semibold text-slate-200 hover:text-white transition-all"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden="true">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
                {t('common.logout')}
              </button>
            </div>
          </div>
        </div>
      </header>
    </>
  );
};
