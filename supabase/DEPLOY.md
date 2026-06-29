# Supabase deploy sequence

This file is the canonical deploy runbook for the Postgres schema and edge
functions. Run these whenever a migration or function changes; running them
when nothing changed is a no-op.

For the one-time domain configuration (after buying `ideagen.tech`) see
`/DOMAIN.md` at the repo root.

## Required environment

Set on the Supabase project (Project Settings → Edge Functions → Secrets):

- `OPENAI_API_KEY` — used by `import-recipe`, `generate-recipe`, and
  `update-display-name`. If unset, moderation fails OPEN and a
  `console.warn` fires once per cold start. Keep it set in production.

The standard Supabase secrets (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) are injected automatically.

## Auth URL configuration

Authentication → URL Configuration in the Supabase dashboard:

- **Site URL**: `https://ideagen.tech`
- **Additional redirect URLs**:
  - `recipegen://` (deep-link back into the iOS/Android app)
  - `https://ideagen.tech/auth/callback` (web fallback, when you host a
    web build)

The `additional_redirect_urls = ["recipegen://"]` line in `config.toml`
covers `supabase start` (local dev only); production redirect URLs must be
set in the dashboard.

## Schema (migrations)

```bash
supabase db push
```

Re-running is safe — every migration uses `if exists` / `if not exists`
guards.

## Edge functions

Functions are deployed individually. After any change to the function or to
shared code under `supabase/functions/_shared/`:

```bash
supabase functions deploy import-recipe
supabase functions deploy generate-recipe
supabase functions deploy normalize-ingredient
supabase functions deploy extract-pantry-items
supabase functions deploy delete-account
supabase functions deploy update-display-name
```

Both `delete-account` and `update-display-name` require a logged-in user —
they call `authenticate(req)` from `_shared/auth.ts`. Do **not** pass
`--no-verify-jwt`; the functions enforce auth themselves and skipping JWT
verification only saves Supabase the upfront check.

## Phase 6 first-time deploy checklist

The only Phase 6 step that's easy to forget:

1. `supabase db push` — applies migrations 0011 + 0012 (public library,
   compliance, hardening).
2. `supabase functions deploy delete-account` — required for the Settings
   "Delete account" flow.
3. `supabase functions deploy update-display-name` — required for the
   moderated display-name update; without it, the Settings save will 404.
4. Verify `OPENAI_API_KEY` is set on the project.

After deploy, smoke-test:

- Sign in, open Discover, open a public recipe, tap "Save to my recipes".
  Should land in your library and show "Saved from <title> by <author>".
- Open the ⋯ menu on a public recipe, file a report, watch the in-modal
  success flash, then check Settings → Your reports.
- Tap Withdraw on the report; it should disappear.
- Settings → change display name; should round-trip through OpenAI
  moderation (try something safe first).
