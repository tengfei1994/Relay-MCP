/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'rgb(var(--ink) / <alpha-value>)',
        mint: 'rgb(var(--mint) / <alpha-value>)',
        sun: 'rgb(var(--sun) / <alpha-value>)',
        coral: 'rgb(var(--coral) / <alpha-value>)',
        iris: 'rgb(var(--iris) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: { ctl: '8px', field: '10px', panel: '16px', plate: '24px' },
      borderColor: { line: 'var(--line)', 'line-strong': 'var(--line-strong)' },
    },
  },
  plugins: [],
};
