# Pricing decisions

Captured from the pricing grill on 2026-05-25, deferred from the
v1-scope grill ([V1_SCOPE_DECISIONS.md](V1_SCOPE_DECISIONS.md)). All
levers walked; unit economics modeled. This document is the source of
truth for pricing config — when it diverges from
[APP_STORE_LAUNCH_PLAYBOOK.md](APP_STORE_LAUNCH_PLAYBOOK.md), this wins
until the playbook is reconciled.

---

## Framing

**Pricing philosophy: A — Freemium-with-a-hard-wall.**

Free tier is useful indefinitely UNTIL the user hits the **recipe
creation cap**, which is the explicit upgrade trigger. AI ops have a
quota too but it's set generously enough that it's a fraud-prevention
mechanism, not an upgrade lever. The story is: "Use it forever for
free; if your library outgrows the free tier, support the app."

Rejected alternatives:

- **B (feature gates):** would gate AI / publishing behind Pro. Bad
  positioning — reads as "pay for AI" when the actual value is the
  smart-pantry loop. AI features are accelerators, not core.
- **C (hybrid — status quo):** muddy. Two competing gates (recipes +
  AI) each at modest thresholds. Users feel double-gated; neither is a
  clean upgrade story.
- **D (trial-to-paid):** loses for "build up over time" apps. A recipe
  library you can't access on day 8 is worse than deleting.

---

## Locked levers

| Lever | Old | New |
|---|---|---|
| Free-tier recipe cap | 50 (incl Discover clones) | **100 (creations only; clones uncounted)** |
| Free-tier AI ops cap | 5/month unified | **25/month unified** |
| Guest recipe cap | 10 | 10 (unchanged) |
| Monthly price | $3.99 | $3.99 (unchanged) |
| Annual price | $30.99 (35% off) | **$27.99 (42% off)** |
| Trial length | 7 days on both | 7 days on both (unchanged) |
| Family Sharing | On both | **Annual only** |
| Credit pack ($1.99 / 10) | Half-built | **Deferred to v1.x** |
| Pro fair-use cap | 200¢/day | 200¢/day (unchanged; unmarketed) |
| Downgrade behavior (Pro lapses) | Implicit | **Explicit: read-only over-cap** |
| Paywall default + framing | Unclear | **Annual pre-selected + "Save 42%" badge** (RevenueCat dashboard config) |

---

## Per-decision reasoning

### Recipe cap → 100, excluding Discover clones

Most successful recipe apps (Paprika, AnyList, Whisk, Mealime) have
**no recipe cap** on free. A cap is already aggressive in this
category. 100 reads as "fair" in App Store reviews while still
catching heavy creators within ~1 year of active use.

**Excluding clones** removes the worst negative-review vector: "I
saved 30 recipes from Discover and now the app won't let me add my
grandmother's pancakes." Clones are CONSUMPTION; the cap should
govern CREATION. Network effect bonus: encouraging clone usage feeds
the public library, which is exactly the users you want engaged.

Implementation: [lib/gates.ts](../lib/gates.ts) +
[app/(tabs)/index.tsx](../app/(tabs)/index.tsx) — bump
`FREE_RECIPE_CAP` to 100; filter `saved_from_id != null` out of the
count.

### AI ops cap → 25/month unified

Under philosophy A, AI isn't the upgrade lever — so the cap exists
only to prevent abuse. 5/month was way too tight; users were hitting
the AI wall before the recipe wall, creating a "pay for AI"
positioning we don't want.

**Realistic free-user usage:**
- Light: 3-5 ops/mo (most users) — well under cap
- Power: 10-20 ops/mo — most never hit
- Heavy: 30+ ops/mo — hits the cap; should convert to Pro

**Cost per free user at the new cap:**
- Per-op average: ~$0.005 (text-AI), ~$0.02 (vision)
- Heavy free user at 25 ops/mo all-vision: max $0.50/mo cost
- Per-1K free users / mo: roughly $50-200 in OpenAI bills
- One Pro sub at $3.99/mo covers ~6 max-heavy free users

**Unified vs split:** chose unified for the simpler UX (one counter
in Settings, one error copy, easier to advertise as "25 AI ops/mo").
Vision cost is bounded by the unified cap so split adds complexity
without meaningful financial protection.

