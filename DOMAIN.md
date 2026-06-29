# Domain configuration: ideagen.tech

This is a one-time runbook for tying `ideagen.tech` into the project.
Most of the work lives outside the repo (registrar, Supabase dashboard,
App Store Connect) — those steps are described below in execution order.

The pieces already wired into code (commit follow this file):
- `app/privacy.tsx`, `app/eula.tsx` — `james@ideagen.tech` as contact
- `app.json` — iOS `bundleIdentifier` + Android `package` set to
  `tech.ideagen.recipegen` (reverse-DNS of the domain)
- `supabase/DEPLOY.md` — auth-URL configuration block

The deep-link scheme `recipegen://` is **deliberately unchanged** — it
identifies the app, not the brand domain.

---

## 1. DNS (at your registrar)

`ideagen.tech` was just purchased; the registrar is the source of truth
for DNS. Add records depending on what you want to host:

### Email — required (the contact email won't work otherwise)

The contact link in the EULA and privacy policy points at
`james@ideagen.tech` — that mailbox needs to receive mail before App
Store review (Apple sometimes test-emails the address).

Confirm at the registrar / mail provider that:
- MX records are configured.
- `james@ideagen.tech` accepts incoming mail and lands somewhere you
  read.
- A test email from an outside address makes it through.

Common patterns:
- **Single mailbox** (your current setup) — registrar forwarding or a
  dedicated mail provider routes `james@ideagen.tech` straight to your
  inbox. Done.
- **Multiple aliases later** — if you ever add `noreply@`, `hello@`,
  etc., either add forwarding rules at the provider or move to Google
  Workspace / Fastmail with proper user accounts.

### Web — required for App Store privacy URL

The repo ships a tiny static site under `/web` (landing + privacy + eula).
Hosting steps in section 4 below.

---

## 2. Reply-from `james@ideagen.tech` (optional)

When you reply to a forwarded user email, Gmail's default From: is your
underlying inbox, not `james@ideagen.tech`. If you'd rather replies come
from the brand address:

- **Gmail**: Settings → Accounts → "Send mail as" → add
  `james@ideagen.tech`. Gmail will send a verification email to that
  address (your forwarding/inbox delivers it). Confirm, then pick
  "Reply from the same address the message was sent to".
- **Other clients**: most have an equivalent — set the outgoing identity
  to `james@ideagen.tech`.

For Supabase auth emails (sign-up confirmation, password reset, magic
link), see step 3 — by default they come from `noreply@mail.supabase.io`,
which Apple sometimes flags as confusing. Custom SMTP fixes that.

---

## 3. Supabase dashboard

Project → Authentication → **URL Configuration**:

| Field                     | Value                                  |
| ------------------------- | -------------------------------------- |
| Site URL                  | `https://ideagen.tech`                 |
| Additional redirect URLs  | `recipegen://`                         |
|                           | `recipegen://auth/callback`            |
|                           | `https://ideagen.tech/auth/callback`   |

**Why three redirects?** Auth confirmation emails (sign-up, password
reset, email change) redirect to a bridge page on the web that catches
the auth params and bounces them into the app via the deep link. The
flow:

1. User clicks `https://<project>.supabase.co/auth/v1/verify?…&redirect_to=https://ideagen.tech/auth/callback`
2. Supabase verifies the token, redirects browser to `https://ideagen.tech/auth/callback#access_token=…`
3. The bridge page (`web/auth/callback.html`) reads the params and JS-redirects to `recipegen://auth/callback?<same params>`
4. The OS opens RecipeGen, expo-router routes to `app/auth/callback.tsx`, which calls `supabase.auth.verifyOtp` or `setSession` and lands the user inside the tabs

Each URL must be in the allowlist or Supabase rejects the redirect.

Project → Authentication → **Providers** → enable **Anonymous Sign-Ins**:

The "Continue as guest" button on the sign-in screen calls
`supabase.auth.signInAnonymously()`. That endpoint is OFF by default on
Supabase — flip the toggle in the dashboard before guest mode works in
production. Local dev already has `enable_anonymous_sign_ins = true` in
`supabase/config.toml`.

