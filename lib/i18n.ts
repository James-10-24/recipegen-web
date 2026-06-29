// i18next bootstrap — initializes once on app boot. See
// docs/I18N_DECISIONS.md for the full grill output that drives every
// option here.
//
// Resource loading: eager-load both languages on init. The full JSON
// is ~60 KB; lazy-loading per-namespace would add complexity without
// meaningful bundle benefit at this scale.
//
// Provider: not needed at this i18next/react-i18next version pair —
// `initReactI18next` registers the singleton and `useTranslation` reads
// it directly. We just import this module once from `app/_layout.tsx`
// to trigger init before any screen renders.

import { getLocales } from 'expo-localization';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

// English (source of truth for the typed Resources interface).
import enCommon from '@/locales/en/common.json';
import enErrors from '@/locales/en/errors.json';
import enOnboarding from '@/locales/en/onboarding.json';
import enAuth from '@/locales/en/auth.json';
import enPaywall from '@/locales/en/paywall.json';
import enSettings from '@/locales/en/settings.json';
import enRecipeForm from '@/locales/en/recipe-form.json';
import enRecipeDetail from '@/locales/en/recipe-detail.json';
import enRecipeList from '@/locales/en/recipe-list.json';
import enDiscover from '@/locales/en/discover.json';
import enPantry from '@/locales/en/pantry.json';
import enPlan from '@/locales/en/plan.json';
import enShop from '@/locales/en/shop.json';

// Simplified Chinese.
import zhCommon from '@/locales/zh-Hans/common.json';
import zhErrors from '@/locales/zh-Hans/errors.json';
import zhOnboarding from '@/locales/zh-Hans/onboarding.json';
import zhAuth from '@/locales/zh-Hans/auth.json';
import zhPaywall from '@/locales/zh-Hans/paywall.json';
import zhSettings from '@/locales/zh-Hans/settings.json';
import zhRecipeForm from '@/locales/zh-Hans/recipe-form.json';
import zhRecipeDetail from '@/locales/zh-Hans/recipe-detail.json';
import zhRecipeList from '@/locales/zh-Hans/recipe-list.json';
import zhDiscover from '@/locales/zh-Hans/discover.json';
import zhPantry from '@/locales/zh-Hans/pantry.json';
import zhPlan from '@/locales/zh-Hans/plan.json';
import zhShop from '@/locales/zh-Hans/shop.json';

/** Curated namespace list. Adding a new namespace = create the JSON
 *  in both languages, add to the imports above + RESOURCES below, and
 *  the typed Resources interface in i18next.d.ts picks it up. */
export const NAMESPACES = [
  'common',
  'errors',
  'onboarding',
  'auth',
  'paywall',
  'settings',
  'recipe-form',
  'recipe-detail',
  'recipe-list',
  'discover',
  'pantry',
  'plan',
  'shop',
] as const;

export const RESOURCES = {
  en: {
    common: enCommon,
    errors: enErrors,
    onboarding: enOnboarding,
    auth: enAuth,
    paywall: enPaywall,
    settings: enSettings,
    'recipe-form': enRecipeForm,
    'recipe-detail': enRecipeDetail,
    'recipe-list': enRecipeList,
    discover: enDiscover,
    pantry: enPantry,
    plan: enPlan,
    shop: enShop,
  },
  'zh-Hans': {
    common: zhCommon,
    errors: zhErrors,
    onboarding: zhOnboarding,
    auth: zhAuth,
    paywall: zhPaywall,
    settings: zhSettings,
    'recipe-form': zhRecipeForm,
    'recipe-detail': zhRecipeDetail,
    'recipe-list': zhRecipeList,
    discover: zhDiscover,
    pantry: zhPantry,
    plan: zhPlan,
    shop: zhShop,
  },
} as const;

// Initialize synchronously so the first render already has resources.
// react-i18next's useTranslation will read from this singleton.
//
// The actual UI language is set by lib/ui-language.ts on app boot
// (which subscribes to expo-localization + the AsyncStorage override).
// We default to 'en' here so initial render never sees a missing-lang
// warning; useUiLanguage.changeLanguage() takes over within a tick.
// Resolve the initial language from device locale so the first render
// already shows zh-Hans on Chinese devices (no flash of English). The
// user's explicit override from AsyncStorage is applied later by
// useUiLanguage's first effect — that's an async read so it can't
// happen here, but the override case is rare (most users keep device
// default). For the common case, this gets the user to their language
// immediately.
function initialLanguage(): string {
  const tag = getLocales()[0]?.languageTag ?? 'en';
  return tag.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en';
}

if (!i18next.isInitialized) {
  i18next.use(initReactI18next).init({
    lng: initialLanguage(),
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: NAMESPACES as unknown as string[],
    resources: RESOURCES,
    interpolation: {
      escapeValue: false, // React already escapes
    },
    // Warn on missing keys in dev so the team catches "added to en,
    // forgot zh-Hans" before review. Production silently falls back
    // to English (which fallbackLng above resolves).
    saveMissing: __DEV__,
    missingKeyHandler: __DEV__
      ? (lngs, ns, key) => {
          console.warn(
            `[i18n] missing key: ${ns}:${key} (lang: ${lngs.join(',')})`,
          );
        }
      : undefined,
    // Pluralization is built-in via _one / _other suffixes; no plugin
    // needed for en+zh-Hans (Chinese has no plural forms; i18next
    // routes to _other automatically per CLDR rules).
    returnNull: false,
  });
}

export { i18next };
export default i18next;
