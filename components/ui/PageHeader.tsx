import React from 'react';

type Props = {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
};

export const PageHeader: React.FC<Props> = ({ title, subtitle, right, children }) => {
  return (
    <div className="rounded-2xl border border-app-border bg-app-bg/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-txt-primary">{title}</div>
          {subtitle ? <div className="mt-1 text-sm text-txt-muted">{subtitle}</div> : null}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
};