Project → Authentication → **Rate Limits** → tighten anonymous sign-in:

Anonymous sessions have no email gate, so a single user can spin up
fresh anon accounts to bypass anything keyed on `user_id` (most
notably the daily AI cap — though guests can't use AI now, this is
still defense-in-depth). Set:

- **Anonymous sign-ins per IP per hour**: 5 (Supabase default is 30)
- **Anonymous sign-ins per IP per minute**: 1

Real users hit these limits only on rapid sign-out/in cycles, which is
unusual; legitimate guest mode use is one tap on the sign-in screen.

Project → Authentication → **SMTP Settings** (optional but recommended):

- **Sender email**: `james@ideagen.tech` for now (or add a `noreply@`
  alias later if you don't want sign-up replies hitting the same
  inbox).
- **Sender name**: RecipeGen (or whatever you want)
- **SMTP host/port/credentials**: from Resend/Postmark/SES/etc.

Without custom SMTP, Supabase rate-limits auth emails to 3/hour per
project — fine for dev, painful in production.

Project → Authentication → **Email Templates** (optional):
- Replace the default template footer / branding to reference
  `ideagen.tech` and `james@ideagen.tech`.

---

## 4. Hosting `/web`

The repo ships a static site under `/web` containing the landing page,
privacy policy, and EULA — all that's needed for App Store submission.

Two viable hosts. **If your registrar is Network Solutions, use Vercel
— it doesn't require nameserver delegation.** Cloudflare Pages also
works but needs you to point Network Solutions at Cloudflare's
nameservers, which their UI makes mildly annoying.

### Option A: Vercel (recommended for Network Solutions)

DNS stays at Network Solutions; you add one A record + one CNAME.

1. Sign in to <https://vercel.com> → Add New → Project → import the
   `recipegen` repo (or `food-recipe` if you haven't renamed it on
   GitHub yet).

2. Build settings:

   | Field             | Value     |
   | ----------------- | --------- |
   | Framework preset  | Other     |
   | Root Directory    | `web`     |
   | Build command     | *(blank)* |
   | Output Directory  | `.`       |

   `web/vercel.json` already configures clean URLs (`/privacy` →
   `privacy.html`), security headers, and cache TTLs.

3. Deploy. Vercel assigns a `*.vercel.app` subdomain — verify
   `/`, `/privacy`, `/eula` render there.

4. Project → Settings → Domains → Add `ideagen.tech` (apex) and
   `www.ideagen.tech`. Vercel will tell you exactly which DNS records
   to add. Currently those are:

   | Type  | Host  | Value                  |
   | ----- | ----- | ---------------------- |
   | A     | `@`   | `76.76.21.21`          |
   | CNAME | `www` | `cname.vercel-dns.com` |

5. At Network Solutions: Manage Account → My Domain Names → click
   `ideagen.tech` → Manage Advanced DNS Records (or "DNS Records").
   Add the A record and CNAME above. Save.

6. Back on Vercel, refresh the Domains page. SSL provisions
   automatically once DNS propagates (10 min – 24 h, usually fast).

7. Test: <https://ideagen.tech>, <https://ideagen.tech/privacy>,
   <https://ideagen.tech/eula>.

### Option B: Cloudflare Pages (requires nameserver delegation)

1. Sign in to <https://dash.cloudflare.com> → Websites → Add a site →
   `ideagen.tech`. Cloudflare gives you two nameserver **hostnames**
   (e.g. `astra.ns.cloudflare.com`, `bob.ns.cloudflare.com`).

2. At Network Solutions: Manage Account → My Domain Names → click
   `ideagen.tech` → **Change Where Domain Points** → "Use a different
   name server". Enter the two Cloudflare hostnames. **Do not** use
   the "Personal Nameservers" or "Glue Records" screen — that's for a
   different scenario and asks for IPs you don't have.

3. DNS propagation: 1–24 h. Cloudflare emails you when delegation
   completes.

