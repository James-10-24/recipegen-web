// Supabase Edge Function: delete-account
//
// App Store UGC compliance: a logged-in user can permanently delete their
// account and all associated data. The auth.users row is removed via the
// service-role admin API; FK cascades remove the user's recipes, pantry,
// meal plans, cook log, ai_usage, blocks, and reports they filed. Custom
// ingredients they created are anonymized (user_id → null) so other
// users' clones don't break — see migration 0011.
//
// Auth required. No body parameters.
//
// Deploy:
//   supabase functions deploy delete-account

import { jsonResponse, preflightResponse } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflightResponse();
  if (req.method !== 'POST')
    return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req);
  if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);

  // ingredients.user_id has ON DELETE SET NULL (migration 0011), so the
  // cascade from auth.users → ingredients atomically anonymizes any rows
  // this user authored. Doing it explicitly here would risk a partial
  // failure where ingredients are anonymized but the auth delete fails,
  // leaving the user logged in with their authored ingredients orphaned.
  // Trust the cascade.
  const { error } = await auth.admin.auth.admin.deleteUser(auth.user_id);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }

  return jsonResponse({ ok: true });
});
