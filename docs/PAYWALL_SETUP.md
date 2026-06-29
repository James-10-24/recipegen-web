# Paywall + Subscriptions — Setup Runbook

Everything the iOS code expects is implemented. This doc captures the
manual steps you (the human) own: App Store Connect config, RevenueCat
dashboard, Supabase secrets, and sandbox test plan.

Order matters — RevenueCat needs the App Store products to exist before
it can pull them in.

---

## 0. Pricing summary (for reference)

| Product | ID | Apple Tier | Price | Type |
|---------|----|-----------:|-------|------|
| Pro Monthly | `monthly` | 4 | $3.99 | Auto-renewable subscription |
| Pro Yearly | `yearly` | 30 | $30.99 | Auto-renewable subscription |
| AI Credit Pack 10 | `consumable` | 2 | $1.99 | Consumable |

Trial: **7 days free** on first subscription (configured per product, both
monthly and annual). Subscription group: **`pantry_pro`** (one group, two
products so users can switch between monthly/annual without losing trial
eligibility).

**Entitlement**: `RecipeGen Pro`. All Pro features are gated behind this
single entitlement in RevenueCat. The constant `PRO_ENTITLEMENT` in
`lib/entitlements.ts` must match exactly.

---

## 1. App Store Connect

1. Go to **App Store Connect → Apps → RecipeGen → In-App Purchases**.
2. Enroll in the **Small Business Program** (Apps → Agreements →
   App Store Small Business Program). This drops Apple's commission from
   30% to 15%. You qualify if your annual proceeds are <$1M.

### 1a. Subscription group

1. Click **+** next to Subscription Groups.
2. Reference name: `pantry_pro`. Localized display name: "Pantry Pro".

### 1b. Subscriptions (in the `pantry_pro` group)

- **Pro Monthly**
  - Reference name: `Pro Monthly`
  - Product ID: `monthly`
  - Subscription duration: 1 month
  - Price: Tier 4 ($3.99/mo)
  - Free trial: 7 days (configure under Subscription Pricing)
  - Localized display name: `Pantry Pro Monthly`
  - Description: "Unlimited recipes, pantry, and AI features."
- **Pro Yearly**
  - Product ID: `yearly`
  - Subscription duration: 1 year
  - Price: Tier 30 ($30.99/yr)
  - Free trial: 7 days
  - Localized display name: `Pantry Pro Annual`
  - Description: "Save 35% vs monthly. Unlimited recipes, pantry, and AI."

### 1c. Consumable

- **AI Credit Pack — 10 ops**
  - Type: Consumable
  - Product ID: `consumable`
  - Price: Tier 2 ($1.99)
  - Localized display name: `AI Credits — 10 ops`
  - Description: "10 AI operations. One-time purchase. Never expire."

### 1d. Family Sharing

For both subscriptions, enable **Family Sharing** (under Sharing
configuration). The audience (households) will appreciate it. Consumables
do **not** support Family Sharing.

### 1e. Submit for Review

You can ship the IAPs independently of the app binary, or attach them to
the next version submission. Either way, Apple reviews IAPs separately
from the app — typically <1 day.

---

## 2. RevenueCat

1. Sign up at https://app.revenuecat.com (free under $2.5K MTR).
2. **Create project** → name it `RecipeGen`.
3. **Add app** → iOS → bundle ID `tech.ideagen.recipegen`. RevenueCat
   gives you a **public API key** (starts with `appl_...`). Save it.
4. **Connect to App Store**:
   - Project Settings → Apps → iOS → App-specific shared secret. You
     generate this in App Store Connect → Apps → RecipeGen → App
     Information → App-Specific Shared Secret. Paste into RevenueCat.
   - Connect via App Store Server-to-Server Notifications V2 (RevenueCat
     gives you a callback URL; paste into App Store Connect → Apps →
     RecipeGen → App Store Server Notifications).
5. **Import products**:
   - Project Settings → Products → Import from App Store.
   - You should see `monthly`, `yearly`, `consumable`.
