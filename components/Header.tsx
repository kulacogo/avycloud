
import React from 'react';
import { useI18n } from '../i18n';
import { addMediaQueryListener } from '../utils/mediaQuery';

interface HeaderProps {
  currentView: 'dashboard' | 'input' | 'sheet' | 'inventory' | 'warehouse' | 'operations' | 'queue';
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
  {
    view: 'queue' as const,
    label: 'nav.identifyQueue',
    light: '/queue_brightmode.png',
    dark: '/queue_darkmode.png',
  },
] as const;

const TOGGLE_ICONS = {
  light: '/mode_switch__brightmode.png',
  dark: '/mode_switch_darkmode.png',
} as const;

const safeBottomStyle: React.CSSProperties = {
  paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)',
  bottom: 'max(calc(env(safe-area-inset-bottom, 0px) - 0.75rem), 0.5rem)',
};

export const Header: React.FC<HeaderProps> = ({ currentView, setView, theme, onToggleTheme }) => {
  const { t, locale, setLocale } = useI18n();
  const [isMobile, setIsMobile] = React.useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false
  );
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

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    const detach = addMediaQueryListener(mq, handler);
    return () => detach();
  }, []);

  const navIcons = React.useMemo(() => {
    if (!isMobile) return NAV_ICONS;
    const ops = NAV_ICONS.find((n) => n.view === 'operations');
    const input = NAV_ICONS.find((n) => n.view === 'input');
    const rest = NAV_ICONS.filter((n) => n.view !== 'operations' && n.view !== 'input');
    return [ops, input, ...rest].filter(Boolean) as typeof NAV_ICONS;
  }, [isMobile]);

  const renderNavIcon = (nav: NavIconConfig) => {
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
    <button
      onClick={() => setView(nav.view)}
      className={`hidden sm:inline-flex w-12 h-12 rounded-2xl items-center justify-center transition-all ${
        currentView === nav.view
          ? 'bg-sky-600 text-white shadow-md shadow-sky-900/40'
          : 'bg-slate-800/70 text-slate-300 hover:bg-slate-700 hover:text-white'
      }`}
      aria-current={currentView === nav.view ? 'page' : undefined}
      aria-label={t(nav.label)}
      title={t(nav.label)}
    >
      {renderNavIcon(nav)}
    </button>
  );

  const MobileNavButton = ({ nav }: { nav: NavIconConfig }) => {
    const isActive = currentView === nav.view;
    return (
      <button
        onClick={() => setView(nav.view)}
        className={`flex items-center justify-center flex-1 rounded-2xl py-2 ${
          isActive ? 'text-white' : 'text-slate-300'
        }`}
        aria-label={t(nav.label)}
        title={t(nav.label)}
      >
        <span
          className={`w-12 h-12 rounded-3xl flex items-center justify-center ${
            isActive ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/40' : 'bg-slate-800 text-slate-200'
          }`}
        >
          {renderNavIcon(nav)}
        </span>
      </button>
    );
  };

  return (
    <>
      <header className="safe-area-header bg-slate-900/80 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/40 border-b border-white/5">
        <div className="w-full px-3 sm:px-4 lg:px-8 py-1.5">
          <div className="flex items-center gap-3 w-full">
            <div className="flex items-center gap-3 flex-shrink-0">
              <img src={logoSrc} alt="Avystock" className="h-11 sm:h-12 lg:h-14 w-auto object-contain" draggable={false} />
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
                className="w-11 h-11 flex items-center justify-center rounded-full hover:opacity-80 transition"
                aria-label={t('actions.refresh')}
                title={t('actions.refresh')}
              >
                <img src={theme === 'dark' ? RELOAD_ICONS.dark : RELOAD_ICONS.light} alt="" className="w-7 h-7" draggable={false} />
              </button>
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as any)}
                className="bg-transparent text-sm text-slate-100 focus:outline-none border-none appearance-none cursor-pointer"
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
                aria-label={theme === 'dark' ? 'Wechsel zu hellem Modus' : 'Wechsel zu dunklem Modus'}
                title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
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
      <nav className="sm:hidden fixed left-0 right-0 bottom-4 z-50 px-4 pointer-events-none" style={safeBottomStyle} aria-label="Mobile Navigation">
        <div className="bg-slate-900/95 border border-white/10 rounded-[32px] shadow-2xl shadow-black/40 px-3 py-2 flex gap-1 pointer-events-auto">
          {navIcons.map((nav) => (
            <MobileNavButton key={nav.view} nav={nav} />
          ))}
        </div>
      </nav>
    </>
  );
};
