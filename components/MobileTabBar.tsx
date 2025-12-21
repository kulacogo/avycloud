import React from 'react';
import homeLight from '../mobile icons/mobile home.png';
import homeDark from '../mobile icons/mobile home dm.png';
import searchLight from '../mobile icons/mobile search.png';
import searchDark from '../mobile icons/mobile search dm.png';
import opsLight from '../mobile icons/mobile operation.png';
import opsDark from '../mobile icons/mobile operation dm.png';

type MobileTab = 'home' | 'search' | 'operations';

interface MobileTabBarProps {
  currentView: string;
  onNavigate: (view: MobileTab) => void;
  theme: 'light' | 'dark';
}

const tabIcons = {
  home: { light: homeLight, dark: homeDark },
  search: { light: searchLight, dark: searchDark },
  operations: { light: opsLight, dark: opsDark },
} as const;

const tabs: { id: MobileTab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'search', label: 'Search' },
  { id: 'operations', label: 'Operations' },
];

const isActive = (current: string, tab: MobileTab) => {
  if (tab === 'operations') {
    return current.startsWith('operations');
  }
  return current === tab || (tab === 'home' && current === 'dashboard');
};

const MobileTabBar: React.FC<MobileTabBarProps> = ({ currentView, onNavigate, theme }) => {
  return (
    <nav className="bg-slate-900/95 backdrop-blur-lg border-t border-slate-800 px-4 py-2 flex justify-around gap-2 pb-4 safe-area-bottom shadow-2xl shadow-black/40">
      {tabs.map((tab) => {
        const active = isActive(currentView, tab.id);
        const iconSrc = theme === 'dark' ? tabIcons[tab.id].dark : tabIcons[tab.id].light;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onNavigate(tab.id)}
            className={`flex flex-col items-center justify-center flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${
              active ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/40' : 'text-slate-200 bg-slate-800/80'
            }`}
          >
            <img src={iconSrc} alt="" className="w-5 h-5" draggable={false} />
            <span className="mt-1">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileTabBar;
