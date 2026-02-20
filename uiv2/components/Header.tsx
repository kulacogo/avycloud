
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

const LOGOS = {
  light: '/logo_brightmode.png',
  dark: '/logo_darkmode.png',
} as const;

const RELOAD_ICONS = {
  light: '/reload_brightmode.png',
  dark: '/reload_darkmode.png',
} as const;

type NavIconConfig = {
  view: HeaderProps['currentView'];
  label: string;
  light?: string;
  dark?: string;
  iconNode?: React.ReactNode;
};

const NAV_ICONS: NavIconConfig[] = [
  {
    view: 'dashboard' as const,
    label: 'nav.dashboard',
    light: '/home_brightmode.png',
    dark: '/home_darkmode.png',
  },
  {
    view: 'input' as const,
    label: 'nav.input',
    light: '/plus__brightmodepng.png',
    dark: '/plus_darkmode.png',
  },
  {
    view: 'inventory' as const,
    label: 'nav.inventory',
    light: '/inventory_brightmode.png',
    dark: '/inventory_darkmode.png',
  },
  {
    view: 'products' as const,
    label: 'nav.products',
    iconNode: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M7 6h14M7 12h14M7 18h14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    view: 'admin' as const,
    label: 'nav.admin',
    iconNode: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3l7 4v6c0 5-3 8-7 9-4-1-7-4-7-9V7l7-4Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M9.5 12.3l1.8 1.8 3.7-3.9"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    view: 'categories' as const,
    label: 'nav.categories',
    iconNode: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 6.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2v-4Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M14 6.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2v-4Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M4 16.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v1c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2v-1Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M14 16.5c0-1.1.9-2 2-2h4c1.1 0 2 .9 2 2v1c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2v-1Z"
          stroke="currentColor"
          strokeWidth="1.8"
        />
      </svg>
    ),
  },
  {
    view: 'ebay-listings' as const,
    label: 'nav.ebay',
    iconNode: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 7.5h16M4 12h16M4 16.5h16"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="7" cy="7.5" r="1.2" fill="currentColor" />
        <circle cx="7" cy="12" r="1.2" fill="currentColor" />
        <circle cx="7" cy="16.5" r="1.2" fill="currentColor" />
      </svg>
    ),
  },
  {
    view: 'warehouse' as const,
    label: 'nav.warehouse',
    light: '/storeage_brightmode.png',
    dark: '/storeage_darkmode.png',
  },
  {
    view: 'operations' as const,
    label: 'nav.operations',
    light: '/operations_brightmode.png',
    dark: '/operations_darkmode.png',
  },
] as const;

