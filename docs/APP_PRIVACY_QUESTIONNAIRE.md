# App Privacy Questionnaire — RecipeGen

Pre-filled answers for App Store Connect → App Privacy. Apple's
questionnaire walks through every data category, asks if RecipeGen
collects it, whether it's linked to the user, and whether it's used to
track them across other apps. Have this doc open when filling out the
submission so you don't second-guess each answer.

The categories below mirror what's disclosed in:
- `app/privacy.tsx` → "What appears in the App Store privacy summary"
  (in-app)
- `web/privacy.html` → § 03 (external URL: `https://ideagen.tech/privacy`)

If you change what's collected, update **all three** in lockstep.

---

## Tracking

**Does this app use data for tracking purposes?**

> **No.**

Reasoning: RecipeGen does not embed third-party analytics SDKs, ad
networks, or any tracker that combines user data with data from other
apps or websites. RevenueCat tracks subscription state but is treated as
a service provider (App Functionality), not a tracker.

This answer means you do **not** need to display Apple's App Tracking
Transparency (ATT) prompt.

---

## Data Types Collected

For each category below, declare it as collected if applicable. Apple
considers data "collected" if it's transmitted off the user's device.

### Contact Info

**Email Address**
- Collected: **Yes**
- Linked to user: **Yes**
- Tracking: **No**
- Purposes: App Functionality (sign-in only)

### User Content

**Photos or Videos**
- Collected: **Yes** (recipe photos + pantry-snap photos)
- Linked to user: **Yes** (recipe photos persist; pantry-snap photos do
  NOT — see notes below)
- Tracking: **No**
- Purposes: App Functionality

> **Note on pantry photos:** the photo is forwarded to OpenAI in-memory
> for ingredient recognition and is NOT stored on RecipeGen servers.
> Recipe photos uploaded to Supabase storage ARE stored. Apple's
> questionnaire collapses these into one "Photos or Videos" answer;
> declare Yes/Linked and surface the pantry-photo handling detail in
> the privacy policy (already done).

**Other User Content**
- Collected: **Yes** (recipes, meal plans, pantry items, grocery lists,
  cook history, reports filed)
- Linked to user: **Yes**
- Tracking: **No**
- Purposes: App Functionality

### Identifiers

**User ID**
- Collected: **Yes** (UUID generated at sign-up via Supabase auth)
- Linked to user: **Yes**
- Tracking: **No**
- Purposes: App Functionality

> **Device ID**: Not collected. RecipeGen uses Supabase user IDs only,
> not advertising or device identifiers.

### Purchases

**Purchase History**
- Collected: **Yes** (subscription state, product purchased, expiration
  date — via RevenueCat webhook)
- Linked to user: **Yes**
- Tracking: **No**
- Purposes: App Functionality

### Usage Data

**Product Interaction**
- Collected: **Yes** (counts and dollar cost of AI calls, used to enforce
  the daily AI cap)
- Linked to user: **Yes**
- Tracking: **No**
- Purposes: App Functionality

> **Other Usage Data**: Not collected. RecipeGen does not log generic
> taps, scrolls, or screen views.

### Diagnostics

> **Decision pending — depends on whether crash reporting / Sentry is
> wired up at launch.**
>
> - If **NO crash analytics integrated**: declare nothing in Diagnostics.
> - If **crash analytics integrated** (e.g. Sentry, Expo crash reporting):
>   - **Crash Data**: Yes, Linked, No-Tracking, App Functionality.
>   - **Performance Data**: Yes if performance metrics are collected,
>     Linked, No-Tracking, App Functionality.
>
> Verify this decision before submission and update this section.

---

## NOT Collected

Declare these as NOT collected to satisfy Apple's full-coverage
questionnaire flow:

- **Health & Fitness** (no health data, no nutritional logging in v1)
- **Financial Info** (no — Apple processes payments, RecipeGen never
  sees card data)
- **Location** (no — no geolocation features in v1)
- **Sensitive Info** (no — no race, religion, political, sexual
  orientation, etc.)
- **Contacts** (no — no address book access)
- **Search History** (in-app search, but not collected off-device)
- **Browsing History** (no — no web browsing in-app)
- **Audio Data** (no — microphone unused, Info.plist permission stripped)
- **Other Data** (no)

---

## Third-Party Partners

For each data type collected, Apple asks which third-party services
process it. RecipeGen's processors:

| Service | What's shared | Purpose |
|---------|---------------|---------|
| Supabase | All user content + email + user ID | Hosting (database, auth, storage, edge functions) |
| OpenAI | AI prompt text + pantry photos (in-memory only, not stored) | AI features (recipe gen, URL extraction, normalization, moderation, pantry photo recognition) |
| RevenueCat | User ID, App Store transaction ID, product ID, expiration date | Subscription management |
| Apple App Store | Payment + receipt metadata | Payment processing |

None of these process data for tracking purposes. All are bound by their
own published privacy policies.

---

## Privacy Policy URL

When filling in the App Store Connect submission:

- **Privacy Policy URL**: `https://ideagen.tech/privacy`
- **Support URL**: `https://ideagen.tech/support`
- **Marketing URL** (optional): `https://ideagen.tech/`

All three are hosted via Vercel (`/web` in this repo).

---

## Submission Checklist (Privacy Section)

- [ ] Tracking: No
- [ ] Contact Info → Email: Yes / Linked / No Tracking / App Functionality
- [ ] User Content → Photos: Yes / Linked / No Tracking / App Functionality
- [ ] User Content → Other Content: Yes / Linked / No Tracking / App Functionality
- [ ] Identifiers → User ID: Yes / Linked / No Tracking / App Functionality
- [ ] Purchases → Purchase History: Yes / Linked / No Tracking / App Functionality
- [ ] Usage Data → Product Interaction: Yes / Linked / No Tracking / App Functionality
- [ ] Diagnostics: per crash-reporting decision (see above)
- [ ] All other categories: Not Collected
- [ ] Privacy Policy URL pasted: `https://ideagen.tech/privacy`
- [ ] Privacy Policy URL is reachable and returns 200 OK
- [ ] In-app privacy screen text matches the external URL

---

## When to update this doc

Update **before** any of the following:

- Adding a new third-party SDK (analytics, ads, crash reporter)
- Collecting a new category (location, health, contacts, etc.)
- Sharing any data with a new third party
- Enabling ATT for a tracking purpose

Apple cross-references the App Privacy section with their automated
scans of the binary. If the binary phones home to a tracking SDK that
isn't declared, the app gets rejected.
