import React from 'react';

export type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'purple' | 'neutral';

export interface BadgeProps {
  variant?: BadgeVariant;
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  children: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, { container: string; dot: string }> = {
  success: {
    container: 'text-[var(--success)] bg-[var(--success-bg)]',
    dot: 'bg-[var(--success)]',
  },
  warning: {
    container: 'text-[var(--warning)] bg-[var(--warning-bg)]',
    dot: 'bg-[var(--warning)]',
  },
  error: {
    container: 'text-[var(--error)] bg-[var(--error-bg)]',
    dot: 'bg-[var(--error)]',
  },
  info: {
    container: 'text-[var(--info)] bg-[var(--info-bg)]',
    dot: 'bg-[var(--info)]',
  },
  purple: {
    container: 'text-[var(--avy-purple)] bg-[var(--avy-purple-glow)]',
    dot: 'bg-[var(--avy-purple)]',
  },
  neutral: {
    container: 'text-[var(--text-secondary)] bg-[var(--surface-secondary)]',
    dot: 'bg-[var(--text-tertiary)]',
  },
};

const sizeStyles: Record<NonNullable<BadgeProps['size']>, string> = {
  sm: 'px-2 py-0.5 text-2xs',
  md: 'px-3 py-1 text-xs',
};

export const Badge: React.FC<BadgeProps> = React.memo(
  ({ variant = 'neutral', dot = true, size = 'md', className = '', children }) => {
    const styles = variantStyles[variant];

    return (
      <span
        className={`
          rounded-full font-semibold
          inline-flex items-center gap-1.5
          ${sizeStyles[size]}
          ${styles.container}
          ${className}
        `.trim()}
      >
        {dot && (
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${styles.dot}`}
            aria-hidden="true"
          />
        )}
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';
