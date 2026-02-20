import React from 'react';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeMap: Record<NonNullable<SpinnerProps['size']>, string> = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-9 h-9',
};

export const Spinner: React.FC<SpinnerProps> = React.memo(({ size = 'md', className = '' }) => (
  <div
    className={`
      ${sizeMap[size]}
      border-2 border-[var(--border)] border-t-[var(--avy-purple-light)]
      rounded-full animate-spin
      ${className}
    `.trim()}
    role="status"
    aria-label="Loading"
  />
));

Spinner.displayName = 'Spinner';
