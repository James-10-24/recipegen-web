# i18n decisions

Captured from the UI-strings i18n grill on 2026-05-25. Locks the
library, file structure, key convention, plural / fallback behavior,
extraction strategy, translation workflow, and shipping target for
moving ~1000 inline JSX strings into a typed, two-language translation
system (English + Simplified Chinese).

Companion to [V1_SCOPE_DECISIONS.md](V1_SCOPE_DECISIONS.md) (which
locked "zh-Hans IN v1") and the localization commits already shipped
(`b13bd58` backend, `bf9c02e` UI hook/picker/chip/badge, `a7c87b6` →
`713f6bb` admin alias surface). Those decisions handle the language
*storage* + *detection*; this doc handles the UI *strings* themselves.

---

## Locked decisions

| # | Decision | Pick |
|---|---|---|
| I1 | Library | `i18next` + `react-i18next` (~30 KB gz) |
| I2 | File structure | Per-namespace JSON, ~13 namespaces |
| I3 | Typed keys | Yes — `i18next.d.ts` module augmentation |
| I4 | Key naming | Nested 2-3 levels, camelCase, no NS prefix in keys |
| I5 | Pluralization | i18next built-in `_one` / `_other` (CLDR rules) |
| I6 | Extraction | Manual, screen-by-screen, ESLint enforcement at end |
| I7 | Translation workflow | AI batch (Claude) → human review, per namespace |
| I8 | Fallback | Fall back to `en`; dev `console.warn` on missing |
| I9 | Ship timing | **All-or-nothing — all 13 namespaces translated before v1** |

### Implicit defaults (didn't need to grill)

- **Interpolation:** `{{name}}` (i18next default)
- **Dates / times / numbers:** `Intl.*` APIs with explicit locale arg
- **Bundle load:** eager-load both languages (~60 KB total JSON, not worth lazy-loading)
- **ESLint enforcement:** `eslint-plugin-i18next` `no-literal-string` rule, applied AFTER foundation lands so existing inline strings don't drown the CI signal

---

## Namespace map

13 namespaces, one JSON file each, organized by app surface:

| Namespace | Approx keys | Covers |
|---|---|---|
| `common` | ~40 | Generic buttons (Cancel, Save, OK, Discard, Done), action labels reused across screens |
| `errors` | ~50 | "Couldn't load", "Try again", network failure copy, generic alert headers |
| `onboarding` | ~50 | 2-slide hybrid + household editor |
| `auth` | ~80 | Sign-in, sign-up, change-password, SIWA, reset, guest branching |
| `paywall` | ~40 | Pantry Pro headline, plan descriptions, restore purchases |
| `settings` | ~100 | Profile, household, language picker, account, blocks, reports |
| `recipe-form` | ~120 | Create/edit form (the densest screen — title, description, category, language override chip, tags, visibility, servings, prep/cook, ingredients picker, steps, drafts) |
| `recipe-detail` | ~80 | Detail screen, share builder, cook flow, save-as-clone |
| `recipe-list` | ~30 | Library tab (Recipes), guest/free counters, empty states |
| `discover` | ~50 | Public library, search, language + category chips, byline, report sheets |
| `pantry` | ~80 | Pantry CRUD + snap flow + review |
| `plan` | ~80 | Calendar week view, picker, cook history annotations |
| `shop` | ~80 | Smart grocery list, waste flags, shop mode, past ranges |

**Total: ~880 keys.** Allow ~10% growth for the inevitable strings I miss → ~1000 keys.

---

## File layout

```
locales/
  en/
    common.json
    errors.json
    onboarding.json
    auth.json
    paywall.json
    settings.json
    recipe-form.json
    recipe-detail.json
    recipe-list.json
    discover.json
    pantry.json
    plan.json
    shop.json
  zh-Hans/
    (same 13 files, mirrored)
```

Each file is a nested JSON object, 2-3 levels deep, keys in camelCase:

```jsonc
// locales/en/recipe-form.json
{
  "title": {
    "label": "Title",
    "placeholder": "e.g. Spaghetti aglio e olio",
    "requiredHint": "· Required"
  },
  "ingredients": {
    "label": "Ingredients",
    "atLeastOne": "· At least one",
    "addButton": "+ Add ingredient",
    "removeButton": "Remove",
    "qtyPlaceholder": "Qty",
    "unitPlaceholder": "Unit",
    "notesPlaceholder": "Notes (e.g. finely chopped)"
  },
  "ingredientCount_one": "{{count}} ingredient",
  "ingredientCount_other": "{{count}} ingredients"
}
```

Usage in components:

```tsx
import { useTranslation } from 'react-i18next';

function RecipeForm() {
  const { t } = useTranslation('recipe-form');
  return (
    <>
      <Text>{t('title.label')}</Text>
      <TextInput placeholder={t('title.placeholder')} />
      <Text>{t('ingredients.label')}</Text>
      <Text>{t('ingredientCount', { count: rows.length })}</Text>
    </>
  );
}
```

---

## Implementation roadmap

15 commits total, expected over multiple sessions.

