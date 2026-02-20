import React from 'react';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export interface TopbarProps {
  onSearch?: () => void;
  onToggleTheme?: () => void;
  className?: string;
}

/* -------------------------------------------------------
   Topbar
   ------------------------------------------------------- */
export const Topbar: React.FC<TopbarProps> = React.memo(
  ({ onSearch, onToggleTheme, className = '' }) => {
    return (
      <header
        className={`
          sticky top-0 z-40
          h-14 bg-[var(--surface)] border-b border-[var(--border)]
          px-8 flex items-center gap-4
          ${className}
        `.trim()}
      >
        {/* Search trigger */}
        <button
          type="button"
          onClick={onSearch}
          className="
            bg-[var(--bg)] border border-[var(--border)] rounded-lg
            px-3 py-1.5 min-w-[240px]
            flex items-center gap-2
            cursor-pointer
            transition-all duration-150
            hover:border-[var(--border-hover)] hover:shadow-sm
          "
        >
          <svg
            className="w-4 h-4 text-[var(--text-tertiary)]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <span className="text-sm text-[var(--text-tertiary)] flex-1 text-left">
            Suchen...
          </span>
          <kbd className="hidden sm:inline-flex text-2xs text-[var(--text-tertiary)] bg-[var(--surface-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 font-mono">
            Cmd+K
          </kbd>
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Theme toggle */}
        <button
          type="button"
          onClick={onToggleTheme}
          className="
            w-9 h-9 flex items-center justify-center
            border border-[var(--border)] rounded-lg
            text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]
            hover:border-[var(--border-hover)]
            transition-all duration-150
          "
          aria-label="Toggle theme"
        >
          {/* Sun icon (light mode) / Moon icon (dark mode) */}
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5.25V3m0 18v-2.25m6.364-9.114l1.59-.918m-15.908.918l-1.59-.918M18.75 12h2.25M3 12h2.25m12.364 5.864l1.59.918m-15.908-.918l-1.59.918M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
          </svg>
        </button>

        {/* Notification bell */}
        <button
          type="button"
          className="
            relative w-9 h-9 flex items-center justify-center
            border border-[var(--border)] rounded-lg
            text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]
            hover:border-[var(--border-hover)]
            transition-all duration-150
          "
          aria-label="Notifications"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
          {/* Notification dot */}
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[var(--error)] rounded-full" aria-hidden="true" />
        </button>
      </header>
    );
  }
);

Topbar.displayName = 'Topbar';
