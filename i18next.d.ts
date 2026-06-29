// i18next TypeScript module augmentation. Gives compile-time safety
// + IDE autocomplete on every t('key') call:
//
//   const { t } = useTranslation('recipe-form');
//   t('title.label')        // ✓ autocompletes
//   t('title.labl')         // ✗ compile error
//
// Resources are inferred from the actual JSON imports in lib/i18n.ts,
// so adding a key to locales/en/recipe-form.json is automatically
// available + typed at every callsite. No regeneration needed.
//
// See docs/I18N_DECISIONS.md (I3) for why this is set up.

import type { RESOURCES, NAMESPACES } from '@/lib/i18n';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: (typeof RESOURCES)['en'];
    // Disallow `returnNull` so t() always returns string (matches our
    // i18n config's `returnNull: false`). Without this, every t() call
    // would type as `string | null` and need narrowing at every JSX use.
    returnNull: false;
  }
}

// Re-export NAMESPACES type for any caller that wants to iterate them
// in a typed way (e.g. a Settings debug screen listing all namespaces).
export type Namespace = (typeof NAMESPACES)[number];
