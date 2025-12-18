import React from 'react';
import { HomeIcon, SearchIcon, OperationsIcon } from './icons/Icons';

type MobileTab = 'home' | 'search' | 'operations';

interface MobileTabBarProps {
  currentView: string;
  onNavigate: (view: MobileTab) => void;
}

const tabs: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  { id: 'home', label: 'Home', icon: <HomeIcon className="w-5 h-5" /> },
  { id: 'search', label: 'Search', icon: <SearchIcon className="w-5 h-5" /> },
  { id: 'operations', label: 'Operations', icon: <OperationsIcon className="w-5 h-5" /> },
];

const isActive = (current: string, tab: MobileTab) => {
  if (tab === 'operations') {
    return current.startsWith('operations');
  }
  return current === tab || (tab === 'home' && current === 'dashboard');
};

const MobileTabBar: React.FC<MobileTabBarProps> = ({ currentView, onNavigate }) => {
  return (
    <nav className="bg-slate-900/95 backdrop-blur-lg border-t border-slate-800 px-4 py-2 flex justify-around gap-2 pb-4 safe-area-bottom shadow-2xl shadow-black/40">
      {tabs.map((tab) => {
        const active = isActive(currentView, tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onNavigate(tab.id)}
            className={`flex flex-col items-center justify-center flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition ${
              active ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/40' : 'text-slate-200 bg-slate-800/80'
            }`}
          >
            {tab.icon}
            <span className="mt-1">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileTabBar;
