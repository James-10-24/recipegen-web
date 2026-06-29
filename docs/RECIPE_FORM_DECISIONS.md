# Recipe form decisions — shipped

Captured from a grill session. Q1 + Q2 + Q3 + Q4 + Q5 all shipped.

---

## Shipped

### Q1 — AsyncStorage autosave + restore

**Commit:** `cbdb536`

Local draft persistence to AsyncStorage with 500ms debounce, restore
on form mount, "Restored unsaved changes from <time>" banner, and a
confirm-destructive "Discard draft" button. Survives backgrounding,
process kills, accidental back-taps. Device-local; cross-device sync
deferred to v1.1.

Touches:
- `lib/recipe-drafts.ts` (new helper)
- `components/recipe-form.tsx` (draftKey prop + integration)
- `app/recipe/new.tsx`, `app/recipe/edit/[id].tsx` (pass draftKey)

### Q2 — Curated category + free-form tags

Required-ish category chip selector (Breakfast / Lunch / Dinner / Snack /
Dessert / Drink) plus free-form lowercase tag chips. Category is optional
on the form — tapping the active chip clears it — but drives library and
Discover filtering when set. Tags are deduped, hyphenated, capped at 12 ×
24 chars.

Touches:
- `supabase/migrations/0028_recipe_category.sql` — new column + partial
  index; extends `search_public_recipes` with a `p_category` filter and
  returns the category column; updates `save_recipe` to copy category
  onto clones (tags were already copied).
- `lib/recipe-categories.ts` (new) — single source of truth for the
  curated list, mirrored in the edge functions.
- `lib/queries/recipes.ts` — `RecipeInput`, `RecipeListRow`,
  `RecipeDetail` carry `category` + `tags`; create/update mutations write
  them.
- `lib/queries/discover.ts` — `DiscoverRow.category`, `useDiscoverRecipes`
  accepts a `category` filter.
- `lib/recipe-import.ts` — `ImportResult` carries `category` + `tags`
  through both URL and AI-generate paths.
- `lib/recipe-drafts.ts` — draft snapshot includes category + tags.
- `components/recipe-form.tsx` — category chip selector + tag chip
  input above the Visibility section. Tag input commits on Add / return /
  comma / whitespace, and folds an uncommitted draft chip into the array
  on submit.
- `app/recipe/[id].tsx` — terracotta category badge + tag chips
  rendered under the meta line.
- `app/(tabs)/index.tsx` — horizontal chip filter row, hidden when the
  user's library has no categorized rows yet.
- `app/(tabs)/discover.tsx` — horizontal chip filter row; category
  filter is server-side via the RPC `p_category` param.
- `supabase/functions/generate-recipe/index.ts` — schema now requires
  `category` (enum + null) and `tags` (0-6 lowercase hyphenated).
- `supabase/functions/import-recipe/index.ts` — JSON-LD path maps
  `recipeCategory` / `keywords` onto our buckets; LLM fallback uses the
  same schema shape as generate-recipe.

### Q3 — Step-list instructions

`recipes.instructions` converted from `TEXT` to `TEXT[]`. The form
renders one card per step with add/remove; the recipe detail renders a
numbered list; share output emits a numbered prose payload. AI
generation and JSON-LD URL imports now preserve step structure end to
end instead of being flattened on save. Always-array, possibly empty —
the migration wraps any existing non-blank prose into a single-element
array so no data is lost; the user can split the blob into proper steps
the next time they tap Edit.

