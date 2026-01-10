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
    fontFamily: {
      // Override Tailwind default font-sans stack to remove "Apple Color Emoji".
      // See: https://tailwindcss.com/docs/font-family
      sans: ['ui-sans-serif', 'system-ui', 'sans-serif', '"Segoe UI Emoji"', '"Segoe UI Symbol"', '"Noto Color Emoji"'],
    },
    extend: {},
  },
  plugins: [],
};

