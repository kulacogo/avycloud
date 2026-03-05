/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './App.tsx',
    './index.tsx',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  theme: {
    borderRadius: {
      none: '0px',
      sm: 'var(--radius-sm, 6px)',
      DEFAULT: 'var(--radius-md, 8px)',
      md: 'var(--radius-md, 8px)',
      lg: 'var(--radius-lg, 12px)',
      xl: 'var(--radius-xl, 16px)',
      '2xl': 'var(--radius-xl, 16px)',
      '3xl': 'var(--radius-xl, 16px)',
      full: '9999px',
    },
    fontFamily: {
      sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
    },
    extend: {
      colors: {
        // Soft Slate Dark Theme — mapped to CSS variables for theme-awareness
        app: {
          bg: 'var(--bg)',
          sidebar: 'var(--sidebar)',
          surface: 'var(--surface)',
          elevated: 'var(--elevated)',
          border: 'var(--border)',
        },
        txt: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          dim: 'var(--accent-dim)',
        },
        success: {
          DEFAULT: 'var(--success)',
          dim: 'var(--success-dim)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          dim: 'var(--warning-dim)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          dim: 'var(--danger-dim)',
        },
        info: {
          DEFAULT: 'var(--info)',
          dim: 'var(--info-dim)',
        },
      },
      boxShadow: {
        'app': 'var(--shadow)',
      },
      width: {
        'sidebar': '220px',
      },
      minWidth: {
        'sidebar': '220px',
      },
      height: {
        'topbar': '56px',
        'mobile-nav': '64px',
      },
      minHeight: {
        'topbar': '56px',
      },
      keyframes: {
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'modal-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'indeterminate': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        'slide-in-right': 'slide-in-right 0.2s ease-out',
        'modal-in': 'modal-in 0.15s ease-out',
        'indeterminate': 'indeterminate 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

