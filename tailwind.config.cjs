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
      none: '0',
      sm: '1%',
      DEFAULT: '1%',
      md: '1%',
      lg: '1%',
      xl: '1%',
      '2xl': '1%',
      '3xl': '1%',
      full: '1%',
    },
    extend: {},
  },
  plugins: [],
};