4. Cloudflare Pages → Create project → Connect to Git → pick the
   `recipegen` repo (or `food-recipe` if not renamed yet). Build settings:

   | Field                   | Value      |
   | ----------------------- | ---------- |
   | Framework preset        | None       |
   | Build command           | *(blank)*  |
   | Build output directory  | `web`      |

5. After first deploy: Custom domains → `ideagen.tech`. SSL active
   in ~1 min once delegation has propagated.

### Updating the site

Push to `main`. Both hosts auto-deploy on every push. Static HTML, so
changes ship in ~30 seconds.

### Keeping in-app and on-web policy text in sync

The truth lives in `app/privacy.tsx` and `app/eula.tsx`. The HTML mirrors
in `/web/privacy.html` and `/web/eula.html` are hand-maintained — when
you bump the `EFFECTIVE_DATE` constant, update both the `.tsx` *and* the
`.html` (the `<p class="effective">` line).

## 5. App Store Connect

When you submit the iOS app:

- **Privacy Policy URL**: `https://ideagen.tech/privacy`
- **Support URL**: `https://ideagen.tech` (the landing page has the
  contact link; no separate support page needed for v1)
- **Marketing URL** (optional): `https://ideagen.tech`

Apple **requires** the privacy policy URL to be publicly accessible.
The in-app `app/privacy.tsx` screen alone doesn't satisfy this — that's
why `/web/privacy.html` exists.

Apple's standard EULA is the default and is fine. If you want to use
your custom EULA from `/web/eula.html`, link it during submission as
the End User License Agreement.

---

## 6. Bundle IDs (already changed in code)

`app.json` now declares:

- iOS: `tech.ideagen.recipegen`
- Android: `tech.ideagen.recipegen`

When you create the iOS app in App Store Connect, use the same bundle
ID. When you create the Android app in Play Console, use the same
package. **Do not change these after first submission** — they're
permanent identifiers.

Pre-launch, this is free to change. After first App Store / Play Store
submission, the bundle ID becomes a permanent identifier — changing it
later requires a brand-new app listing and orphans existing installs.
We're still pre-launch, so we're fine.

For local dev: after pulling the new bundle ID, run
`npx expo prebuild --clean` to regenerate `/ios` and `/android` with
the new identifiers, then `npx expo run:ios` (or `run:android`) for a
fresh dev build. The old dev install on your simulator becomes a
different app and can be deleted.

---

## 7. GitHub repo (cosmetic)

The repo is currently at `https://github.com/James-10-24/food-recipe`.
Renaming it to `recipegen` matches the product name everywhere else and
is recommended; GitHub auto-redirects the old URL so existing clones
keep working. Settings → Repository name → `recipegen` → Rename.

`package.json` has already been bumped to `recipegen`, and the Expo
slug in `app.json` is `recipegen`. Internal identifiers everywhere are
in sync.

---

## Checklist

- [x] Mailbox `james@ideagen.tech` receives mail
- [ ] (Optional) Gmail "Send mail as" so replies appear from
      `james@ideagen.tech`
- [ ] (Optional) Custom SMTP for Supabase auth emails
- [ ] Supabase: Site URL set to `https://ideagen.tech`
- [ ] Supabase: redirect URLs include `recipegen://`
- [ ] Vercel (or Cloudflare Pages): project connected to repo, root
      directory `web`
- [ ] DNS: A `@` → `76.76.21.21` + CNAME `www` → `cname.vercel-dns.com`
      added at Network Solutions (or, if using Cloudflare Pages,
      nameservers delegated)
- [ ] SSL active on `ideagen.tech`
- [ ] `https://ideagen.tech/` loads
- [ ] `https://ideagen.tech/privacy` loads
- [ ] `https://ideagen.tech/eula` loads
- [ ] App Store Connect: app created with bundle ID
      `tech.ideagen.recipegen`
- [ ] App Store Connect: Privacy Policy URL set to
      `https://ideagen.tech/privacy`
- [ ] Play Console: app created with package `tech.ideagen.recipegen`
