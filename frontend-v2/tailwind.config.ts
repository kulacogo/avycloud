import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        avy: {
          deep: '#0A2540',
          purple: '#635BFF',
          'purple-hover': '#5148E5',
          'purple-light': '#818CF8',
          'purple-glow': 'rgba(99, 91, 255, 0.12)',
          blue: '#0070F3',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
          secondary: 'var(--surface-secondary)',
        },
        border: {
          DEFAULT: 'var(--border)',
          hover: 'var(--border-hover)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
        },
        success: {
          DEFAULT: '#0E9F6E',
          bg: 'var(--success-bg)',
          border: 'var(--success-border)',
        },
        warning: {
          DEFAULT: '#D97706',
          bg: 'var(--warning-bg)',
          border: 'var(--warning-border)',
        },
        error: {
          DEFAULT: '#DC2626',
          bg: 'var(--error-bg)',
          border: 'var(--error-border)',
        },
        info: {
          DEFAULT: '#0070F3',
          bg: 'var(--info-bg)',
          border: 'var(--info-border)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', '14px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        lg: ['16px', '24px'],
        xl: ['18px', '26px'],
        '2xl': ['22px', '30px'],
        '3xl': ['28px', '36px'],
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
      spacing: {
        '4.5': '18px',
        '13': '52px',
        '15': '60px',
        sidebar: '248px',
      },
      boxShadow: {
        sm: '0 1px 1px rgba(0,0,0,0.03), 0 3px 6px rgba(0,0,0,0.02)',
        md: '0 2px 4px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)',
        lg: '0 4px 8px rgba(0,0,0,0.04), 0 16px 48px rgba(0,0,0,0.08)',
        focus: '0 0 0 3px rgba(99, 91, 255, 0.12)',
      },
      transitionTimingFunction: {
        avy: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      animation: {
        'slide-up': 'slideUp 300ms ease',
        'slide-down': 'slideDown 200ms cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fadeIn 150ms ease',
        'toast-in': 'toastIn 400ms cubic-bezier(0.16, 1, 0.3, 1)',
        'toast-out': 'toastOut 300ms ease forwards',
        pulse: 'pulse 2s infinite',
        shrink: 'shrink 5s linear forwards',
      },
      keyframes: {
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          from: { opacity: '0', transform: 'translateY(-8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        toastIn: {
          from: { opacity: '0', transform: 'translateY(16px) scale(0.96)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        toastOut: {
          to: { opacity: '0', transform: 'translateY(-8px) scale(0.96)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        shrink: {
          from: { width: '100%' },
          to: { width: '0%' },
        },
      },
    },
  },
  plugins: [],
}

export default config
