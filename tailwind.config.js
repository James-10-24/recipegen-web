/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Fraunces_400Regular'],
        'serif-medium': ['Fraunces_500Medium'],
        'serif-bold': ['Fraunces_700Bold'],
        'serif-bold-italic': ['Fraunces_700Bold_Italic'],
        // System sans — SF Pro on iOS, Roboto on Android, Segoe UI on
        // Windows. Used deliberately on dense reading content (lists,
        // tabular numbers, settings rows) where SF Pro's tighter
        // metrics speed scanning. Fraunces stays for editorial spine
        // (headlines, eyebrows, ingredient names, long-form prose).
        sans: ['System'],
      },
      colors: {
        // Single warm brand accent — used SPARINGLY across the app and
        // the marketing site. Surfaces: brand mark on sign-in, eyebrow
        // text on ceremony / empty / success states, italic byline
        // names. Never body text, never primary buttons (those stay
        // black). Matches the --accent CSS variable in web/style.css.
        terracotta: {
          50: '#faf0e8',
          100: '#f3dccb',
          200: '#e6b89a',
          300: '#d49169',
          400: '#bd6a3d',
          500: '#a4501f',
          600: '#8c3a1a',
          700: '#702c14',
          800: '#542010',
          900: '#3b160c',
        },
        // Second brand accent — muted forest green for "in-stock /
        // covered / good-food" semantic states. The palette's primary
        // (-700) is intentionally desaturated from the punchy default
        // (#059669 → #0d7a55) so it sits comfortably alongside the
        // warm-cream background and the terracotta primary, instead
        // of vibrating against them. Pairing: terracotta = brand /
        // moments. forest = "this ingredient is yours" / coverage
        // status. Two distinct semantic roles.
        forest: {
          50: '#ecf5f1',
          100: '#cee6da',
          200: '#a3cdb6',
          300: '#74b18f',
          400: '#4d966c',
          500: '#2c7e54',
          600: '#1a6a44',
          700: '#0d7a55',
          800: '#085436',
          900: '#053827',
        },
      },
    },
  },
  plugins: [],
};
