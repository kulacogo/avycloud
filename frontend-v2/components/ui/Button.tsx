import React from 'react';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: [
    'bg-[var(--avy-purple)] text-white',
    'hover:bg-[var(--avy-purple-hover)]',
    'hover:translate-y-[-1px]',
    'hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)]',
    'active:translate-y-0',
  ].join(' '),
  secondary: [
    'bg-[var(--surface)] text-[var(--text-secondary)]',
    'border border-[var(--border)]',
    'hover:border-[var(--border-hover)]',
    'hover:shadow-sm',
  ].join(' '),
  ghost: [
    'bg-transparent text-[var(--text-secondary)]',
    'hover:bg-[var(--surface-secondary)]',
  ].join(' '),
  danger: [
    'bg-[var(--error-bg)] text-[var(--error)]',
    'border border-[var(--error-border)]',
    'hover:bg-[var(--error)] hover:text-white',
  ].join(' '),
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3.5 py-2 text-[13px]',
  lg: 'px-5 py-2.5 text-sm',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      icon,
      loading = false,
      disabled = false,
      className = '',
      children,
      type = 'button',
      ...rest
    },
    ref
  ) => {
    const isDisabled = disabled || loading;

    return (
      <button
        ref={ref}
        type={type}
        disabled={isDisabled}
        className={`
          inline-flex items-center justify-center gap-1.5
          rounded-lg font-semibold
          transition-all duration-200
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--avy-purple)] focus-visible:ring-offset-1
          disabled:cursor-not-allowed
          ${variantStyles[variant]}
          ${sizeStyles[size]}
          ${loading ? 'pointer-events-none opacity-70' : ''}
          ${isDisabled && !loading ? 'opacity-50' : ''}
          ${className}
        `.trim()}
        {...rest}
      >
        {loading ? (
          <Spinner size="sm" />
        ) : icon ? (
          <span className="flex-shrink-0 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>
        ) : null}
        {children && <span>{children}</span>}
      </button>
    );
  }
);

Button.displayName = 'Button';
