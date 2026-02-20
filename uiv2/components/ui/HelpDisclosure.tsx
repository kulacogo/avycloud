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
        className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-900/60"
      >
        <span className="text-slate-100">{title}</span>
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="mt-2 rounded-xl border border-white/10 bg-slate-950/30 p-3 text-sm text-slate-200"
      >
        {children}
      </div>
    </div>
  );
};

