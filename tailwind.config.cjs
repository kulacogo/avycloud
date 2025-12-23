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
      sm: '8px',
      DEFAULT: '8px',
      md: '8px',
      lg: '8px',
      xl: '8px',
      '2xl': '8px',
      '3xl': '8px',
      full: '8px',
    },
    extend: {},
  },
  plugins: [],
};

