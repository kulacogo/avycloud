import React from 'react';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export interface MobileHeaderProps {
  onToggleSidebar: () => void;
  onToggleTheme?: () => void;
  className?: string;
}

/* -------------------------------------------------------
   MobileHeader — shown only on mobile (< md breakpoint)
   ------------------------------------------------------- */
export const MobileHeader: React.FC<MobileHeaderProps> = React.memo(
  ({ onToggleSidebar, onToggleTheme, className = '' }) => {
    return (
      <header
        className={`
          md:hidden
          h-14 bg-[var(--avy-deep)]
          flex items-center gap-3 px-4
          sticky top-0 z-[60]
          ${className}
        `.trim()}
      >
        {/* Hamburger */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="
            w-9 h-9 flex items-center justify-center rounded-lg
            text-white/70 hover:text-white hover:bg-white/[0.08]
            transition-colors duration-150
          "
          aria-label="Toggle sidebar"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>

        {/* Brand */}
        <div className="flex items-center gap-2.5 flex-1">
          <img src="/avy_logo.png" alt="avycloud" className="h-7 w-auto object-contain" draggable={false} />
        </div>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={onToggleTheme}
          className="
            w-9 h-9 flex items-center justify-center rounded-lg
            text-white/50 hover:text-white hover:bg-white/[0.08]
            transition-colors duration-150
          "
          aria-label="Toggle theme"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5.25V3m0 18v-2.25m6.364-9.114l1.59-.918m-15.908.918l-1.59-.918M18.75 12h2.25M3 12h2.25m12.364 5.864l1.59.918m-15.908-.918l-1.59.918M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
          </svg>
        </button>
      </header>
    );
  }
);

MobileHeader.displayName = 'MobileHeader';
