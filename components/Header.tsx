
import React from 'react';
import { useI18n } from '../i18n';

interface HeaderProps {
  currentView:
    | 'dashboard'
    | 'home'
    | 'search'
    | 'input'
    | 'sheet'
    | 'inventory'
    | 'admin'
    | 'categories'
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

const TOGGLE_ICONS = {
  light: '/mode_switch__brightmode.png',
  dark: '/mode_switch_darkmode.png',
} as const;

export const Header: React.FC<HeaderProps> = ({ currentView, setView, theme, onToggleTheme }) => {
  const { t, locale, setLocale } = useI18n();
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

  const DesktopNavButton = ({ nav }: { nav: NavIconConfig }) => (
    <a
      href={`#/${nav.view}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.button === 1 || e.shiftKey) {
          return; // allow native new-tab / background tab
        }
        e.preventDefault();
        window.location.hash = `#/${nav.view}`;
        setView(nav.view);
      }}
      className={`hidden sm:inline-flex w-12 h-12 rounded-2xl items-center justify-center transition-all ${currentView === nav.view
          ? 'bg-sky-600 text-white shadow-md shadow-sky-900/40'
          : 'bg-slate-800/70 text-slate-300 hover:bg-slate-700 hover:text-white'
        }`}
      aria-current={currentView === nav.view ? 'page' : undefined}
      aria-label={t(nav.label)}
      title={t(nav.label)}
    >
      {renderNavIcon(nav)}
    </a>
  );

  return (
    <>
      <header className="safe-area-header bg-slate-900/80 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/40 border-b border-white/5">
        <div className="w-full px-3 sm:px-4 lg:px-8 py-1.5">
          <div className="flex items-center gap-3 w-full">
            <div className="flex items-center gap-3 flex-shrink-0">
              <img src={logoSrc} alt="Avystock" className="h-6 sm:h-10 lg:h-12 w-auto object-contain" draggable={false} />
              <span className="sr-only">Avystock Product Intelligence Hub</span>
            </div>
            <div className="hidden sm:flex flex-1 items-center justify-center gap-2">
              {NAV_ICONS.map((nav) => (
                <DesktopNavButton key={nav.view} nav={nav} />
              ))}
            </div>
            <div className="flex items-center gap-4 ml-auto">
              <button
                type="button"
                onClick={handleHardRefresh}
                className="w-[20px] h-0 flex items-center justify-center rounded-full hover:opacity-80 transition"
                aria-label={t('actions.refresh')}
                title={t('actions.refresh')}
              >
                <img
                  src={theme === 'dark' ? RELOAD_ICONS.dark : RELOAD_ICONS.light}
                  alt=""
                  className="w-[15px] h-[15px]"
                  draggable={false}
                />
              </button>
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as any)}
                className="bg-transparent w-[33px] h-[33px] text-[15px] text-slate-100 text-center focus:outline-none border-none appearance-none cursor-pointer"
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
                <img
                  src={theme === 'dark' ? TOGGLE_ICONS.dark : TOGGLE_ICONS.light}
                  alt=""
                  className="w-10 h-10 object-contain"
                  draggable={false}
                />
              </button>
            </div>
          </div>
        </div>
      </header>
    </>
  );
};
