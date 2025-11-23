
import React from 'react';
import { useI18n } from '../i18n';

interface HeaderProps {
  currentView: 'dashboard' | 'input' | 'sheet' | 'inventory' | 'warehouse' | 'operations';
  setView: (view: HeaderProps['currentView']) => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

const LOGOS = {
  light: '/avystock_brand_logo.png',
  dark: '/avystock_brand_logo_darkmode.png',
} as const;
const MOBILE_LOGO = '/app-icon-512.png';

const OperationsGlyph = (
  <svg width="24" height="24" viewBox="0 0 24 24" className="w-6 h-6" aria-hidden="true">
    <path
      d="M4 5.5h5M4 11.5h9M4 17.5h13"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
    />
    <circle cx="17" cy="5.5" r="1.5" fill="currentColor" />
    <circle cx="13" cy="11.5" r="1.5" fill="currentColor" />
    <circle cx="9" cy="17.5" r="1.5" fill="currentColor" />
  </svg>
);

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
    light: '/home_1828871.png',
    dark: '/home_darkmode.png',
  },
  {
    view: 'input' as const,
    label: 'nav.input',
    light: '/plus_1828926.png',
    dark: '/plus_darkmode.png',
  },
  {
    view: 'inventory' as const,
    label: 'nav.inventory',
    light: '/wireframe_1932412.png',
    dark: '/wireframe_darkmode.png',
  },
  {
    view: 'warehouse' as const,
    label: 'nav.warehouse',
    light: '/storage_3134365.png',
    dark: '/storage_darkmode.png',
  },
  {
    view: 'operations' as const,
    label: 'nav.operations',
    iconNode: OperationsGlyph,
  },
] as const;

const TOGGLE_ICONS = {
  light: '/toggle_1827856.png',
  dark: '/toggle_darkmode.png',
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

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const navIcons = React.useMemo(() => {
    if (!isMobile) return NAV_ICONS;
    const ops = NAV_ICONS.find((n) => n.view === 'operations');
    const input = NAV_ICONS.find((n) => n.view === 'input');
    const rest = NAV_ICONS.filter((n) => n.view !== 'operations' && n.view !== 'input');
    return [ops, input, ...rest].filter(Boolean) as typeof NAV_ICONS;
  }, [isMobile]);

  const renderNavIcon = (nav: NavIconConfig) => {
    if (nav.iconNode) return nav.iconNode;
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
      className={`hidden sm:inline-flex w-11 h-11 sm:w-12 sm:h-12 rounded-2xl items-center justify-center transition-all ${
        currentView === nav.view
          ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/40'
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
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-2xl overflow-hidden shadow-lg sm:hidden bg-white/80">
                <img src={MOBILE_LOGO} alt="Avystock" className="h-full w-full object-cover" draggable={false} />
              </div>
              <div className="hidden sm:block h-12 sm:h-14 lg:h-16 w-auto">
                <img
                  src={logoSrc}
                  alt="avystock"
                  className="h-full w-auto object-contain drop-shadow-lg"
                  draggable={false}
                />
              </div>
              <div className="sm:hidden flex flex-col leading-tight">
                <p className="text-base font-semibold text-white tracking-wide">avystock</p>
                <p className="text-[11px] uppercase text-slate-400 tracking-[0.3em]">Product Hub</p>
              </div>
              <span className="sr-only">Avystock Product Intelligence Hub</span>
            </div>
            <div className="hidden sm:flex items-center gap-3">
              {navIcons.map((nav) => (
                <DesktopNavButton key={nav.view} nav={nav} />
              ))}
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as any)}
                className="rounded-2xl bg-slate-800/80 border border-white/10 px-3 py-2 text-sm text-slate-100"
                aria-label={t('lang.label')}
              >
                <option value="de">Deutsch</option>
                <option value="en">English</option>
                <option value="tr">Türkçe</option>
              </select>
              <button
                type="button"
                onClick={onToggleTheme}
                className="rounded-2xl bg-slate-800/80 border border-white/10 p-2 hover:bg-slate-700 transition-colors"
                aria-label={theme === 'dark' ? 'Wechsel zu hellem Modus' : 'Wechsel zu dunklem Modus'}
                title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
              >
                <img
                  src={theme === 'dark' ? TOGGLE_ICONS.dark : TOGGLE_ICONS.light}
                  alt=""
                  className="w-6 h-6"
                  draggable={false}
                />
              </button>
            </div>
            <button
              type="button"
              onClick={onToggleTheme}
              className="sm:hidden rounded-2xl bg-slate-800/80 border border-white/10 p-2 hover:bg-slate-700 transition-colors"
              aria-label={theme === 'dark' ? 'Wechsel zu hellem Modus' : 'Wechsel zu dunklem Modus'}
              title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            >
              <img
                src={theme === 'dark' ? TOGGLE_ICONS.dark : TOGGLE_ICONS.light}
                alt=""
                className="w-6 h-6"
                draggable={false}
              />
            </button>
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
