# App Store listing — RecipeGen

Reference for everything that goes into App Store Connect at submission
time. Decisions locked via a grill session. Update this file when copy
or assets change.

---

## Text fields

### App Name (max 30 chars)

```
RecipeGen
```

### Subtitle (max 30 chars)

```
Meal planner with smart pantry
```

30 chars, exactly at cap. Hits both `meal planner` (high-volume head
term) and `smart pantry` (niche, growing). Auto-indexes for free.

### Promotional Text (max 170 chars, can change without resubmission)

```
New: Snap your groceries on the counter — AI reads each item into your pantry, suggests a shelf life, and updates your shopping list.
```

131 chars. Use this slot to announce features (e.g. credit pack, new
locale) since it can be updated without going through App Review again.

### Description (max 4000 chars)

```
Plan meals around your real pantry. RecipeGen knows what you have, suggests what to cook, and subtracts what's left before you shop.

The pantry is the engine. Snap your groceries on the counter — the app reads each item, suggests a shelf life, and drops the lot into your fridge, freezer, or shelves. Every recipe shows how much you already have. Every shopping list flags what you'd actually waste.

• Up to 50 recipes free. No ads, no tracking, ever.
• Snap your groceries — AI extracts each item with a suggested shelf life.
• Pantry-aware shopping lists that subtract what you already have.
• Waste warnings before you over-buy.
• Plan breakfast through dinner across seven days.
• Discover community recipes; save the ones you like.
• One-line craving → full recipe in a tap.

PRICING
Free for most households (up to 50 recipes + 5 AI ops/month). Pantry Pro at $3.99/month or $30.99/year unlocks unlimited recipes and AI. Optional $1.99 credit packs for occasional bursts. Apple Family Sharing is enabled — one subscription unlocks Pro for every member of your Family Sharing group, on their own private RecipeGen account.

ABOUT US
RecipeGen is built by IdeaGen Technologies, an independent studio registered in Malaysia (JR0189683-T). We collect what the app needs to work, never sell data, never use private recipes for model training, and never embed third-party trackers or ads. Full privacy policy at ideagen.tech/privacy.
```

~1500 chars. Well under the 4000 cap.

### Keywords (max 100 chars, comma-separated, no spaces)

```
grocery,shopping,cook,waste,ai,snap,food,kitchen,list,dinner,fridge,ingredient,prep,track,diet
```

94 chars, 15 keywords. Excludes anything auto-indexed via name/subtitle
(`recipe`, `meal`, `planner`, `smart`, `pantry`).

### URLs

| Field | URL |
|---|---|
| Support URL | `https://ideagen.tech/support` |
| Marketing URL | `https://ideagen.tech` |
| Privacy Policy URL | `https://ideagen.tech/privacy` |

### Categories