Implementation:
[supabase/migrations/0031_loosen_free_ai_cap.sql](../supabase/migrations/0031_loosen_free_ai_cap.sql)
— `v_free_monthly_cap` from 5 → 25 in `claim_ai_op`.

### Monthly stays $3.99; annual drops to $27.99

**Per-sub net profit (Apple Small Business 15% cut):**

| Tier | Gross | Apple | AI cost | Other variable | Net profit |
|---|---|---|---|---|---|
| Monthly $3.99 | $3.99 | −$0.60 | −$0.25/mo (typical Pro) | −$0.05 | **$3.09/mo** |
| Annual $27.99 | $27.99 | −$4.20 | −$3.00/yr | −$0.60 | **$20.19/yr** = $1.68/mo equiv |

**LTV with 30%/yr monthly churn:**
- Monthly: ~3-4 month avg lifetime × $3.09 = **$9-12 LTV**
- Annual: $20.19 first year + ~50% renewal = **$30-40 LTV**

Annual wins decisively on LTV even at the deeper discount. Pushing
annual is the right strategic move; $27.99 (42% off) is the sweet
spot — clearly cheaper without screaming "fire sale."

$3.99/mo monthly stays because it's competitive, App Store Connect is
already configured for it, and it's the low-friction "yes-I'll-pay"
price at the cap-hit upgrade moment.

**Fixed cost floor:** ~$35/mo (Apple Dev + domain + Supabase Pro).
Break-even: ~12 monthly subs OR ~2 annual. Trivial.

### Family Sharing → annual only

Unit economics with up to 6 family members per purchase:
- Annual $27.99 ÷ 6 = $4.67/year-per-person — fine
- Monthly $3.99 ÷ 6 = $0.67/month-per-person — borderline lossy

Standard industry pattern: Family Sharing is the **annual conversion
lever** ("want to share with family? Annual it is"). Keeping it on
monthly was generous but strategically muddy.

Operational: uncheck Family Sharing on `pantry_pro_monthly` in App
Store Connect. Zero existing subscribers to grandfather.

### Credit pack → DEFER to v1.x

The half-built credit pack (server-side credits work; no client
purchase flow; ~1 week to finish) was designed for users who hit the
AI cap and want to top up instead of subscribing. Under the loosened
25-op cap, far fewer users hit the wall — and the ones who do are the
exact users we want converting to Pro, not buying $1.99 top-ups.

Simplifying to "free OR Pantry Pro" makes the App Store messaging
cleaner. Credit pack revenue at scale is typically <5% of subscription
revenue for productivity apps — not worth slipping launch.

