# RecipeGen Web (PWA)

The installable **Progressive Web App** build of [RecipeGen](https://github.com/James-10-24/recipegen) — a meal-planning + smart-pantry app. Plan meals for a date range, get a grocery list that subtracts your pantry and rounds to real package sizes, and stop overbuying.

This repo is the **same Expo / React Native codebase** as the mobile app, compiled for the web via `react-native-web` and packaged as a PWA (web app manifest + service worker + installable icons). It talks to the **same Supabase backend** as the iOS/Android apps, so accounts, recipes, pantry, and Pro entitlement are shared.

## Stack

- **App:** Expo SDK 54 + React Native + `react-native-web` + Expo Router
- **Output:** SPA (`web.output: "single"`) → static `dist/`, client-side routing
- **Styling:** NativeWind (Tailwind for RN)
- **State:** TanStack Query + Zustand
- **Backend:** Supabase (shared with the mobile app)
- **PWA:** `public/manifest.json`, `public/sw.js`, icons in `public/icons/`, head tags injected post-export by `scripts/inject-pwa.mjs`
- **Hosting:** Vercel (`vercel.json`)

## What differs from the native app

In-app purchases and native auth have no browser equivalent, so the web build swaps them for stubs via Metro's `.web.ts` platform resolution — native code is untouched:

| Native module | Web behavior |
|---|---|
| `react-native-purchases` (RevenueCat) | Stubbed (`lib/rc.web.ts`, `lib/purchases.web.ts`). Purchases can't run in a browser. |
| `react-native-purchases-ui` | Stubbed (`lib/rc-ui.web.ts`). The paywall renders `app/paywall.web.tsx`, which points users to the mobile app to subscribe. |
| `expo-apple-authentication` | Apple button is already `Platform.OS === 'ios'`-gated; hidden on web. Email auth works. |

**Pro is still honored on web.** Entitlement is enforced server-side (`my_ai_quota` / `is_pro` RPC), so a user who subscribed on mobile gets Pro features here too — they just can't start a *new* purchase in the browser.

## Develop

```bash
npm install

# env — same Supabase project as the mobile app
cp .env.example .env.local
# fill EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY

npm run web        # Expo dev server (web)
```

## Build the PWA

```bash
npm run build:web  # expo export --platform web  +  inject-pwa.mjs
# output → dist/
```

To preview the production build locally:

```bash
npx serve dist     # or any static server
```

## Deploy (Vercel)

The PWA is served under the **`/app` base path** (`experiments.baseUrl` in `app.json`) so it can sit behind the existing marketing domain at `yourdomain.com/app`. The build outputs a self-contained `dist/app/`.

**Two-project setup** — the marketing site (the `recipegen` repo's `web/` folder) keeps the custom domain; this project deploys separately and the marketing project proxies `/app/*` to it:

1. Import this repo in Vercel as its own project. `vercel.json` sets the build command (`npm run build:web`), output dir (`dist`), the in-`/app` SPA rewrite, and caching headers. This gives you e.g. `https://recipegen-web.vercel.app/app`.
2. Add the environment variables in **Project → Settings → Environment Variables**:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`
3. In the **marketing project** (`web/vercel.json`), a rewrite proxies `yourdomain.com/app/*` → this project's deployment, plus a `/app`-scoped CSP that allows Supabase. Confirm the proxy target URL there matches this project's production domain.
4. Add `https://yourdomain.com` (the marketing origin, not the `*.vercel.app` one) to **Supabase → Auth → URL Configuration** (Site URL + redirect URLs) so email/OAuth callbacks resolve.
5. Deploy both. Visit `yourdomain.com/app`.

## Project layout

```
app/                  Expo Router screens (shared with mobile)
  paywall.web.tsx     web-only paywall fallback
components/           shared UI primitives
lib/
  rc.ts / rc.web.ts           react-native-purchases wrapper (native | web stub)
  rc-ui.ts / rc-ui.web.ts     react-native-purchases-ui wrapper (native | web stub)
  purchases.web.ts            web stub for the RevenueCat lifecycle module
  supabase.ts                 Supabase client (AsyncStorage → localStorage on web)
public/
  manifest.json       PWA manifest
  sw.js               service worker (network-first nav, SWR assets)
  icons/              192 / 512 / maskable / apple-touch
scripts/
  inject-pwa.mjs      injects PWA head tags into dist/index.html post-export
vercel.json           build + SPA rewrites + caching headers
```

## Keeping in sync with the mobile app

This is a standalone copy of the app codebase. Shared screen/logic changes made in [`recipegen`](https://github.com/James-10-24/recipegen) need to be brought over here (and vice-versa). The web-specific surface is small and isolated: the `*.web.ts(x)` files, `public/`, `scripts/inject-pwa.mjs`, `vercel.json`, and `web.output: "single"` in `app.json`.
