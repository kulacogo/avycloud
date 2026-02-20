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
      sm: '6px',
      DEFAULT: '8px',
      md: '8px',
      lg: '12px',
      xl: '16px',
      '2xl': '20px',
      '3xl': '24px',
      full: '9999px',
    },
    fontFamily: {
      sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      mono: ['SF Mono', 'Fira Code', 'Consolas', 'ui-monospace', 'monospace'],
    },
    extend: {
      colors: {
        'avy-deep': '#0A2540',
        'avy-purple': {
          DEFAULT: '#635BFF',
          hover: '#5148E5',
          light: '#818CF8',
          glow: 'rgba(99, 91, 255, 0.12)',
        },
      },
      spacing: {
        'sidebar': '248px',
        'topbar': '56px',
      },
    },
  },
  plugins: [],
};