6. **Create entitlement**:
   - Project Settings → Entitlements → + New.
   - Identifier: `RecipeGen Pro` (matches the `PRO_ENTITLEMENT` constant
     in `lib/entitlements.ts` exactly — case + space matter).
   - Attached products: `monthly`, `yearly`. (Not `consumable` — that's
     a one-shot grant, not an entitlement state.)
7. **Create offering**:
   - Offerings → + New offering → identifier `default`.
   - Add packages:
     - Monthly: package type `$rc_monthly`, product `monthly`
     - Annual: package type `$rc_annual`, product `yearly`
     - Credits: package type `custom`, identifier `consumable`,
       product `consumable`
   - Mark `default` as the **current offering**.
8. **Design the Paywall** (used by `<RevenueCatUI.Paywall />`):
   - Tools → Paywalls → + New paywall.
   - Attach to offering `default`.
   - Pick a template (Single tier / Multi tier — Single tier matches the
     monthly+annual+consumable layout best).
   - Customize headline / subhead / bullet points / colors. Brand color:
     terracotta `#8c3a1a` for accents to match the app's editorial
     palette. Optionally upload Fraunces as a custom font.
   - Add a footer link to `https://www.ideagen.tech/eula` (Terms) and
     `https://www.ideagen.tech/privacy` (Privacy).
   - Publish the paywall.
9. **Configure Customer Center** (used by `<RevenueCatUI.CustomerCenter />`):
   - Tools → Customer Center → enable.
   - Sections to enable: Manage subscription, Cancel subscription,
     Refund request, Help (link to `mailto:james@ideagen.tech`).
   - Optionally configure a "Why are you cancelling?" survey under
     Cancellation flow.
10. **Webhooks**:
    - Integrations → Webhooks → Add new webhook.
    - URL: `https://<your-supabase-project>.supabase.co/functions/v1/revenuecat-webhook`
    - Authorization header: pick a long random string (e.g. `openssl rand -hex 32`).
      Save this value — you'll set it as a Supabase secret in step 4.
    - Send a test ping; confirm 200.

---

## 3. Supabase migration + functions

```bash
# Apply schema + RPCs
supabase db push

# Deploy the AI edge functions (now using claim_ai_op)
supabase functions deploy generate-recipe
supabase functions deploy import-recipe
supabase functions deploy normalize-ingredient
supabase functions deploy extract-pantry-items

# Deploy the new RevenueCat webhook (no JWT verification — uses
# shared-secret auth instead)
supabase functions deploy revenuecat-webhook --no-verify-jwt
```

---

## 4. Supabase secrets

```bash
# RevenueCat webhook auth — paste the same string you set in step 2.7
supabase secrets set REVENUECAT_WEBHOOK_AUTH=<the-random-string>
```

`OPENAI_API_KEY` should already be set from the Phase 6 work.

---

## 5. iOS env vars

Add to `.env.local`:

```
EXPO_PUBLIC_REVENUECAT_APPLE_KEY=appl_XXXXXXXXXXXXXXXX
```

(Optional Android key for later if you ship to Play Store:
`EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY=goog_...`)

---

## 6. Build and run

```bash
# Install the new dependency
npm install

# Regenerate native folders so RevenueCat's CocoaPod is included
npx expo prebuild --platform ios --clean

# Build to a sandbox device — subscriptions can't be tested in the iOS
# simulator. Connect a physical iPhone.
npx expo run:ios --device
```

You'll need a **Sandbox Apple ID** to test purchases without being
charged. Create one in App Store Connect → Users and Access → Sandbox →
Testers. Sign out of the App Store on your test device, then attempt a
purchase — iOS will prompt for a sandbox Apple ID at purchase time.

---

## 7. Sandbox test plan

Log in to the iOS app with a real (non-sandbox) Supabase account, then
test each path:

- [ ] **Free user counter** — Settings → Subscription shows
  "0 / 5 AI ops this month."
- [ ] **Free user soft block** — Tap Snap pantry 6 times. The 6th tap
  prompts to upgrade or buy credits.
