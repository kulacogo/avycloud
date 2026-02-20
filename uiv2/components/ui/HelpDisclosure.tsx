import React from 'react';

type Props = {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
};

// Accessible disclosure pattern (button + aria-expanded + aria-controls).
export const HelpDisclosure: React.FC<Props> = ({ title, children, defaultOpen = false, className }) => {
  const [open, setOpen] = React.useState(Boolean(defaultOpen));
  const id = React.useId();
  const panelId = `help-${id}`;

  return (
    <div className={className || ''}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-2 text-sm font-semibold text-[color:var(--text-primary)] hover:bg-[var(--surface-secondary)]/60"
      >
        <span className="text-[color:var(--text-primary)]">{title}</span>
        <span className="text-[11px] font-bold uppercase tracking-wide text-[color:var(--text-tertiary)]">{open ? 'Hide' : 'Show'}</span>
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--bg)]/30 p-3 text-sm text-[color:var(--text-primary)]"
      >
        {children}
      </div>
    </div>
  );
};

