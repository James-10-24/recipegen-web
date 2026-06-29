# v1 scope — decisions

Captured from a grill session on 2026-05-25. All major scope branches
walked; pricing tier shape deferred to its own grill. This document is
the source of truth for "what's in v1" — when in doubt, this overrides
PLAN.md's older roadmap until PLAN.md is reconciled.

---

## Framing

- **v1 = polished feature-complete** (not "ship the moment Apple
  approves"). Holding submission until the bar below is hit.
- **Bounded by a fixed feature list, not by a date.** Anything not in
  the list is v1.x. Additions to the list mid-build are treated as
  scope creep and explicitly rejected unless re-grilled.

---

## What's already in (no new work)

The current `main` already contains the v1 core:

- Auth: email + Sign in with Apple + guest
- Onboarding (2-slide hybrid + Settings household editor)
- Recipes (manual CRUD, AI generate, URL import, paste-from-clipboard
  extract, autosaved draft, curated category, free-form tags,
  step-list instructions, photo upload)
- Pantry (manual CRUD + AI-powered snap → review flow)
- Plan / calendar (week view, recipe→meal assignment,
  servings override, copy-week, batch-count sheet)
- Shop (smart grocery aggregation, waste-flag, shop mode, past-range
  empty state, inputs-changed banner)
- Cook log + 10-second cook-undo
- Discover (public library, search, category chip filter, save-to-mine
  with attribution snapshot)
- Public library moderation (recipe + photo via OpenAI omni-moderation;
  flag/block UGC chrome)
- Reports (rate-limited, moderator triage backend, audit log)
- Account deletion (server-side cascade + anonymization)
- EULA / privacy policy (in-app + web mirror at ideagen.tech)
- Paywall via RevenueCat (Pantry Pro monthly/annual, 7-day trial,
  Family Sharing on annual, Restore Purchases UX)
- Web admin dashboard at `web/admin/` (recipes, reports, users)

---

## New work in v1

Total estimated build: ~5–7 weeks on top of what's already shipped.

### Localization — English + Simplified Chinese (zh-Hans)

**~4–6 weeks.** The single biggest scope addition. Locked decisions:

- **Script:** Simplified only (zh-Hans). Traditional (zh-Hant) is a
  cheap v1.x add later via `opencc` script-conversion + targeted
  re-translation. Mainland addressable market drives the prioritization.
- **Language detection:** auto-detect from device locale on first
  launch; Settings row to override; **UI-only switch** — saved recipes
  and Discover content stay in their original language regardless of
  UI flip. Never auto-translate user-owned content.
- **Discover filter:** chip row alongside the existing category chips,
  options "All / English / 中文", **defaults to user's UI language**.
  Server-side filter via a new `p_language` param on
  `search_public_recipes` RPC (same shape as the `p_category` param
  added in 0028).
- **Recipe language storage:** new `recipes.language text` column.
  Auto-detected on insert via a CJK character-ratio heuristic (>20% CJK
  chars in title+description → `zh-Hans`, else `en`). User can override
  on the form via a chip that surfaces **only when the heuristic
  disagrees with their UI language**.
- **Catalog approach:** translate-as-you-go via the web admin
  dashboard. No upfront bulk translation. Aliases are added to
  existing canonical ingredient rows (`ingredients.aliases text[]`)
  so pantry aggregation keeps working across languages — never a
  parallel `ingredients_zh` catalog.
- **Admin surface:** lives in the existing **web admin dashboard**
  (`web/admin/ingredients.html`) — _override of the original Q7e.3
  pick of "in-app single-screen route"_. Rationale: catalog work
  needs typing speed + a big screen; phone-based admin is sweet for
  moderation on-the-go but tedious for typing aliases. Web also keeps
  all admin tools in one place (Reports, Recipes, Users, Ingredients).
  Uses existing `is_admin()` gate + audit log via `admin_actions`.
- **Gap discovery:** new `pending_aliases` log — every time the parser
  creates a user-scoped ingredient because nothing in the canonical
  catalog matched, log the raw name. Admin screen shows the top-N most
  frequent unmatched terms as a prioritized worklist.
- **Parser dictionaries:** extend `COMMON_UNITS` and `UNIT_CANONICAL`
  in `lib/recipe-import.ts` with Chinese units:
  - Mass: 克 (g), 千克 (kg), 斤 (jin = 500g), 两 (liang = 50g)
  - Volume: 毫升 (ml), 升 (L), 大勺 (tbsp), 小勺 (tsp)
  - Counts: 个 / 颗 / 块 / 片 → pcs; 把 → pcs with handful semantics
- **Search tokenization:** **no change.** `ilike + pg_trgm` is good
  enough for short Chinese titles (`ilike '红烧%'` matches `红烧肉`
  correctly; trigram fuzzy doesn't help CJK but doesn't break either).
  Documented as ~80% of English search quality. Revisit at v1.x if user
  signal warrants pg_jieba migration (which would require leaving
  Supabase managed).
- **AI prompts** (generate-recipe / import-recipe / extract-recipe-from-text):
  prompts adapt to the request's language so a zh-Hans user gets back
  Chinese titles + ingredient lines + step text. Schema keys stay
  English; string values become Chinese. GPT-4o-mini handles this
  natively.
- **App Store metadata in zh-Hans:** app name, subtitle, description,
  keywords, screenshots, optional video in the zh-Hans App Store Connect
  localization fields. ~½ day.
- **Privacy + EULA in zh-Hans:** translate both the in-app screens
  (`app/privacy.tsx`, `app/eula.tsx`) and the web mirrors
  (`web/privacy.html`, `web/eula.html`). Approach:
  **self-translate + Chinese-speaking friend review**. ~1–2 days.
- **Onboarding copy in zh-Hans.** ~½ day.

### Discover polish

**~1–2 days.**

- Sort options chip row: Newest / Most saved / Random. Server adds an
  ORDER BY param to `search_public_recipes`.
- "Load more" cursor pagination beyond the current hard cap of 30
  results. (Empty-search curated surfaces + per-user diet-tag
  personalization are explicitly OUT — premature without real signal.)

### Account deletion polish

**~1 day.**

- **SIWA re-auth path** — App Store-blocking. Current flow calls
  `signInWithPassword`, which silently fails for Sign-in-with-Apple
  users (no password). Detect SIWA users by their auth identity, route
  them through `expo-apple-authentication` re-sign-in instead. The
  type-DELETE confirmation stays the same.
- **Retained-data disclosure** in the delete-confirmation modal: one
  extra line of copy. "Public recipes others saved keep your byline;
  everything else is removed." Zero engineering cost; prevents support
  tickets.

### Crash + error monitoring

**~½ day.**

- **Sentry React Native SDK on Expo SDK 54.** Free tier covers v1
  scale (5K events/month). Update the privacy policy with one
  sentence acknowledging error tracking (Sentry collects stack traces
  + breadcrumbs, not user content, so the "no third-party analytics"
  claim still holds).

---

## What's deferred to v1.x or later

Each entry below was actively decided OUT — not "forgot to consider":

### Notifications (expo-notifications)
- v1.1 hero feature. Expiry-warning UX has too many sub-decisions
  (opt-in timing, lead times, grouping, quiet hours, iOS 64-pending
  cap, snooze, cook-cancel) to ship without a dedicated grill.
- The pantry surface already works without push — open the app to see
  expiries. Push is a re-engagement loop, which fights the "no
  engagement loops" brand voice the app was built around.

### Household / shared plans
- Feature AND data-model prep both deferred. No `households` table,
  no threading `household_id` through user-scoped queries. The "design
  the schema now so 1.1 is easy" trap doubles complexity without
  shipping value.
- v1.2 / 2.0 feature: invite shape, permissions model, pantry merge vs
  separate, RevenueCat Family Sharing scope, cook log reconciliation —
  all big enough to consume an entire launch cycle on their own.

### Cross-device draft sync
- Already marked v1.1 in `lib/recipe-drafts.ts:3`. AsyncStorage covers
  the 95% single-device case. Sync UX (conflict resolution, drafts
  tab, purge policy) is non-trivial.

### Past-plan editing
- Already marked v1.1 in `app/(tabs)/plan.tsx:268` per a prior grill.
  Cook-undo (10-second window) covers the realistic "wrong recipe"
  mistake case. Edit-past interactions with cook log + pantry
  deduction are genuinely thorny and need their own grill.

### iPad-optimized layouts
- `app.json` keeps `supportsTablet: true` so iPad users can install
  and use the iPhone layout (passive distribution at zero cost).
  Real iPad design (split views, multi-column lists, larger photo
  grids) is v1.x.

### Android port
- PLAN.md §6 phasing already says "Android port follows iOS launch."
  Validate the product on iOS user signal first. Adds Play Store +
  Material adaptation + native testing matrix.

### Previously locked PLAN §7 items (re-confirmed OUT)
- Barcode scanning — pantry-snap already covers the camera→ingredient
  use case for non-barcoded items.
- Nutrition info — API-dependent (Nutritionix / USDA), licensable,
  2–4 weeks.
- Grocery store layout / aisle ordering — different product entirely.
- Recipe scaling beyond servings multiplier — non-linear cook math.
- Social graph (follows / comments).
- Web companion — only the marketing site (`web/`) ships; no full app.
- Full offline mode beyond basic React Query caching.

### Multi-photo recipes
- Schema stays `photo_url text` (single). Multi-photo carousel needs
  picker, swipe gallery, cover selection, share-picker — ~1 week of
  surface work. Single photo covers 80% of real recipes. v1.x easy add.

### Avatar
- `profiles.avatar_url` not added. Avatar moderation adds a non-trivial
  UGC surface (malicious avatars). v1.x story.

### Public profile page
- No `/u/[user_id]` route. Bylines stay unlinked. Edges toward "social
  graph" which is deliberately OUT — once you ship "all this user's
  recipes" the next request is "follow this user." Revisit
  intentionally with a "should we do social?" grill.

### Onboarding polish
- 2-slide hybrid was the output of a recent grill. Re-grilling
  without a real signal of where users drop is overfitting.

### Third-party analytics (PostHog)
- PLAN.md §3 mentions PostHog; the privacy policy explicitly says
  "RecipeGen does not embed third-party analytics, ad networks, or
  tracking SDKs." Brand position, not oversight. PLAN.md is stale.

---

## Resolved post v1-scope grill

### Pricing tier shape → see [docs/PRICING_DECISIONS.md](PRICING_DECISIONS.md)

Pricing grill ran on 2026-05-25. Locked decisions:

- **Philosophy:** Freemium-with-a-hard-wall (recipe creation cap is
  the upgrade trigger; AI cap is fraud-prevention, not a conversion
  lever).
- **Free-tier recipe cap:** **100, excluding Discover clones** (was
  50 incl clones).
- **Free-tier AI ops cap:** **25/month unified** (was 5).
- **Annual price:** **$27.99/yr** (42% off vs monthly×12; was $30.99
  at 35% off).
- **Family Sharing:** **annual only** (was on both — monthly was
  borderline lossy).
- **Credit pack:** **deferred to v1.x** (loosened AI cap removes most
  of its purpose; cleaner pricing story).
- **Downgrade behavior:** read-only over-cap (data never destroyed or
  hidden; only NEW creation is blocked).
- **Paywall:** RevenueCat prebuilt with annual pre-selected + "Save
  42%" badge (dashboard config, no code change).

Monthly price ($3.99), trial length (7 days on both), guest cap (10),
and Pro fair-use cap (200¢/day, unmarketed) all stand unchanged.

See [docs/PRICING_DECISIONS.md](PRICING_DECISIONS.md) for the full
reasoning, unit-economics modeling, and operational steps in App
Store Connect + RevenueCat dashboard.

---

## PLAN.md reconciliation needed

Follow-up commit should update PLAN.md to reflect this grill:

- **§3 Tech stack:** remove "Notifications: Expo Notifications"
  (decided OUT). Remove "Analytics: PostHog" (decided OUT, privacy
  policy says so explicitly).
- **§6 Phase 3 Pantry:** remove "expiry list + push" → "expiry list"
  only.
- **§7 Out of scope for v1:** add Notifications, Cross-device draft
  sync, Past-plan editing, Multi-photo, Avatar, Public profile page.
- **§9 Open questions:**
  - Localization → resolved IN as English + Simplified Chinese.
  - Pricing → resolved as "current config stands until a dedicated
    pricing grill."
  - Household → resolved as OUT for v1 (and data-model prep also OUT).

---

## How to resume

Next session opener for picking up the v1 build work:

> "Continue v1 from `docs/V1_SCOPE_DECISIONS.md`. Pricing is now
> resolved (see `docs/PRICING_DECISIONS.md`). Start with the
> localization migration (recipes.language column + parser dictionary
> + Discover RPC param) since it's foundational and everything else
> can build on top. Sentry + Discover polish + SIWA re-auth are
> independent and can ship in any order."
