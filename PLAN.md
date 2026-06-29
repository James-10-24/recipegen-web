# RecipeGen — Plan

Living document. Update as decisions change. See `MEMORY.md` (Claude Code memory) for working assumptions.

GitHub: https://github.com/James-10-24/recipegen

## 1. Vision

A mobile recipe + meal-planning app that **prevents grocery waste**. Three core jobs:

1. **Plan meals** for a date range and number of people.
2. **Generate a smart grocery list** that aggregates ingredients across planned meals, subtracts what's in the pantry, and rounds to realistic package sizes — flagging items likely to be over- or under-bought.
3. **Find and reuse recipes** quickly, including AI generation and URL import.

The "smart pantry" loop (plan → list → buy → cook → deduct) is the differentiator vs. a generic recipe app.

## 2. Confirmed scope

| Area | Decision |
|---|---|
| Platform | React Native (Expo), iOS-first, Android later from same codebase |
| Users | Public sign-up |
| Backend | Supabase (auth, Postgres, Storage, Edge Functions) |
| Recipe input | Manual entry, URL import (JSON-LD + LLM fallback), AI generation |
| Pantry | Smart (shelf-life + package-size aware) + manual tracking |
| Public recipes | Library only — mark public, others browse/save. **No** social graph (follows/comments) in v1. |
| Units | Both metric and imperial; user toggles |
| Dietary filters | Track allergies/diet (vegan, gluten-free, halal, etc.) and filter |
| Auth | Email + Apple Sign In (Apple required for any social login on iOS) |
| Monetization | Decide later — design so AI calls are metered per user from day 1 |
| Pantry deduction | "I cooked this" prompts user to confirm what was actually used (not silent auto-deduct) |

## 3. Tech stack

- **App:** Expo SDK 54+, React Native 0.81, React 19, TypeScript, Expo Router (file-based)
- **Styling:** NativeWind (Tailwind for RN)
- **State:** TanStack Query (server) + Zustand (UI/local)
- **Storage (client):** AsyncStorage for non-sensitive, Expo SecureStore for tokens
- **Backend:** Supabase Postgres + RLS, Supabase Storage (recipe photos), Edge Functions (Deno) for AI / URL parsing
- **AI:** Claude API via Edge Functions (`claude-sonnet-4-6` default; `claude-opus-4-7` for hard parses). Key never ships to client.
- **Builds/CI:** EAS Build, EAS Submit. TestFlight (iOS) → App Store. Play Internal Testing (Android) → Play Store.
- **Crash + error monitoring:** Sentry (free tier; stack traces + breadcrumbs only — see [V1_SCOPE_DECISIONS.md](docs/V1_SCOPE_DECISIONS.md)).
- **Testing:** Vitest for utils/logic, Maestro for E2E.

## 4. Data model (initial)

```
profiles            (id → auth.users, household_size, units, diet_tags[], created_at)
ingredients         (id, name, aliases[], category, default_unit, shelf_life_days,
                     package_size, package_unit, density_g_per_ml, is_canonical)
recipes             (id, user_id, title, description, photo_url, servings,
                     prep_min, cook_min, instructions, source_url,
                     visibility, tags[], diet_tags[], created_at, updated_at)
recipe_ingredients  (recipe_id, ingredient_id, qty, unit, notes, sort_order)
meal_plans          (id, user_id, date, meal_type, recipe_id, servings_override)
pantry_items        (id, user_id, ingredient_id, qty, unit, purchased_at,
                     expires_at, location)
grocery_lists       (id, user_id, range_start, range_end, status, created_at)
grocery_list_items  (list_id, ingredient_id, needed_qty, qty_to_buy, pantry_qty,
                     waste_risk, notes, checked_at)
cook_log            (id, user_id, recipe_id, cooked_at, servings)
ai_usage            (id, user_id, kind, tokens_in, tokens_out, cost_cents, created_at)
```

RLS rules:
- All user-owned tables: `user_id = auth.uid()`.
- `recipes`: read where `visibility = 'public' OR user_id = auth.uid()`; write only own.
- `ingredients`: read all, write admin/service-role only.

## 5. The hard parts

