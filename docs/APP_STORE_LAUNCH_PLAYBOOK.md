# App Store launch playbook

Run-through to execute once Apple Developer enrollment lands. ~3–4 hour
focused session in order. Each step depends on the previous.

The associated code (Sign in with Apple, RevenueCat integration,
Restore Purchases UX, guest branching) is already shipped and waiting
for the configuration described here.

---

## Pre-flight

You need:

- Apple Developer Program enrollment ($99/yr) — **already paid, awaiting approval**
- A real iPhone for testing (simulator can't do Sign in with Apple)
- The bundle ID `tech.ideagen.recipegen` (already in `app.json`)
- The production Supabase project ref (e.g. `abcdefghijklmn`)

You do NOT need:

- Anything to install locally; this is mostly dashboard work
- A second Apple ID yet (only needed in Step 6 for Family Sharing test)

---

## Step 1 — Apple Developer Portal (~30 min)

→ [developer.apple.com](https://developer.apple.com) → Certificates, Identifiers & Profiles

### Register the App ID

- **Identifiers** → **+** → **App IDs** → **App**
- Bundle ID: `tech.ideagen.recipegen`
- Description: `RecipeGen`
- Capabilities: ☑ **Sign In with Apple**

### Create a Services ID (so Supabase Auth can verify SIWA tokens)

- **Identifiers** → **+** → **Services IDs**
- Identifier: `tech.ideagen.recipegen.signin`
- Description: `RecipeGen Sign In`
- After saving, edit → ☑ **Sign In with Apple** → **Configure**
  - Primary App ID: the one you just made
  - Domains: `ideagen.tech`
  - Return URLs: `https://<your-project-ref>.supabase.co/auth/v1/callback`
    (the exact URL is shown in Supabase → Auth → Providers → Apple)

### Create the SIWA private key

- **Keys** → **+** → **Sign in with Apple**
- Key Name: `RecipeGen SIWA Key`
- ☑ **Sign In with Apple** → **Configure** → pick the Primary App ID
- **Download the .p8 file — you only get to download it once.**
- Note the **Key ID** (10 chars, shown on the key page) and your
  **Team ID** (top-right of any developer.apple.com page).

Save these four artifacts somewhere safe — you'll paste them into
Supabase in Step 5:

- `tech.ideagen.recipegen.signin` (Service ID)
- Team ID
- Key ID
- `.p8` file contents

---

## Step 2 — App Store Connect (~45 min)

→ [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → My Apps → **+** → New App

### Create the app entry

- Platform: iOS
- Name: `RecipeGen`
- Bundle ID: `tech.ideagen.recipegen` (should appear in dropdown)
- SKU: `RECIPEGEN_001` (not user-facing)

### Create the subscription group

- **In-App Purchases & Subscriptions** → **Create Subscription Group**
- Reference Name: `Pantry Pro`

### Inside the subscription group, create both products

**pantry_pro_monthly:**
- Reference Name: `Pantry Pro Monthly`
- Product ID: `pantry_pro_monthly`
- Duration: 1 Month
- Price: $3.99 USD
- ☐ **Family Sharing** — leave UNCHECKED (per pricing grill, see [docs/PRICING_DECISIONS.md](PRICING_DECISIONS.md); Family Sharing is the annual conversion lever)
- Localizations: fill in Display Name + Description (English + Simplified Chinese per [docs/V1_SCOPE_DECISIONS.md](V1_SCOPE_DECISIONS.md))
- **Introductory Offer**: 7-day free trial

**pantry_pro_annual:**
- Reference Name: `Pantry Pro Annual`
- Product ID: `pantry_pro_annual`
- Duration: 1 Year
- Price: $27.99 USD (42% off vs monthly×12; bumped from $30.99 per pricing grill)
- ☑ **Family Sharing**
- Localizations: fill in (English + Simplified Chinese)
- **Introductory Offer**: 7-day free trial

### Create the consumable IAP (separate section, not in the group)

> **Deferred to v1.x** per [docs/PRICING_DECISIONS.md](PRICING_DECISIONS.md).
> Set up the product in App Store Connect (so the IAP exists when 1.x
> ships) but **do NOT submit it for review** with the v1 launch — the
> client-side purchase flow is not built. Leave it in draft state.

**credit_pack_10:**
- Type: Consumable
- Reference Name: `AI Credit Pack 10`
- Product ID: `credit_pack_10`
- Price: $1.99 USD
- Localizations: fill in
- Family Sharing is N/A for consumables
- **Status:** Draft (do not submit with v1)

### Generate an App Store Connect API Key

- **Users and Access** → **Integrations** tab → **App Store Connect API** → **Keys**
- **+ Generate API Key**
- Name: `RevenueCat`
- Access: **App Manager** (minimum RC needs)
- **Download the .p8 file — one-shot download.**
- Note the **Key ID** + **Issuer ID** shown on the keys page.

---

## Step 3 — RevenueCat (~30 min)

→ [app.revenuecat.com](https://app.revenuecat.com) → sign up (free)

### Create the project + iOS app

- Create project: `RecipeGen`
- **Project Settings** → **Apps** → **+ Add iOS App**
  - Bundle ID: `tech.ideagen.recipegen`
  - App Store Connect API Key: upload the `.p8` from Step 2
  - Issuer ID + Key ID: from Step 2
- Copy the `appl_…` SDK key (right column, "Public API Keys")

### Configure the iOS app

- **Project Settings** → **Apps** → **iOS** → ☑ **Enable Family Sharing**
- **Project Settings** → **Transfer Behavior** → confirm **"Transfer"** (default)

### Verify product sync

- **Products** — wait ~5 min for App Store Connect sync, then verify:
  - `pantry_pro_monthly` appears
  - `pantry_pro_annual` appears
  - `credit_pack_10` appears

### Create the entitlement + offering

- **Entitlements** → **+** → name it `pro`
  - Attach `pantry_pro_monthly` + `pantry_pro_annual`
- **Offerings** → use the default offering called `current`
  - Add package `$rc_monthly` → `pantry_pro_monthly`
  - Add package `$rc_annual` → `pantry_pro_annual`

### Set up the webhook

- **Integrations** → **Webhooks** → **+ Add Webhook**
- URL: `https://<your-supabase-ref>.supabase.co/functions/v1/revenuecat-webhook`
- Authorization header value: generate a random string (e.g. `openssl rand -hex 32`), save it for the next step

---

## Step 4 — Supabase + EAS secrets (~10 min)

```bash
# Supabase Edge Function secret (for webhook auth)
supabase secrets set REVENUECAT_WEBHOOK_AUTH=<random-string-from-step-3> \
  --project-ref <your-prod-ref>

# EAS Build secret (compiled into the iOS bundle)
eas secret:create --scope project \
  --name EXPO_PUBLIC_REVENUECAT_APPLE_KEY \
  --value appl_<from-step-3>
```

---

## Step 5 — Supabase Auth + Apple provider

→ Supabase dashboard → **Authentication** → **Providers** → **Apple** → Enable

Paste in from Step 1:

- Service ID: `tech.ideagen.recipegen.signin`
- Team ID: from Apple Developer portal (top-right corner)
- Key ID: from the SIWA key page
- Secret Key: the full contents of the `.p8` file, including the
  `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines

### URL config

- **Authentication** → **URL Configuration** → **Additional redirect URLs**:
  - Add: `recipegen://**`
  - Confirm `https://ideagen.tech/auth/callback` is already there

---

## Step 6 — EAS Build + TestFlight smoke test (~60 min including build)

### Build + submit

```bash
eas build --platform ios --profile production
```

Once the build completes, submit it to TestFlight via App Store Connect.

### Smoke test checklist (on a real iPhone)

Sign-in paths:
- [ ] Apple Sign-In → confirmation → land in tabs
- [ ] Email signup → confirm email → land in tabs
- [ ] Email sign-in (existing account) → land in tabs

Purchase paths:
- [ ] Open paywall → tap monthly → sandbox purchase → confirm Pantry Pro flips on (may take a few seconds for webhook to land)
- [ ] Open paywall → tap annual → sandbox purchase → confirm Pantry Pro flips on
- [ ] Buy a $1.99 credit pack → confirm 10 credits added to quota

Restore Purchases:
- [ ] Reinstall app → sign in → tap Restore Purchases → confirm `'restored'` branch
- [ ] Switch to a 2nd sandbox Apple ID → Restore → confirm `'nothing-on-apple-id'` branch shows with the helpful copy

Guest flows:
- [ ] Guest mode → add a recipe → tap Sign In → confirm branch UI appears with correct counts
- [ ] Guest → "Save my data" path → confirm recipes preserved after upgrade
- [ ] Guest → "Sign in to existing" → confirm dialog → confirm recipes deleted, can sign into existing account

Family Sharing:
- [ ] Set up a test Family Sharing group (your developer Apple ID + a secondary test Apple ID)
- [ ] Family organizer buys Pantry Pro
- [ ] Family member opens RecipeGen on their Apple ID (their own RecipeGen account)
- [ ] Confirm Pantry Pro entitlement appears on the family member's account

---

## Production-build guard

`lib/purchases.ts` will refuse to launch a production build (`!__DEV__`) if
the RevenueCat key starts with `test_`. This is the safety net against
forgetting Step 4's EAS secret — the app will crash visibly at first launch
on TestFlight, not silently after submission.

To trigger: build with no `EXPO_PUBLIC_REVENUECAT_APPLE_KEY` set in EAS
secrets → smoke test on TestFlight → first launch throws `RevenueCat:
refusing to launch a production build with a test_ key.`

---

## Reference: what each step unlocks

| Step | Unlocks |
|---|---|
| 1 | Sign in with Apple capability + SIWA token verification |
| 2 | Subscription products exist in App Store Connect + ASC API access for RevenueCat |
| 3 | Production `appl_` SDK key + product mapping + webhook config |
| 4 | Webhook auth + production EAS bundle gets the real key |
| 5 | Supabase Auth can validate Apple identity tokens |
| 6 | End-to-end verification before App Review submission |