Server stays as-is. `ai_op_source = 'credits'` keeps working for
admin-granted credits. Settings display still shows balance when
> 0 (which won't happen for normal users pre-v1.x). The PURCHASE flow
is what's deferred — UI + RevenueCat consumable plumbing.

### Trial → 7 days on both (unchanged)

Apple's sweet spot. Longer trials generate "I forgot to cancel"
backlash. Trial-on-both is more user-friendly than annual-only
(monthly safety valve preserved); Apple's one-trial-per-subscription-
group rule prevents abuse.

### Guest recipe cap → 10 (unchanged)

10:100 (guest:free) is a clean 10× ratio. Reads as "try, then commit
to an account, then upgrade."

### Pro fair-use cap → 200¢/day (unchanged; unmarketed)

Quiet anti-abuse. Legitimate Pro usage maxes ~$0.10/day; cap at
$2/day = 20-40× headroom for real users, hard ceiling for compromised
or malicious accounts. "Pro = unlimited" marketing is honest — Apple
guidelines allow fair-use caps as long as they're not user-hostile,
and 200¢ exceeds any reasonable home-cook workload.

### Downgrade behavior → read-only over-cap

When a Pro user cancels or fails renewal and their library exceeds
100 own-recipes:

- All recipes stay accessible
- Creating new recipes is blocked until the user deletes down to 100
  OR re-upgrades
- Existing data is never destroyed or hidden

This is the strongest trust signal: "Your data is yours; we won't
hide it from you." Alternatives (soft-hide, force-delete) generate
1-star reviews. Grandfathering creates a perverse incentive (sub once
to permanently lift cap, then cancel).

Implementation: already correct — the gate ([lib/gates.ts:153](../lib/gates.ts))
blocks CREATION when at cap; nothing in the code path destroys or
hides over-cap rows.

### Paywall default + framing → annual pre-selected + "Save 42%" badge

The paywall ([app/paywall.tsx](../app/paywall.tsx)) uses RevenueCat's
**prebuilt Paywall component**. Layout, defaults, badge, and copy are
configured in the RevenueCat dashboard's Paywall Editor — NOT in
code. This is actually nice because it can be A/B tested without
shipping a new binary.

Dashboard configuration:
- Pre-select annual on paywall load
- "Save 42%" badge on annual
- Both products visible (don't hide monthly — App Store dark-pattern risk)
- Headline + body copy as configured in the dashboard
- Trial copy auto-renders from RevenueCat config

~30 minutes of dashboard work, no code change.

---

## Implementation footprint

**Code + migration (this commit):**
- [lib/queries/recipes.ts](../lib/queries/recipes.ts) — `RecipeListRow` now exposes `saved_from_id`; `useRecipesList` selects it.
- [lib/gates.ts](../lib/gates.ts) — `FREE_RECIPE_CAP: 50 → 100`; `requireRecipeSlot` filters clones; `count` returned excludes clones; alert copy updated.
- [app/(tabs)/index.tsx](../app/(tabs)/index.tsx) — `FREE_RECIPE_CAP: 50 → 100`; computes `ownRecipeCount`; gates `atFreeCap` on own-count; counter copy reads "X / 100 created" instead of "X / 100 recipes."
- [supabase/migrations/0031_loosen_free_ai_cap.sql](../supabase/migrations/0031_loosen_free_ai_cap.sql) — recreates `claim_ai_op` with `v_free_monthly_cap = 25`.

**App Store Connect (~15 minutes, operational, manual):**
- Change `pantry_pro_annual` price tier: $30.99 → $27.99 USD
- Uncheck Family Sharing on `pantry_pro_monthly`
- Leave `credit_pack_10` consumable in draft state (do NOT submit for review)

**RevenueCat dashboard (~30 minutes, operational, manual):**
- Configure prebuilt paywall:
  - Pre-select annual
  - "Save 42%" badge on annual
  - Headline + body copy in zh-Hans + en (per V1_SCOPE_DECISIONS.md localization decision)
- (Optional) configure A/B tests for future iteration

**Docs updated alongside this commit:**
- [docs/APP_STORE_LAUNCH_PLAYBOOK.md](APP_STORE_LAUNCH_PLAYBOOK.md) — annual price + Family Sharing scope per above.
- [docs/V1_SCOPE_DECISIONS.md](V1_SCOPE_DECISIONS.md) — "pricing tier shape" moved from "open for grill" to "resolved; see PRICING_DECISIONS.md."

---

## Re-grill triggers

Run this grill again if any of the following changes:

- **Real conversion data lands.** After ~3 months of production usage,
  the free → Pro conversion rate per upgrade trigger (recipe cap vs
  AI cap) gives ground-truth on whether the philosophy bet was right.
- **AI provider costs change materially.** A 2× OpenAI price hike (or
  drop) shifts the unit economics enough that the AI cap should be
  re-tuned.
- **Apple Small Business eligibility lapses.** If ARR crosses $1M
  (good problem!), the 30% cut kicks in and per-sub margins drop ~17%
  — worth re-examining whether to bump prices.
- **A meaningful new competitor enters the space with sharp pricing.**
  Match or undercut as warranted.
- **You decide to ship the credit pack** — re-grill credit pack scope,
  pricing, and how it interacts with the AI cap.

---

## How to resume (if pricing comes up again)

Next session opener for any pricing change:

> "Continue pricing work from `docs/PRICING_DECISIONS.md`. Last grill
> locked philosophy A + recipe cap 100 + AI cap 25/mo + annual $27.99
> (42% off) + Family Sharing annual-only + credit-pack deferred.
> [Specific re-grill trigger from the doc] has changed; re-evaluate
> [the affected lever]."
