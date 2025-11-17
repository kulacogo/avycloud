
import React from 'react';
import { TableIcon, PlusCircleIcon, WarehouseIcon, SunIcon, MoonIcon } from './icons/Icons';

const uiLogo = '/ui_logo.png';

interface HeaderProps {
  currentView: 'input' | 'sheet' | 'admin' | 'warehouse';
  setView: (view: 'input' | 'sheet' | 'admin' | 'warehouse') => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export const Header: React.FC<HeaderProps> = ({ currentView, setView, theme, onToggleTheme }) => {
  const NavButton = ({
    view,
    icon,
    label,
  }: {
    view: 'input' | 'admin' | 'warehouse';
    icon: React.ReactNode;
    label: string;
  }) => (
    <button
      onClick={() => setView(view)}
      className={`w-10 h-10 sm:w-11 sm:h-11 rounded-2xl flex items-center justify-center transition-all ${
        currentView === view
          ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/40'
          : 'bg-slate-800/70 text-slate-300 hover:bg-slate-700 hover:text-white'
      }`}
      aria-current={currentView === view ? 'page' : undefined}
      aria-label={label}
      title={label}
    >
      {icon}
    </button>
  );

  return (
    <header className="safe-area-header bg-slate-900/80 backdrop-blur-xl sticky top-0 z-40 shadow-lg shadow-black/40 border-b border-white/5">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 sm:py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <img
              src={uiLogo}
              alt="avystock"
              className="h-14 sm:h-16 w-auto drop-shadow-lg"
              draggable={false}
            />
            <span className="sr-only">Avystock Product Intelligence Hub</span>
          </div>
          <div className="flex items-center gap-3">
            <nav className="flex items-center gap-3" aria-label="Hauptnavigation">
              <NavButton view="input" icon={<PlusCircleIcon className="w-7 h-7" />} label="New Product" />
              <NavButton view="admin" icon={<TableIcon className="w-7 h-7" />} label="Admin" />
              <NavButton view="warehouse" icon={<WarehouseIcon className="w-7 h-7" />} label="Lager" />
            </nav>
            <button
              type="button"
              onClick={onToggleTheme}
              className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl flex items-center justify-center transition-all bg-slate-800/70 text-slate-300 hover:bg-slate-700 hover:text-white"
              aria-label={theme === 'dark' ? 'Wechsel zu hellem Modus' : 'Wechsel zu dunklem Modus'}
              title={theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
            >
              {theme === 'dark' ? <SunIcon className="w-6 h-6" /> : <MoonIcon className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};