export const Header: React.FC<HeaderProps> = ({ currentView, setView, theme, onToggleTheme }) => {
  const { t, locale, setLocale } = useI18n();
  const { logout, hasPermission, isAdmin } = useAuth();
  const logoSrc = theme === 'dark' ? LOGOS.dark : LOGOS.light;
  const handleHardRefresh = React.useCallback(async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (error) {
      console.warn('Hard refresh fallback:', (error as any)?.message);
    } finally {
      window.location.reload();
    }
  }, []);

  const renderNavIcon = (nav: NavIconConfig) => {
    if (nav.iconNode) {
      return <span className="w-6 h-6 flex items-center justify-center">{nav.iconNode}</span>;
    }
    if (nav.dark && nav.light) {
      return (
        <img
          src={theme === 'dark' ? nav.dark : nav.light}
          alt=""
          className="w-6 h-6"
          draggable={false}
        />
      );
    }
    return null;
  };

  const DesktopNavButton = ({ nav }: { nav: NavIconConfig }) => {
    const targetHash = nav.view === 'ebay-listings' ? '#/ebay' : `#/${nav.view}`;
    const baseClass = `hidden sm:inline-flex w-12 h-12 rounded-2xl items-center justify-center transition-all ${
      currentView === nav.view
        ? 'bg-[var(--avy-purple)] text-[color:white] shadow-md shadow-[var(--avy-purple)]/20'
        : 'bg-[var(--surface-hover)]/70 text-[color:var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[color:var(--text-primary)]'
    }`;
    return (
      <a
        href={targetHash}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) {
            return; // allow native new-tab / background tab
          }
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
      // Always allow dashboard.
      if (view === 'dashboard') return true;
      // Products list lives under "inventory" view.
      if (view === 'inventory') return hasPermission('products', 'read');
      if (view === 'products') return hasPermission('products', 'read');
      if (view === 'ebay-listings') return hasPermission('products', 'read') || hasPermission('products', 'write');
      // Identify / ProductInput
      if (view === 'input') return hasPermission('identify', 'run');
      // Categories management
      if (view === 'categories') return hasPermission('categories', 'read') || hasPermission('categories', 'write');
      // Warehouse module
      if (view === 'warehouse') return hasPermission('warehouse', 'read') || hasPermission('warehouse', 'write');
      // Operations module (any operational capability)
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
      // Admin module
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
      <header className="safe-area-header bg-[var(--surface-secondary)]/80 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/40 border-b border-[var(--border)]">
        <div className="w-full px-3 sm:px-4 lg:px-8 py-1.5">
          <div className="flex items-center gap-3 w-full">
            <div className="flex items-center gap-3 flex-shrink-0">
              <img src={logoSrc} alt="Avystock" className="h-6 sm:h-10 lg:h-12 w-auto object-contain" draggable={false} />
              <span className="sr-only">Avystock Product Intelligence Hub</span>
            </div>
            <div className="hidden sm:flex flex-1 items-center justify-center gap-2">
              {navIcons.map((nav) => (
                <DesktopNavButton key={nav.view} nav={nav} />
              ))}
            </div>
            <div className="flex items-center gap-4 ml-auto">
              <button
                type="button"
                onClick={handleHardRefresh}
                className="w-10 h-10 flex items-center justify-center rounded-full hover:opacity-80 transition"
                aria-label={t('actions.refresh')}
                title={t('actions.refresh')}
              >
                <img
                  src={theme === 'dark' ? RELOAD_ICONS.dark : RELOAD_ICONS.light}
                  alt=""
                  className="w-4 h-4"
                  draggable={false}
                />
              </button>
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as any)}
                className="bg-transparent w-[33px] h-[33px] text-[15px] text-[color:var(--text-primary)] text-center focus:outline-none border-none appearance-none cursor-pointer"
                aria-label={t('lang.label')}
              >
                <option value="de">DE</option>
                <option value="en">EN</option>
                <option value="tr">TR</option>
              </select>
              <button
                type="button"
                onClick={onToggleTheme}
                className="w-12 h-12 flex items-center justify-center rounded-full hover:opacity-80 transition"
                aria-label={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
                title={theme === 'dark' ? t('theme.switchToLight') : t('theme.switchToDark')}
              >
                {theme === 'dark' ? (
                  // show target mode icon (light) while in dark mode
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-6 h-6 text-[color:var(--text-primary)]"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2" />
                    <path d="M12 20v2" />
                    <path d="M4.93 4.93l1.41 1.41" />
                    <path d="M17.66 17.66l1.41 1.41" />
                    <path d="M2 12h2" />
                    <path d="M20 12h2" />
                    <path d="M4.93 19.07l1.41-1.41" />
                    <path d="M17.66 6.34l1.41-1.41" />
                  </svg>
                ) : (
                  // show target mode icon (dark) while in light mode
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-6 h-6 text-[color:var(--text-primary)]"
                    aria-hidden="true"
                  >
                    <path d="M21 12.8A8 8 0 1 1 11.2 3a6 6 0 0 0 9.8 9.8Z" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={() => logout()}
                className="hidden sm:inline-flex rounded-xl bg-[var(--surface)] hover:bg-[var(--surface-secondary)] px-3 py-1.5 text-xs font-semibold text-[color:white]"
              >
                {t('common.logout')}
              </button>
            </div>
          </div>
        </div>
      </header>
    </>
  );
};
