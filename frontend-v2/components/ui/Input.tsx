import React from 'react';

/* -------------------------------------------------------
   Shared base classes
   ------------------------------------------------------- */
const baseInputClasses = [
  'w-full px-3 py-2.5',
  'bg-[var(--bg)] border border-[var(--border)] rounded-lg',
  'text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]',
  'transition-all duration-200',
  'focus:outline-none focus:border-[var(--avy-purple)] focus:shadow-[var(--shadow-focus)]',
].join(' ');

const readOnlyClasses = 'bg-[var(--surface-secondary)] text-[var(--text-secondary)] cursor-default';
const errorClasses = 'border-[var(--error)] focus:border-[var(--error)] focus:shadow-[0_0_0_3px_rgba(220,38,38,0.12)]';
const monoClasses = 'font-mono';

/* -------------------------------------------------------
   Input
   ------------------------------------------------------- */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  mono?: boolean;
  error?: string;
  hint?: string;
  icon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      mono = false,
      error,
      hint,
      icon,
      readOnly = false,
      className = '',
      id,
      ...rest
    },
    ref
  ) => {
    const inputId = id || (label ? `input-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] [&>svg]:w-4 [&>svg]:h-4">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            readOnly={readOnly}
            className={`
              ${baseInputClasses}
              ${icon ? 'pl-9' : ''}
              ${readOnly ? readOnlyClasses : ''}
              ${error ? errorClasses : ''}
              ${mono ? monoClasses : ''}
              ${className}
            `.trim()}
            {...rest}
          />
        </div>
        {error && (
          <p className="text-xs text-[var(--error)] flex items-center gap-1">
            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </p>
        )}
        {hint && !error && (
          <p className="text-xs text-[var(--text-tertiary)]">{hint}</p>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';

/* -------------------------------------------------------
   TextArea
   ------------------------------------------------------- */
export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  mono?: boolean;
  error?: string;
  hint?: string;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  (
    {
      label,
      mono = false,
      error,
      hint,
      readOnly = false,
      className = '',
      id,
      ...rest
    },
    ref
  ) => {
    const inputId = id || (label ? `textarea-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide"
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          readOnly={readOnly}
          className={`
            ${baseInputClasses}
            min-h-[140px] resize-y
            ${readOnly ? readOnlyClasses : ''}
            ${error ? errorClasses : ''}
            ${mono ? monoClasses : ''}
            ${className}
          `.trim()}
          {...rest}
        />
        {error && (
          <p className="text-xs text-[var(--error)] flex items-center gap-1">
            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </p>
        )}
        {hint && !error && (
          <p className="text-xs text-[var(--text-tertiary)]">{hint}</p>
        )}
      </div>
    );
  }
);
TextArea.displayName = 'TextArea';

/* -------------------------------------------------------
   Select
   ------------------------------------------------------- */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  options: SelectOption[];
  error?: string;
  hint?: string;
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      options,
      error,
      hint,
      placeholder,
      className = '',
      id,
      ...rest
    },
    ref
  ) => {
    const inputId = id || (label ? `select-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined);

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-semibold text-[var(--text-secondary)] tracking-wide"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            id={inputId}
            className={`
              ${baseInputClasses}
              appearance-none pr-9 cursor-pointer
              ${error ? errorClasses : ''}
              ${className}
            `.trim()}
            {...rest}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
          {/* Chevron */}
          <svg
            className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)] pointer-events-none"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </div>
        {error && (
          <p className="text-xs text-[var(--error)] flex items-center gap-1">
            <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            {error}
          </p>
        )}
        {hint && !error && (
          <p className="text-xs text-[var(--text-tertiary)]">{hint}</p>
        )}
      </div>
    );
  }
);
Select.displayName = 'Select';
