import React from 'react';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
interface TabItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

export interface MobileTabBarProps {
  currentView: string;
  onNavigate: (viewId: string) => void;
  className?: string;
}

/* -------------------------------------------------------
   Tab icons
   ------------------------------------------------------- */
const HomeTabIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v18m16.5 0V3m-13.5 0v7.5m4.5-7.5v4.5m4.5-4.5v10.5m-9 0V21m4.5-6v6m4.5-1.5V21" />
  </svg>
);

const SearchTabIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
  </svg>
);

const IdentifyTabIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 003.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0120.25 6v1.5m0 9V18A2.25 2.25 0 0118 20.25h-1.5m-9 0H6A2.25 2.25 0 013.75 18v-1.5" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25v7.5M9 11.25h6" />
  </svg>
);

const OperationsTabIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8.25a3.75 3.75 0 103.75 3.75A3.75 3.75 0 0012 8.25zm0-5.25v2.25m0 13.5V21m7.5-9h2.25M2.25 12H4.5m13.182-5.318l1.59-1.59M4.728 19.272l1.59-1.59m0-10.364l-1.59-1.59m13.544 13.544l-1.59-1.59" />
  </svg>
);

const MoreTabIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
  </svg>
);

/* -------------------------------------------------------
   Tabs config
   ------------------------------------------------------- */
const tabs: TabItem[] = [
  { id: 'dashboard', label: 'Home', icon: <HomeTabIcon /> },
  { id: 'search', label: 'Suche', icon: <SearchTabIcon /> },
  { id: 'identification', label: 'Erkennen', icon: <IdentifyTabIcon /> },
  { id: 'operations', label: 'Operationen', icon: <OperationsTabIcon /> },
  { id: 'more', label: 'Mehr', icon: <MoreTabIcon /> },
];

/* -------------------------------------------------------
   MobileTabBar — fixed bottom, mobile only
   ------------------------------------------------------- */
export const MobileTabBar: React.FC<MobileTabBarProps> = React.memo(
  ({ currentView, onNavigate, className = '' }) => {
    return (
      <nav
        className={`
          fixed bottom-0 left-0 right-0
          md:hidden
          bg-[var(--surface)] border-t border-[var(--border)]
          h-14 flex items-center justify-around
          z-50
          safe-area-bottom
          ${className}
        `.trim()}
      >
        {tabs.map((tab) => {
          const isActive = currentView === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onNavigate(tab.id)}
              className={`
                flex flex-col items-center gap-0.5
                py-1 px-2
                text-[10px] font-medium
                transition-colors duration-150
                ${
                  isActive
                    ? 'text-[var(--avy-purple)]'
                    : 'text-[var(--text-tertiary)]'
                }
              `.trim()}
            >
              <span className="flex-shrink-0">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    );
  }
);

MobileTabBar.displayName = 'MobileTabBar';

/* Default export for backward compat with existing App.tsx */
export default MobileTabBar;
