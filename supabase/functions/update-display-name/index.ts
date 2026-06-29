// Supabase Edge Function: update-display-name
//
// Display name is the only profile field shown to other users (it surfaces
// as the byline on public recipes). Routing the update through this
// function lets us run the input through OpenAI's moderation API before
// it lands in the database — keeps slurs / harassment / impersonation out
// of Discover.
//
// Auth required. No daily-cap charge (moderation is free).
//
// Deploy:
//   supabase functions deploy update-display-name

import { jsonResponse, preflightResponse } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { moderate } from '../_shared/moderation.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflightResponse();
  if (req.method !== 'POST')
    return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req);
  if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (auth.is_anonymous) {
    // Display names surface on public recipes; guests can't publish, so
    // setting one would be cosmetic only. Force them through the upgrade
    // path before they can pick a name.
    return jsonResponse(
      { error: 'Save your account to set a display name.' },
      403,
    );
  }

  let body: { display_name?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const trimmed = (body.display_name ?? '').trim().slice(0, 60);

  if (trimmed.length > 0) {
    const mod = await moderate(trimmed);
    if (mod.flagged) {
      return jsonResponse(
        {
          error: "That display name doesn't comply with our community guidelines.",
        },
        400,
      );
    }
  }

  // User-scoped client: respects the existing `profiles_self` RLS policy
  // (id = auth.uid()). No service-role bypass needed — the user is updating
  // their own row, and RLS is the source of truth.
  const { error } = await auth.client
    .from('profiles')
    .update({ display_name: trimmed.length > 0 ? trimmed : null })
    .eq('id', auth.user_id);

  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  return jsonResponse({
    ok: true,
    display_name: trimmed.length > 0 ? trimmed : null,
  });
});
