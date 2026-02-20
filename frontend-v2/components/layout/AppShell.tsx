import React, { useState, useCallback } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { MobileHeader } from './MobileHeader';
import { MobileTabBar } from './MobileTabBar';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export interface AppShellProps {
  currentView: string;
  onNavigate: (viewId: string) => void;
  onToggleTheme?: () => void;
  onOpenSearch?: () => void;
  children: React.ReactNode;
  className?: string;
}

/* -------------------------------------------------------
   AppShell — wraps Sidebar + Topbar + content
   ------------------------------------------------------- */
export const AppShell: React.FC<AppShellProps> = ({
  currentView,
  onNavigate,
  onToggleTheme,
  onOpenSearch,
  children,
  className = '',
}) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleNavigate = useCallback(
    (viewId: string) => {
      onNavigate(viewId);
      closeSidebar();
    },
    [onNavigate, closeSidebar]
  );

  return (
    <div className={`min-h-screen bg-[var(--bg)] ${className}`.trim()}>
      {/* Sidebar */}
      <Sidebar
        currentView={currentView}
        onNavigate={handleNavigate}
        open={sidebarOpen}
      />

      {/* Mobile overlay for sidebar */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden"
          onClick={closeSidebar}
          aria-hidden="true"
        />
      )}

      {/* Main area — offset by sidebar width on desktop */}
      <div className="md:ml-[248px] flex-1 min-h-screen flex flex-col">
        {/* Mobile header */}
        <MobileHeader
          onToggleSidebar={toggleSidebar}
          onToggleTheme={onToggleTheme}
        />

        {/* Desktop topbar */}
        <div className="hidden md:block">
          <Topbar
            onSearch={onOpenSearch}
            onToggleTheme={onToggleTheme}
          />
        </div>

        {/* Content */}
        <main className="flex-1 p-4 md:p-8 pb-20 md:pb-8">
          {children}
        </main>
      </div>

      {/* Mobile tab bar */}
      <MobileTabBar
        currentView={currentView}
        onNavigate={handleNavigate}
      />
    </div>
  );
};

AppShell.displayName = 'AppShell';