Touches:
- `supabase/migrations/0029_instructions_array.sql` — side-column swap
  (`instructions_arr text[] NOT NULL DEFAULT '{}'`), wrap-existing-blob
  backfill, drop+rename. Recreates `save_recipe` so the cached plan is
  parsed against the new column type immediately on deploy. The
  `_reset_moderation_on_edit` trigger doesn't need a change — `IS
  DISTINCT FROM` works element-wise on arrays.
- `lib/queries/recipes.ts` — `RecipeDetail.instructions: string[]`;
  `RecipeInput.instructions?: string[]`; create/update mutations write
  arrays (defaulting to `[]`).
- `lib/recipe-drafts.ts` — `RecipeDraftSnapshot.instructions: string[]`;
  `loadRecipeDraft` rejects pre-Q3 snapshots whose `instructions` field
  is still a single string, so the user loses the old draft cleanly
  rather than restoring a half-shaped form.
- `lib/recipe-import.ts` — `RecipeCandidate.instructions` and
  `ImportResult.instructions` are `string[]`; defensive `Array.isArray`
  coerce on the boundary.
- `components/recipe-form.tsx` — replaces the single multiline
  `TextInput` with one card per step (label, multiline body, remove
  button) and a dashed `+ Add step` footer; submit-time filters out
  blank rows.
- `components/recipe-import-banner.tsx` — `isResultUsable` checks for
  at least one non-blank step instead of `instructions.trim()`.
- `app/recipe/[id].tsx` — numbered list of steps with terracotta
  tabular-num prefixes; share builder emits `1. … 2. …` prose.
- `supabase/functions/generate-recipe/index.ts` — schema now requires
  an `instructions` array of strings; system prompt asks for 3-8
  self-contained sentences; response normalizer caps per-step length
  and step count.
- `supabase/functions/import-recipe/index.ts` — `parseInstructions`
  returns `string[]`, flattens HowToSection headers + nested
  HowToStep entries, splits prose blobs on newlines / "Step N." markers.
  LLM schema + prompt updated; quality gate moved from "combined prose
  length" to "at least one step AND ≥ 50 chars of combined prose" so
  the bar matches the pre-Q3 single-blob threshold.
- `supabase/functions/moderate-recipe/index.ts` — joins the step array
  into a blob before the moderation pass; the OpenAI moderator sees
  the same words as before.

### Q4 — Paste-from-clipboard with AI extraction

A third "Pasted text" chip mode on the import banner, alongside the
existing URL / Description chips. Tapping the chip reads the clipboard
via `expo-clipboard` (the user's chip-tap is iOS 16+'s paste-permission
consent moment) and pre-fills a multiline textarea. The text is sent to
a new edge function which returns the same `RecipeCandidate` shape as
URL import / AI generate, so the existing post-import ingredient-matching
pipeline + form pre-fill work unchanged. Counts as one AI op.

Touches:
- `supabase/migrations/0030_paste_import_ai_kind.sql` — adds
  `'paste_import'` to the `ai_kind` enum so analytics + per-tier quota
  buckets stay distinct from URL parses. Mirrors the 0014 precedent that
  added `'pantry_extract'`.
- `supabase/functions/extract-recipe-from-text/index.ts` (new) — auth
  + guest-block + min/max length validation + moderation gate +
  `claimOp('paste_import')` + OpenAI call with the recipe schema +
  quality gate (refunds the op on too-thin output) + sanitized
  `RecipeCandidate` response with `source_kind: 'paste'`.
- `supabase/functions/_shared/usage.ts` — `AiKind` union extended with
  `'paste_import'`.
- `lib/recipe-import.ts` — `RecipeSourceKind` adds `'paste'`; new
  `extractRecipeFromText(text)` helper wires the function through the
  shared `candidateToResult` ingredient-matching pipeline.
- `components/recipe-import-banner.tsx` — third `'text'` mode added to
  the chip row; auto-prefills from clipboard on chip-tap; textarea +
  counter; same `isResultUsable` gate as the other modes; mode-specific
  error copy.
- `components/imported-source-chip.tsx` — renders "Extracted from pasted
  text" for `source_kind: 'paste'`.
- `app/recipe/new.tsx` — AI disclosure ("Extracted by AI · Review
  before saving") also triggers on `source_kind: 'paste'`.

### Q5 — Polish bundle (6 small wins)

**Commit:** `92455c9`

1. **Default servings = `profile.household_size`** — reuses onboarding
   signal instead of hardcoding `2`.
2. **Visibility moved above Servings/Prep/Cook** — was buried below
   Instructions; users now see the publish toggle BEFORE investing
   typing time.
3. **Validation focus + scroll** — missing-title / invalid-servings
   alerts now scroll-to + focus the offending field after OK.
4. **Description placeholder copy** — "Optional · what makes this
   recipe yours?"
5. **Required field indicators** — terracotta "· Required" /
   "· At least one" small-caps tags on Title + Ingredients labels.
6. **iOS Done toolbar above number-pad keyboards** — InputAccessoryView
   on servings, prep, cook, and ingredient qty inputs. Android already
   has Done on numeric keyboards.

---

All five grill questions are now in the codebase. The remaining
operational steps before any of this works end-to-end in an
environment:

- `supabase db push` — applies migrations 0028 / 0029 / 0030.
- `supabase functions deploy generate-recipe import-recipe moderate-recipe extract-recipe-from-text` — picks up the array-instructions changes and the new paste-extraction function.
- `npx expo prebuild` (if you maintain native folders) — picks up the new `expo-clipboard` native module.
