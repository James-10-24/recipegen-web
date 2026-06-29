// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const i18nextPlugin = require('eslint-plugin-i18next');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  // i18n enforcement — flag inline string literals in JSX so future
  // additions go through the t() helper instead of regressing the
  // bilingual surface. Set to 'error' once every surface migrated;
  // CI will now fail on any new untranslated copy.
  //
  // See docs/I18N_DECISIONS.md for the full grill output that drives
  // the enforcement decision (manual screen-by-screen migration with
  // ESLint at the end was the locked answer to "how do we prevent
  // regression once shipped").
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    ignores: [
      // SF Symbol name literals — programmatic identifiers, not copy.
      'components/ui/**',
      // EULA + Privacy Policy stay English-only. These are legally
      // binding documents; a casual translation would set obligations
      // that may not match the English text. A Chinese version
      // requires actual legal review (Singapore PDPA / Malaysian
      // PDPA / GDPR equivalence) before we ship it. v1 ships the
      // English copy and surfaces both links from Settings unchanged
      // for Chinese users; v1.1 grills the translation with a
      // lawyer before publishing.
      'app/eula.tsx',
      'app/privacy.tsx',
    ],
    plugins: { i18next: i18nextPlugin },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          'should-validate-template': true,
          words: {
            exclude: [
              // Single-char chrome glyphs — icons, not copy.
              '·',
              '←',
              '→',
              '↑',
              '↓',
              '‹',
              '›',
              '↺',
              '✓',
              '●',
              '—',
              '⋯',
              '+',
              '−',
              '×',
              '#',
              // Emoji icons used as glyphs (lock, etc.). Lives here
              // for the same reason as the SF Symbol exception
              // above: chrome-only, no translation needed.
              '🔒',
              // Brand names — never translated per docs/I18N_DECISIONS.md.
              'RecipeGen',
              'Pantry Pro',
              'Apple ID',
              'Discover',
            ],
          },
        },
      ],
    },
  },
]);