### Commit 1 — Foundation

- `npm install i18next react-i18next`
- New `lib/i18n.ts`:
  - Import all 13 namespace JSONs (both languages) statically
  - Configure: `fallbackLng: 'en'`, `defaultNS: 'common'`, `interpolation.escapeValue: false` (React already escapes)
  - `missingKeyHandler` → `console.warn` in dev only
  - Call `i18n.use(initReactI18next).init({ ... })` synchronously so first render has resources loaded
- New `i18next.d.ts` at the repo root — module augmentation declaring `Resources` type from imports, plus `defaultNS`
- Wire to `useUiLanguage` in `lib/ui-language.ts`:
  - Subscribe to language changes; call `i18n.changeLanguage(next)` when override fires
  - First mount: set i18n language from the resolved UI language
- 13 namespace JSON skeleton files for both languages (`{}` empty)
- Migrate `components/recipe-form.tsx` end-to-end as the canonical first screen:
  - All inline strings → `t('key')` calls (`useTranslation('recipe-form')`)
  - Populate `locales/en/recipe-form.json` with English values
  - Translate to `locales/zh-Hans/recipe-form.json` via AI batch + review
- Verify type-check passes; verify the form renders correctly in both languages
- Single commit, push

### Commits 2..14 — Per-namespace migrations

One commit per namespace, in this order (user-visibility first → admin/debug last):

1. `common` — shared buttons referenced by every later commit
2. `onboarding` — first impression
3. `auth` — sign-in / sign-up / change-password / SIWA
4. `paywall`
5. `settings` — language picker copy lives here so the chip self-translates
6. `recipe-list` (Recipes tab)
7. `recipe-detail`
8. `discover`
9. `pantry`
10. `plan`
11. `shop`
12. `errors` — generic error copy (last because every other commit may need to pull strings into it)

Each commit follows the same template:

1. Open the screen's `.tsx` files; replace every inline string with `t('key')`
2. Add keys to `locales/en/<ns>.json` (or organize new nesting if needed)
3. AI-batch translate via the prompt in the appendix below; paste output into `locales/zh-Hans/<ns>.json`
4. Human review: scan for tone, formality, brand-name preservation
5. Type-check + lint
6. Commit; PR title = `i18n: migrate <namespace>`

### Commit 15 — ESLint enforcement

- Install `eslint-plugin-i18next`
- Enable `i18next/no-literal-string` with `markupOnly: true` (only flag JSX literals, not regular code strings)
- Add exceptions for: tests, dev-only debug, app.json strings, brand names (`"Pantry Pro"`, `"RecipeGen"`)
- Fix any remaining literals the migration commits missed
- Commit

---

## Translation workflow

Per namespace, after the English JSON is complete:

1. Open Claude (or ChatGPT — Claude recommended for Chinese cultural register)
2. Paste the brand-voice prompt below + the full namespace JSON
3. Receive the zh-Hans JSON
4. Drop into `locales/zh-Hans/<namespace>.json`
5. Review during PR:
   - Tone — does it match the editorial restraint of the English source?
   - Brand names — `Pantry Pro`, `RecipeGen`, `Discover`, `Pantry` should stay English
   - Technical terms — `推送通知` for "push notification" vs `通知` for "notification" — pick the one the English source implies
   - Interpolation placeholders — `{{count}}`, `{{name}}` should be byte-identical
   - Pluralization — Chinese has no plural forms; if English has `_one` + `_other`, the Chinese can collapse to one `_other` key OR keep both with identical values (i18next handles either)
6. If unsure on a few keys, leave the English value as a placeholder + mark with a TODO comment in the JSON

### Brand-voice translation prompt

Use this verbatim. Pinning the prompt in the doc keeps every namespace's
translation tone consistent.

```
Translate this i18next namespace JSON from English to Simplified Chinese (zh-Hans).

RULES:
1. Translate VALUES only. Keys, structure, and interpolation placeholders
   ({{name}}, {{count}}, etc.) stay BYTE-IDENTICAL.
2. Pluralization: i18next uses _one and _other suffix keys. Chinese has no
   plural forms — collapse _one and _other to a single _other key if they
   would translate identically. Otherwise keep both keys with the same
   Chinese value.
3. BRAND VOICE: the source is editorial, restrained, no exclamation marks,
   no marketing copy, no "engagement-bait." Match that tone in Chinese.
   Examples:
     - English "Save my account →" → zh-Hans "保存我的账户 →"  (NOT "马上保存！")
     - English "An empty shelf." → zh-Hans "空空的食谱架。"  (italic literary tone)
4. BRAND NAMES stay English: "Pantry Pro", "RecipeGen", "Pantry" (the tab
   name), "Discover" (the tab name).
5. UNITS: keep narrative units in Chinese (克 instead of "g" in body text),
   but structured units in a "200 g" pattern stay as the user typed them.
6. NUMBERS / DATES: stay in their interpolation placeholders.
7. ARROWS (→): keep them.
8. Return ONLY the JSON, valid and parseable, no commentary.

INPUT:
<paste namespace JSON here>
```

---

