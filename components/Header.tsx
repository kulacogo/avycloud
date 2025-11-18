
import React from 'react';

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
    label: 'Dashboard',
    light: '/home_1828871.png',
    dark: '/home_darkmode.png',
  },
  {
    view: 'input' as const,
    label: 'New Product',
    light: '/plus_1828926.png',
    dark: '/plus_darkmode.png',
  },
  {
    view: 'inventory' as const,
    label: 'Inventar',
    light: '/wireframe_1932412.png',
    dark: '/wireframe_darkmode.png',
  },
  {
    view: 'warehouse' as const,
    label: 'Lager',
    light: '/storage_3134365.png',
    dark: '/storage_darkmode.png',
  },
  {
    view: 'operations' as const,
    label: 'Operationen',
    iconNode: OperationsGlyph,
  },
] as const;

const TOGGLE_ICONS = {
  light: '/toggle_1827856.png',
  dark: '/toggle_darkmode.png',
} as const;

export const Header: React.FC<HeaderProps> = ({ currentView, setView, theme, onToggleTheme }) => {
  const NavButton = ({
    view,
    label,
    iconSrc,
    iconNode,
  }: {
    view: HeaderProps['currentView'];
    label: string;
    iconSrc?: string;
    iconNode?: React.ReactNode;
  }) => (
    <button
      onClick={() => setView(view)}
      className={`w-11 h-11 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center transition-all ${
        currentView === view
          ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/40'
          : 'bg-slate-800/70 text-slate-300 hover:bg-slate-700 hover:text-white'
      }`}
      aria-current={currentView === view ? 'page' : undefined}
      aria-label={label}
      title={label}
    >
      {iconSrc ? <img src={iconSrc} alt="" className="w-6 h-6" draggable={false} /> : <span className="text-current">{iconNode}</span>}
    </button>
  );

  const logoSrc = theme === 'dark' ? LOGOS.dark : LOGOS.light;

  return (
    <header className="safe-area-header bg-slate-900/80 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/40 border-b border-white/5 relative">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 sm:py-2 pr-16">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img
              src={logoSrc}
              alt="avystock"
              className="h-16 sm:h-20 lg:h-24 w-auto drop-shadow-lg"
              draggable={false}
            />
            <span className="sr-only">Avystock Product Intelligence Hub</span>
          </div>
          <nav className="flex items-center gap-3" aria-label="Hauptnavigation">
            {NAV_ICONS.map((nav) => (
              <NavButton
                key={nav.view}
                view={nav.view}
                label={nav.label}
                iconSrc={nav.dark && nav.light ? (theme === 'dark' ? nav.dark : nav.light) : undefined}
                iconNode={nav.iconNode}
              />
            ))}
          </nav>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleTheme}
        className="absolute right-4 top-2 sm:top-3 rounded-2xl bg-slate-800/80 border border-white/10 p-2 hover:bg-slate-700 transition-colors"
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
    </header>
  );
};
