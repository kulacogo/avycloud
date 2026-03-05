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
        className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-bg/40 px-3 py-2 text-sm font-semibold text-txt-secondary hover:bg-app-bg/60"
      >
        <span className="text-txt-primary">{title}</span>
        <span className="text-[11px] font-bold uppercase tracking-wide text-txt-muted">{open ? 'Hide' : 'Show'}</span>
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="mt-2 rounded-xl border border-app-border bg-app-bg/30 p-3 text-sm text-txt-secondary"
      >
        {children}
      </div>
    </div>
  );
};

