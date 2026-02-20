import React from 'react';

/* -------------------------------------------------------
   Card
   ------------------------------------------------------- */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className = '', children, ...rest }, ref) => (
    <div
      ref={ref}
      className={`
        bg-[var(--surface)] border border-[var(--border)] rounded-xl
        transition-colors duration-200 hover:border-[var(--border-hover)]
        ${className}
      `.trim()}
      {...rest}
    >
      {children}
    </div>
  )
);
Card.displayName = 'Card';

/* -------------------------------------------------------
   CardHeader
   ------------------------------------------------------- */
export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const CardHeader: React.FC<CardHeaderProps> = ({
  className = '',
  children,
  ...rest
}) => (
  <div
    className={`
      flex items-center justify-between
      px-5 py-3.5 border-b border-[var(--border)]
      ${className}
    `.trim()}
    {...rest}
  >
    {children}
  </div>
);

/* -------------------------------------------------------
   CardTitle
   ------------------------------------------------------- */
export interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export const CardTitle: React.FC<CardTitleProps> = ({
  icon,
  className = '',
  children,
  ...rest
}) => (
  <h3
    className={`
      text-sm font-semibold text-[var(--text-primary)]
      flex items-center gap-2
      ${className}
    `.trim()}
    {...rest}
  >
    {icon && (
      <span className="flex-shrink-0 text-[var(--text-tertiary)] [&>svg]:w-4 [&>svg]:h-4">
        {icon}
      </span>
    )}
    {children}
  </h3>
);

/* -------------------------------------------------------
   CardAction
   ------------------------------------------------------- */
export interface CardActionProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export const CardAction: React.FC<CardActionProps> = ({
  className = '',
  children,
  ...rest
}) => (
  <button
    type="button"
    className={`
      text-xs font-semibold text-[var(--avy-purple)]
      hover:text-[var(--avy-purple-hover)] transition-colors duration-150
      focus-visible:outline-none focus-visible:underline
      ${className}
    `.trim()}
    {...rest}
  >
    {children}
  </button>
);

/* -------------------------------------------------------
   CardBody
   ------------------------------------------------------- */
export interface CardBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const CardBody: React.FC<CardBodyProps> = ({
  className = '',
  children,
  ...rest
}) => (
  <div className={`p-5 ${className}`.trim()} {...rest}>
    {children}
  </div>
);
