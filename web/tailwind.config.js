/** @type {import('tailwindcss').Config} */
// IntervueX design tokens. Semantic colours (bg, surface, line, ink, muted…) are CSS variables defined in
// src/styles.css so light and dark mode switch automatically; brand colours are fixed.
const v = name => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        display: ['"Fraunces"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        bg: v('bg'), surface: v('surface'), raised: v('raised'), line: v('line'), ink: v('ink'), muted: v('muted'),
        brand: { 50: '#f1f0ff', 100: '#e4e1ff', 200: '#cbc5ff', 300: '#a99ffd', 400: '#8b7cf8', 500: '#6d5cf0', 600: '#5b45e0', 700: '#4b36c2', 800: '#3d2d9c', 900: '#2b2170', 950: '#1a1446' },
        gold: { 100: '#f8eedb', 200: '#efd9ae', 300: '#e3c07f', 400: '#d4a85a', 500: '#c08f3e', 600: '#9d722f' },
        midnight: { 700: '#1c2340', 800: '#131a33', 900: '#0c1124', 950: '#070b18' },
        ok: v('ok'), warn: v('warn'), danger: v('danger'),
      },
      boxShadow: {
        soft: '0 1px 2px rgb(16 18 40 / 0.04), 0 8px 24px -12px rgb(16 18 40 / 0.12)',
        lift: '0 2px 4px rgb(16 18 40 / 0.04), 0 18px 40px -16px rgb(43 33 112 / 0.28)',
        glow: '0 10px 30px -10px rgb(109 92 240 / 0.55)',
        ring: '0 0 0 4px rgb(109 92 240 / 0.18)',
      },
      borderRadius: { xl: '0.9rem', '2xl': '1.15rem', '3xl': '1.6rem' },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #6d5cf0 0%, #5b45e0 45%, #8a3ffc 100%)',
        'gold-gradient': 'linear-gradient(135deg, #efd9ae 0%, #d4a85a 55%, #c08f3e 100%)',
        'night-gradient': 'linear-gradient(180deg, #0c1124 0%, #131a33 60%, #1a1446 100%)',
      },
      keyframes: {
        'fade-up': { '0%': { opacity: 0, transform: 'translateY(6px)' }, '100%': { opacity: 1, transform: 'none' } },
        pulse2: { '50%': { opacity: 0.25 } },
      },
      animation: { 'fade-up': 'fade-up .35s ease-out both', pulse2: 'pulse2 1.2s infinite' },
    },
  },
  plugins: [],
};
