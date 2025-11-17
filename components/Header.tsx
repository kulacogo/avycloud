
import React from 'react';
import { TableIcon, PlusCircleIcon, WarehouseIcon } from './icons/Icons';

const appIcon = new URL('../avystock_app_icon.png', import.meta.url).href;
const brandLogoLight = new URL('../avystock_brand_logo.png', import.meta.url).href;
const brandLogoDark = new URL('../avystock_brand_logo_darkmode.png', import.meta.url).href;

interface HeaderProps {
  currentView: 'input' | 'sheet' | 'admin' | 'warehouse';
  setView: (view: 'input' | 'sheet' | 'admin' | 'warehouse') => void;
}

export const Header: React.FC<HeaderProps> = ({ currentView, setView }) => {
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
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-2 sm:py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={appIcon}
              alt="avystock icon"
              className="h-11 w-auto sm:h-12 drop-shadow-lg"
              draggable={false}
            />
            <picture>
              <source srcSet={brandLogoDark} media="(prefers-color-scheme: dark)" />
              <img
                src={brandLogoLight}
                alt="avystock"
                className="h-28 sm:h-32 w-auto"
                draggable={false}
                />
            </picture>
            <span className="sr-only">Avystock Product Intelligence Hub</span>
          </div>
          <nav className="flex items-center gap-3" aria-label="Hauptnavigation">
            <NavButton view="input" icon={<PlusCircleIcon className="w-7 h-7" />} label="New Product" />
            <NavButton view="admin" icon={<TableIcon className="w-7 h-7" />} label="Admin" />
            <NavButton view="warehouse" icon={<WarehouseIcon className="w-7 h-7" />} label="Lager" />
          </nav>
        </div>
      </div>
    </header>
  );
};