1. **Ingredient canonicalization.** Map "tomato" / "tomatoes" / "roma tomato" to one row so aggregation works. Approach: seed ~1500 canonical ingredients with aliases; `pg_trgm` fuzzy match on entry; Claude as fallback for novel inputs.
2. **Unit conversion.** Cup ↔ gram depends on ingredient. Store density on the canonical row when relevant; refuse to convert when unknown and prompt the user.
3. **Smart grocery rounding.** `needed = sum(recipe_qty × servings_factor) − pantry_qty`. `to_buy = ceil(needed / package_size) × package_size`. If `to_buy − needed` exceeds the user's likely consumption window for that ingredient's shelf life, flag `waste_risk = high` and suggest either an additional planned meal that uses it or a smaller portion (deli counter, bulk bin).
4. **URL import reliability.** ~70% of recipe sites expose `schema.org/Recipe` JSON-LD — parse first. Fallback: fetch HTML, send to Claude with structured output. Cache by URL hash.
5. **App Store UGC compliance.** Public recipes = user-generated content. Apple requires: EULA prohibiting objectionable content, in-app report, in-app block, and **account deletion**. Design these in from day 1.

## 6. Phased roadmap

| Phase | Goal | Est. |
|---|---|---|
| **0. Setup** | Skeleton boots; auth wired; schema deployed; CI ready | 2-3 days |
| **1. Recipes** | Manual recipe CRUD + photo upload + ingredient typeahead | 1-2 wk |
| **2. Calendar** | Week view; assign recipe → day+meal; servings override | 1 wk |
| **3. Pantry** | Pantry CRUD; expiry list (in-app, no push); "I cooked this" deduction | 1 wk |
| **4. Smart grocery list ⭐** | Aggregate / subtract / round / waste-flag / shop-mode | 2 wk |
| **5. AI + URL import** | Edge Functions: URL parse, AI generate, ingredient normalize. Per-user rate limits. | 1-2 wk |
| **6. Public library** | Public toggle, browse/search, save-to-mine, report/block, account deletion | 1-2 wk |
| **7. Polish + launch** | Onboarding, empty states, store assets, privacy policy, EULA, App Store submission | 1-2 wk |

**Realistic v1: ~2-3 months part-time.** Android port follows iOS launch.

## 7. Out of scope for v1

Barcode scanning · Nutrition info · Grocery store layout / aisle ordering · Recipe scaling beyond servings multiplier · Social graph (follows/comments) · Shared household plans · Web companion (the marketing site at `web/` ships; no full app) · Full offline mode beyond basic caching · Push notifications · Cross-device draft sync · Past-plan editing · Multi-photo recipes · Profile avatar · Public profile pages · iPad-optimized layouts · Android port (follows iOS).

Each entry above was actively decided OUT in the v1-scope grill — see [docs/V1_SCOPE_DECISIONS.md](docs/V1_SCOPE_DECISIONS.md) for the reasoning per item.

## 8. External setup checklist (user actions)

These can't be automated and need to be done at least once:

- [ ] Create Supabase project at https://supabase.com/dashboard
- [ ] Copy project URL + anon key into `.env.local` (template: `.env.example`)
- [ ] Apply migrations from `supabase/migrations/` (via Supabase CLI: `supabase db push`)
- [ ] Set Anthropic API key as Supabase Edge Function secret: `supabase secrets set ANTHROPIC_API_KEY=...`
- [ ] Apple Developer account ($99/yr) — required for Apple Sign In and TestFlight
- [ ] Configure Apple Sign In:
  - Enable "Sign in with Apple" capability in Xcode / app.json
  - Create Service ID + Sign in with Apple key in Apple Developer portal
  - Add credentials to Supabase auth provider
- [ ] EAS account: `npx eas-cli login` → `eas init`
- [ ] Sentry account (free tier) for crash + error monitoring; copy the React Native DSN into the Expo config

## 9. Open questions to revisit

Resolved in the v1-scope grill (see [docs/V1_SCOPE_DECISIONS.md](docs/V1_SCOPE_DECISIONS.md)):

- ~~Do we localize recipe content (multi-language) at launch, or English-only first?~~ → **IN: English + Simplified Chinese (zh-Hans)**. UI strings, AI prompts, parser dictionary, recipe-language column with CJK heuristic detect, Discover chip filter, in-app admin alias surface. Traditional Chinese is a cheap v1.x add via `opencc`.
- ~~Pricing model: free + AI cap, or freemium with subscription? Decide before App Store submission.~~ → **Current config stands** ($3.99/mo, $30.99/yr, 7-day trial, Family Sharing on annual, free tier 50 recipes + 5 AI ops/mo) **until a dedicated pricing grill** tunes free-tier limits, trial length, monthly:annual ratio, and Family Sharing scope. Not v1-blocking.
- ~~Family/household sharing — defer to post-launch but design data model to allow it.~~ → **OUT (feature + data-model prep)**. Threading `household_id` without shipping the feature is the worst of both worlds; do the migration as part of the actual feature in v1.2/2.0.
