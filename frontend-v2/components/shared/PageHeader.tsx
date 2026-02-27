import React from 'react';

type Props = {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
};

export const PageHeader: React.FC<Props> = ({ title, subtitle, right, children }) => {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-2xl font-bold text-[var(--text-primary)] tracking-tight leading-tight">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-1 text-[13px] text-[var(--text-tertiary)]">{subtitle}</div>
          ) : null}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
};