- [ ] **Recipe count hard block** — Add 50 recipes manually (or via SQL).
  Tapping "+ New" shows the "Your shelf is full" prompt that routes to
  the paywall.
- [ ] **Buy monthly** — From paywall, tap Monthly card. Sandbox prompt
  appears, complete purchase. Returns to paywall, then dismissed.
  Settings now reads "Pantry Pro · Monthly plan, renews <date>."
  AI quota now reads `tier: pro`.
- [ ] **Webhook arrival** — Check Supabase logs:
  ```
  supabase functions logs revenuecat-webhook
  ```
  You should see a JSON line `{event: "applied", status: "pro_monthly"}`.
- [ ] **Buy credit pack while subscribed** — Test bonus flow.
  `ai_credits_remaining` should increment by 10 in profiles row.
- [ ] **Cancel subscription** — In iOS Settings → Apple ID → Subscriptions,
  cancel. Wait for the `CANCELLATION` event in webhook logs. App Settings
  should now read "Cancelled — access until <expiry>."
- [ ] **Restore purchases** — Sign out of the app and back in, or wipe
  data. From paywall, tap Restore. Status should re-populate from
  RevenueCat.
- [ ] **Trial** — Start a fresh sandbox account, tap Monthly. Sandbox
  prompt offers 7-day trial. Confirm `subscription_status` shows
  `pro_monthly` immediately, but `is_trial_period` is true in the
  webhook event. (RevenueCat handles trial expiry automatically; the
  user gets a renewal event when the trial converts.)

---

## 8. Apple App Review checklist

For the submission containing IAPs:

- [ ] Pricing screen reachable from somewhere obvious in the app
  (e.g. Settings → Subscription → See Pro). Done.
- [ ] **Restore Purchases** button on paywall. Done.
- [ ] **Manage subscription** link. Done — uses Apple's standard URL.
- [ ] Terms of use + Privacy Policy links on paywall. Done.
- [ ] Trial copy unambiguous: "7 days free, then $3.99/mo." Done.
- [ ] Subscription group has at least monthly + annual so users can
  switch without losing trial eligibility. Done.
- [ ] No "fake free trial" — if a user previously had Pro and cancelled,
  they shouldn't be eligible for trial again. Apple handles this; just
  don't try to override it in code.
- [ ] In-app text matches what's in App Store Connect product
  metadata. Cross-check the localized display name.

---

## 9. Numbers to monitor post-launch

Set up alerts (RevenueCat dashboard or Supabase log queries):

- **Conversion rate** (free → trial start): aim for 3–8% at the
  AI-quota soft block, lower for cold paywalls.
- **Trial conversion** (trial start → first paid renewal): aim for
  50–70%. Below 40% suggests the value isn't landing in the first
  week.
- **Monthly → annual mix**: aim for 50–60% annual after a couple
  months. Annual = lower churn + better cash flow.
- **AI cost as % of MRR**: should be <15%. If higher, tighten the
  pro daily fair-use cap (currently 200¢/day, easily adjustable in
  migration 0020 — bump it once we see real data).
- **Credit pack attach rate** (free users buying credits): bonus
  revenue, not core. If conversion is low (<2%), consider lowering
  the price or making the offer more visible.

---

## 10. When you want to add the web Stripe path (Phase 2)

Apple now permits external purchase links per the April 2024 ruling.
If/when you want to save the 15% Apple cut on web purchases:

1. Apply for the **External Link Account Entitlement** in your Apple
   developer account (US storefront).
2. Build `web/pro/checkout.html` — a Stripe Checkout flow that creates
   a subscription and writes back to your Supabase profiles via a
   Stripe webhook (parallel pattern to RevenueCat).
3. In the iOS paywall, add a "Subscribe on the web — save 15%" link
   below the IAP cards. Apple's UX template requires a confirmation
   dialog ("You're leaving the app to make a purchase…"); read their
   App Review Guidelines section 3.1.1(a) carefully.
4. IAP must remain available alongside.

This is a Phase 2 task — ship Phase 1 first, validate the model, then
optimize.