| Slot | Category | Rationale |
|---|---|---|
| Primary | **Food & Drink** | Most natural fit; the App Store's editorial food collections live here |
| Secondary | **Lifestyle** | Catches the household-management angle (the audience's mental model). More aligned than Productivity for housewives. |

### Copyright

```
© 2026 IdeaGen Technologies
```

### Age Rating

**Expected: 4+** with a disclosure caveat for **user-generated content**.

In the App Store Connect age rating questionnaire, answer:

- Cartoon or Fantasy Violence: None
- Realistic Violence: None
- Sexual Content or Nudity: None
- Profanity or Crude Humor: None
- Alcohol, Tobacco, or Drug Use or References: None
- Mature/Suggestive Themes: None
- Horror/Fear Themes: None
- Medical/Treatment Information: None
- Gambling: None
- **Unrestricted Web Access: NO**
- **User Generated Content: YES** — with the disclosure: "Public recipes
  + reports/blocks + display name moderation queue. We screen
  display names automatically and review reports manually."

Apple may bump this to **12+** because of the UGC component. That's
expected and acceptable.

---

## Screenshot plan

### Strategy

Captioned editorial with a Plan → Pantry-via-snap → Shop narrative arc
across the first 3 screenshots. The arc maps to your existing index.html
feature spread headings, so the App Store listing reinforces the website
voice.

### Required device sizes (as of 2026)

| Size | Resolution | Required? |
|---|---|---|
| **6.9"** (iPhone 16 Pro Max) | 1320×2868 | ☑ Required |
| **6.5"** (older Pro Max) | 1242×2688 | Optional, but helpful |
| **iPad Pro 13"** | 2064×2752 | Required since `supportsTablet: true` in app.json |

### First 3 screenshots (the visible-without-scroll set)

#### Screenshot 1 — Plan

- **Screen captured:** `app/(tabs)/plan.tsx` showing a populated week with mealsacross several days, including a "cooked" past-day annotation and a current-day cook button.
- **Caption (top of frame, Fraunces italic):** _Plan the week._
- **Sub-caption (sans, smaller):** Lay out breakfast through dinner across seven days. Mix favourites with new finds.

#### Screenshot 2 — Snap (the magic moment)

- **Screen captured:** `app/pantry/snap/review.tsx` showing detected items from a counter photo with suggested expiries and the "AI-read from your photo" disclosure visible.
- **Caption:** _From bag to pantry — by photo._
- **Sub-caption:** Snap your haul. The app reads each item and drops it into your pantry.

#### Screenshot 3 — Shop

- **Screen captured:** `app/(tabs)/shop.tsx` showing the generated grocery list with coverage subtraction annotations ("You have 200g, buy 300g") and at least one waste warning ("Buys 4, uses 2").
- **Caption:** _Smart shopping, no waste._
- **Sub-caption:** The grocery list subtracts what you already have.

### Screenshots 4-10 (visible after scroll)

| # | Screen | Caption |
|---|---|---|
| 4 | Pantry tab with shelf-life-aware sub-pantries | _A pantry that knows what it has._ |
| 5 | Recipe detail with coverage annotations | _Every recipe shows what you already have._ |
| 6 | Recipe-import banner with URL paste mid-flow | _Paste any recipe URL — we extract the whole thing._ |
| 7 | One-line craving → AI recipe generation | _One craving in, one recipe out._ |
| 8 | Discover tab with public recipe tiles | _A small library of cooks._ |
| 9 | Cook flow / cook history past-week view | _Track what you actually cooked._ |
| 10 | Pricing / Pantry Pro upgrade card | _Free for most. Pro for the rest._ |

### Caption typography

- **Headline:** Fraunces 700 italic, large (~80pt on 1320×2868), warm-black on the off-white background.
- **Sub-caption:** System sans 500, medium (~28pt), gray-600.
- **Background:** `#fafaf7` (the website's `--bg`), matching index.html.

### Production tooling

Recommended free/low-cost tools to cut production time:

- **[shotbot.app](https://shotbot.app)** — drag-and-drop iPhone/iPad framing + caption
- **[previewed.app](https://previewed.app)** — same idea, broader templates
- **Figma** — if you want full layout control (most time-consuming)
- **macOS screenshots** via simulator at the required pixel sizes (Cmd+S in iOS Simulator)

Rough budget: ~6-8 hours for the full set of 10 screenshots × 2 device
sizes = 20 final renders.

---

## App Preview Video

### Strategy

15-second silent screen recording of the snap-to-pantry magic flow.
Defer full editorial reel to v1.1 once you have actual user feedback.

### Production notes

- Open the app on a real iPhone (simulator screen-recording is fine
  too, but real device looks more authentic)
- Plug into Mac, use QuickTime → File → New Movie Recording → camera
  source = the iPhone
- Record the flow:
  - 0:00 — App opens on Pantry tab
  - 0:02 — Tap "+ Snap" button
  - 0:04 — Camera opens, capture a counter photo (use a pre-staged
    one for consistency)
  - 0:06 — Review screen appears with detected items
  - 0:11 — Tap "Add 7 items"
  - 0:13 — Lands back on Pantry tab with new items visible, expiry
    badges showing
  - 0:15 — End
- Trim to exactly 15 seconds in QuickTime / iMovie
- No audio narration (App Store mutes by default)
- Optional: 1-second text overlay at 0:00 ("From bag to pantry")
  and 0:13 ("Done") using Fraunces in iMovie

Apple format requirements:
- H.264 or HEVC codec
- 30fps preferred (24-60 acceptable)
- Up to 30 seconds (15 is fine and recommended)
- Same aspect ratio as the target device (e.g. 9:19.5 for iPhone)

---

## App Review Information (App Store Connect)

### Demo account (REQUIRED for accounts with sign-up)

Create a permanent reviewer account in Supabase:

```
Email: appstore-reviewer@ideagen.tech
Password: <strong-random>
```

Pre-populate it with:
- 3-5 recipes (some private, at least 1 public)
- 8-10 pantry items across fridge/freezer/shelf
- 2 meal plan entries for the current week
- A sandbox Pantry Pro subscription active (via RevenueCat sandbox)

### Notes for the reviewer

In the "Notes" field of App Review Information:

```
RecipeGen is a meal-planning app with AI-assisted pantry tracking.

Test account:
  Email:    appstore-reviewer@ideagen.tech
  Password: <see App Store Connect>

Account already has: sample recipes, pantry items, an active sandbox
Pantry Pro subscription, and a small meal plan to demonstrate the
core flows. Sign in with Apple is also available.

AI features (recipe generation, URL import, snap-to-pantry, recipe
moderation) call OpenAI's API. The account has unlimited AI quota
under the sandbox Pro entitlement.

User-Generated Content compliance:
- Display names are moderated automatically before they're set.
- Public recipes can be reported via the ⋯ menu on any public recipe
  → "Report this recipe" or "Report the author."
- Reports go to a moderation queue we review within 24 hours.
- Users can block authors; blocked authors' recipes are filtered from
  the Discover feed.
- Account deletion is permanent and immediate, available in
  Settings → Danger zone.

Contact for any issues: james@ideagen.tech
```

---

## Pre-submission checklist

```
[ ] App icon (1024×1024, no transparency, no alpha) — verify ./assets/images/icon.png is correct size & format
[ ] All 10 screenshots produced at 1320×2868 (iPhone 6.9")
[ ] All 10 screenshots produced at 2064×2752 (iPad Pro 13")
[ ] App Preview Video produced (15s, snap flow, silent)
[ ] App Name, Subtitle, Description, Keywords pasted into App Store Connect
[ ] URLs (Support / Marketing / Privacy Policy) pasted
[ ] Categories (Food & Drink / Lifestyle) selected
[ ] Age rating questionnaire completed (expected 4+ with UGC disclosure)
[ ] Demo account created in Supabase + populated + pasted into App Review Information
[ ] App Review Notes pasted
[ ] Apple Developer Account approved (gates everything)
[ ] APP_STORE_LAUNCH_PLAYBOOK.md Steps 1-6 completed (gates RevenueCat + SIWA)
[ ] TestFlight smoke test passed (per the playbook)
[ ] Submit for review
```

---

## Reference: what each asset costs in conversion

For future iteration prioritization. Numbers are industry rough averages.

| Asset | Conversion lift over no-asset | Time to produce |
|---|---|---|
| Subtitle (good vs default name-only) | +25-40% | ~1 hour iteration |
| First 3 screenshots (vs raw simulator) | +35-60% | ~6-8 hours |
| App Preview Video | +10-15% | ~3 hours (minimal) to ~16 hours (polished) |
| Description (above-fold hook) | +15-25% | ~2 hours iteration |
| Keywords field (vs default) | +10-30% rank lift | ~1 hour research |

Total: typical 80-150% conversion lift over a default listing. The
single most-leverage asset is the **subtitle + first screenshot
combo** — that's what most decision-makers see in search results
before they tap your app at all.
