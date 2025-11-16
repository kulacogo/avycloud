
import React from 'react';
import { TableIcon, PlusCircleIcon, SheetIcon, WarehouseIcon } from './icons/Icons';
import logo from '../logo.png';

interface HeaderProps {
  currentView: 'input' | 'sheet' | 'admin' | 'warehouse';
  setView: (view: 'input' | 'sheet' | 'admin' | 'warehouse') => void;
}

export const Header: React.FC<HeaderProps> = ({ currentView, setView }) => {
  const NavButton = ({
    view,
    icon,
    text,
  }: {
    view: 'input' | 'sheet' | 'admin' | 'warehouse';
    icon: React.ReactNode;
    text: string;
  }) => (
    <button
      onClick={() => setView(view)}
      className={`flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors ${
        currentView === view
          ? 'bg-slate-700 text-white'
          : 'text-slate-300 hover:bg-slate-700 hover:text-white'
      }`}
      aria-current={currentView === view ? 'page' : undefined}
    >
      {icon}
      <span className="ml-2">{text}</span>
    </button>
  );

  return (
    <header className="bg-slate-800/50 backdrop-blur-sm sticky top-0 z-40 shadow-md">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <img
              src={logo}
              alt="Avystock"
              className="h-8 w-auto"
            />
            <span className="sr-only">Avystock Product Intelligence Hub</span>
          </div>
          <nav className="flex items-center space-x-2 sm:space-x-4">
            <NavButton view="input" icon={<PlusCircleIcon />} text="New" />
            <NavButton view="sheet" icon={<SheetIcon />} text="Datasheet" />
            <NavButton view="admin" icon={<TableIcon />} text="Admin" />
            <NavButton view="warehouse" icon={<WarehouseIcon />} text="Lager" />
          </nav>
        </div>
      </div>
    </header>
  );
};
