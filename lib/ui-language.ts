// UI language — the language of the app's chrome (menus, buttons,
// onboarding, error copy). Distinct from `recipes.language`, which
// tags the language of an individual recipe's content. A user can
// have UI in Chinese while saving English recipes (and vice versa).
//
// Resolution order (per the v1-scope grill, docs/V1_SCOPE_DECISIONS.md):
//   1. Explicit user override stored in AsyncStorage (Settings → Language)
//   2. Device locale via expo-localization, mapped to nearest RECIPE_LANGUAGES value
//   3. Fallback to 'en'
//
// The hook reads (1) on mount and exposes a setter that updates both
// AsyncStorage and the in-memory cache so subscribers re-render. No
// global state library needed — drives via React state + a module-level
// listener registry that mirrors useEntitlement's pattern.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import i18next from 'i18next';
import { useEffect, useState } from 'react';

import {
  RECIPE_LANGUAGES,
  isRecipeLanguage,
  type RecipeLanguage,
} from '@/lib/recipe-language';

const STORAGE_KEY = 'ui-language:override';

/** Map an arbitrary IETF locale tag onto the closest curated language.
 *  expo-localization returns tags like 'zh-Hans-CN', 'zh-Hant-TW',
 *  'en-US', 'en-GB' — we normalize to our two-value set.
 *
 *  Traditional Chinese (zh-Hant) folds into zh-Hans for v1; v1.x adds
 *  zh-Hant proper. The reasoning: zh-Hant readers can read zh-Hans with
 *  effort, and English would be a worse default for them. */
export function normalizeLocaleToRecipeLanguage(
  locale: string | null | undefined,
): RecipeLanguage {
  if (!locale) return 'en';
  const lower = locale.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-Hans';
  return 'en';
}

// In-memory cache + listener registry. Lets multiple components stay in
// sync after a Settings flip without a global state library. Pattern
// mirrors lib/entitlements.ts.
let cachedOverride: RecipeLanguage | null | undefined = undefined; // undefined = not yet loaded
const listeners = new Set<(v: RecipeLanguage | null) => void>();

function notify(v: RecipeLanguage | null) {
  cachedOverride = v;
  listeners.forEach((cb) => cb(v));
  // Mirror the effective language into i18next so every t() call in
  // the tree re-resolves to the new language on the next render.
  // Computing "effective" needs the device-locale fallback that
  // useUiLanguage exposes; we duplicate that resolution here so the
  // i18next side-effect doesn't depend on which component fired it.
  const deviceLang = normalizeLocaleToRecipeLanguage(
    getLocales()[0]?.languageTag ?? 'en',
  );
  const effective = v ?? deviceLang;
  if (i18next.language !== effective) {
    void i18next.changeLanguage(effective);
  }
}

async function loadOverrideFromStorage(): Promise<RecipeLanguage | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return isRecipeLanguage(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Read the current UI language. Returns a tuple of:
 *    `[language, setLanguage]` — set to null to clear the override and
 *    fall back to device locale auto-detection.
 *
 *  On first mount, returns the device-locale-normalized value while the
 *  storage read is in flight (no loading state — UI shouldn't flash). */
export function useUiLanguage(): readonly [
  RecipeLanguage,
  (next: RecipeLanguage | null) => Promise<void>,
] {
  // Device locale is sync via expo-localization; use it as the immediate
  // default. The async storage read overrides if there's an explicit
  // user pick.
  const deviceLocale = getLocales()[0]?.languageTag ?? 'en';
  const deviceLang = normalizeLocaleToRecipeLanguage(deviceLocale);

  const [override, setOverride] = useState<RecipeLanguage | null>(
    cachedOverride === undefined ? null : cachedOverride,
  );

  useEffect(() => {
    // First-load read from AsyncStorage if not cached yet.
    if (cachedOverride === undefined) {
      void (async () => {
        const stored = await loadOverrideFromStorage();
        cachedOverride = stored;
        setOverride(stored);
      })();
    }
    // Subscribe to future updates.
    const listener = (v: RecipeLanguage | null) => setOverride(v);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const setLanguage = async (next: RecipeLanguage | null): Promise<void> => {
    try {
      if (next === null) {
        await AsyncStorage.removeItem(STORAGE_KEY);
      } else {
        await AsyncStorage.setItem(STORAGE_KEY, next);
      }
      notify(next);
    } catch {
      // Storage write failed (full disk / corrupted). Update in-memory
      // anyway so the UI reflects the user's choice for this session.
      notify(next);
    }
  };

  return [override ?? deviceLang, setLanguage] as const;
}

/** Non-reactive one-shot lookup, useful inside event handlers / async
 *  flows where you don't want a hook subscription. Returns the same
 *  resolution order as useUiLanguage. */
export async function getUiLanguageOnce(): Promise<RecipeLanguage> {
  const stored = await loadOverrideFromStorage();
  if (stored) return stored;
  const deviceLocale = getLocales()[0]?.languageTag ?? 'en';
  return normalizeLocaleToRecipeLanguage(deviceLocale);
}

// Re-export for convenience so callers don't need to import from two
// places when they're writing Settings or chip rows.
export { RECIPE_LANGUAGES, type RecipeLanguage };
