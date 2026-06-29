// Recipe language — single source of truth for the curated language
// set, shared between client, edge functions (duplicated there since
// Deno can't import RN modules), and the admin alias surface (v1.x).
//
// Per the v1-scope grill (docs/V1_SCOPE_DECISIONS.md):
//   - English + Simplified Chinese only at launch
//   - Traditional Chinese (zh-Hant) is a cheap v1.x add via opencc +
//     targeted re-translation
//   - The `recipes.language` column is text (not an enum) so the list
//     can evolve without a schema migration
//   - Detection is CJK-ratio based on title + description, run at
//     insert time and surfaced as an override chip on the recipe form
//     when the heuristic disagrees with the user's UI language

export const RECIPE_LANGUAGES = ['en', 'zh-Hans'] as const;

export type RecipeLanguage = (typeof RECIPE_LANGUAGES)[number];

export function isRecipeLanguage(s: unknown): s is RecipeLanguage {
  return typeof s === 'string' && (RECIPE_LANGUAGES as readonly string[]).includes(s);
}

/** Human-facing label for the chip + Settings row. Keep in sync with
 *  the App Store metadata localizations (English / 中文). */
export const RECIPE_LANGUAGE_LABEL: Record<RecipeLanguage, string> = {
  en: 'English',
  'zh-Hans': '中文',
};

/**
 * Count Chinese (Hanzi / CJK Unified Ideographs Basic) characters in a
 * string. The range U+4E00–U+9FFF covers ~99% of modern Hanzi for both
 * Simplified and Traditional; we're not trying to discriminate scripts
 * here, just detect "this is meaningfully Chinese."
 *
 * Other CJK ranges (extension blocks, compatibility) are skipped on
 * purpose — they're rare enough in recipe titles that including them
 * complicates the regex without changing accuracy in practice.
 */
function cjkCharCount(s: string): number {
  // Iterate codepoints (not UTF-16 code units) so surrogate pairs
  // don't double-count. For BMP characters in U+4E00–U+9FFF, this
  // matters less in practice, but cleaner to do it right.
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp != null && cp >= 0x4e00 && cp <= 0x9fff) n += 1;
  }
  return n;
}

/**
 * Heuristic language detection from a title + optional description.
 * Returns the best-fit recipe language, or `null` if the input is empty.
 *
 * Threshold: if >20% of characters are Hanzi, classify as `zh-Hans`.
 * Otherwise default to `en`. The threshold is low because Chinese
 * titles are often short (4-6 chars) and any meaningful Hanzi
 * presence is a strong signal.
 *
 * Punctuation, digits, and Latin chars all count toward the
 * denominator, so a title like "200g 番茄" (3 Hanzi out of ~10
 * non-whitespace chars = 30%) lands correctly as zh-Hans.
 */
export function detectRecipeLanguage(
  title: string,
  description?: string | null,
): RecipeLanguage | null {
  const combined = `${title} ${description ?? ''}`.replace(/\s+/g, '');
  if (combined.length === 0) return null;
  const cjk = cjkCharCount(combined);
  const ratio = cjk / combined.length;
  return ratio >= 0.2 ? 'zh-Hans' : 'en';
}