## Why each pick (compressed)

### I1 — i18next + react-i18next

- Ecosystem standard for RN. Namespaces, ICU plurals (via built-in count helper, no plugin needed for our use case), dev tools, Suspense, hot reload.
- Bundle (~30 KB gz) is 0.5% of a typical Expo bundle.
- Scales to 5+ languages without re-architecture; i18n-js creaks past 3.
- Rejected: `i18n-js` (lighter but flat namespace gets unwieldy at 1000 keys), `react-intl / FormatJS` (heavier, ICU-purist, overkill), custom (reinventing plural rules is busywork).

### I2 — Per-namespace JSON

- PR review story: a 30-string addition to recipe-form shows up as one file in the diff, not a 60KB single-file scroll.
- Translator-friendly: JSON is the universal interchange format; Claude/ChatGPT translate it natively.
- Lazy-load capable later if needed (not in v1, but free option).
- Namespace boundaries naturally match screen boundaries → ~80 keys per file → reviewable size.

### I3 — Typed keys (`i18next.d.ts`)

- Compile-time safety on `t('settings.account.signOut')` — typos become build errors.
- Autocomplete in IDE → tractable DX at 1000-key scale.
- Refactor-safe — rename a key, every callsite flagged.
- ~15-line setup; zero runtime cost.

### I4 — Nested 2-3 levels, camelCase, no NS prefix

- Nesting groups related strings — scannable for both reviewer + translator.
- No namespace prefix in keys because `useTranslation('ns')` already namespaces.
- camelCase matches TypeScript convention.
- Rejected: flat (harder to scan groups), free-form sentence keys (breaks the moment English changes), snake_case (less idiomatic in JS).

### I5 — Built-in `_one` / `_other`

- CLDR-aware; Chinese auto-routes to `_other` (no plural forms), English uses `_one` + `_other` correctly.
- Zero setup — no plugin install.
- Rejected: `i18next-icu` (more powerful but unneeded for 2 LTR languages), manual ternaries (scattered logic, breaks parity with translator).

### I6 — Manual screen-by-screen + ESLint at end

- Per-screen migration commits are small + reviewable.
- ESLint enforcement at the end (not start) prevents thousands of pre-existing-warnings drowning out signal.
- Rejected: AST extraction scripts (the cleverness costs more time than manual saves), big-bang single commit (un-reviewable).

### I7 — AI batch (Claude) → human review

- The user is Mandarin-fluent enough to review effectively (same approach used for the ingredient aliases in commit `a7c87b6`).
- ~1-2 hours per namespace vs 4-6 hours manual from scratch.
- Brand-voice prompt (above) keeps tone consistent across batches.
- Rejected: pure manual (slow without quality gain), pro translator (days of turnaround per batch; ~$300 cost not justified for solo project), TMS like Lokalise (overhead doesn't pay back at this scale).

### I8 — Fall back to `en`; dev warn

- Production users never see broken UI or debug literals.
- Dev gets immediate signal via `console.warn` on every missing-key resolution.
- Pairs with I3 (typed keys catch missing-key-in-code-not-in-JSON; this catches missing-in-zh-but-in-en).
- Rejected: show key literal (loud signal, bad UX), throw in dev (crashes dev loop).

### I9 — All-or-nothing ship

- User explicitly picked this over phased v1 (recommendation was phased; user chose stricter bar).
- Consistent with the "polished feature-complete" v1 framing from V1_SCOPE_DECISIONS.md.
- Cost: ~5-8 weeks of part-time i18n work blocks v1 launch.
- Trade-off acknowledged: launch delay vs. zero-English-leakage for zh-Hans users.

---

## Risks + watch-outs

- **The 5-8 week timeline can stretch.** Realistic complications: tone-review surfaces multiple namespace rewrites; the inevitable "I missed this Alert.alert deep in a hook" cleanup; the parser restructure for no-space Chinese (deferred but tied) creating regression bugs. Add 20-30% buffer mentally.
- **The recipe-form migration in Commit 1 will be the longest single commit of the project.** ~120 keys, ~3-5 files touched (form, both JSONs), full bilingual review. Plan ~half-day for it.
- **The `common` namespace has cross-cutting risk.** Changing a `common.cancel` translation affects every screen that uses it. Lock the common namespace early; treat changes as breaking.
- **AI translation quality varies by string complexity.** Short labels ("Save") translate trivially; long editorial copy ("Saved from a private recipe — copies others made stay theirs") may need human polish.
- **Bilingual brand name handling is tricky.** "Pantry Pro" stays English. But the underlying product noun "pantry" (lowercase, as in "your pantry is empty") should translate to 食材库. The prompt covers this but watch for slip-ups.

---

## How to resume

> "Continue i18n work from `docs/I18N_DECISIONS.md`. Foundation is in
> `b13bd58..[foundation-commit-sha]`. Next commit is the [namespace name]
> migration — open the screens, replace inline strings with t(), add
> keys to `locales/en/<ns>.json`, AI-translate per the prompt in the
> doc, drop into `locales/zh-Hans/<ns>.json`, review."
