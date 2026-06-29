// Supabase Edge Function: admin-delete-user
//
// Privileged delete — wipes a user's auth.users row, which cascades through
// FK constraints to remove all their content. Same plumbing as the
// user-initiated delete-account function, gated on admin status + step-up.
//
// Audit log is written AFTER the delete completes (with succeeded/error
// fields), not before — so a failed delete doesn't leave a misleading
// "I deleted X" entry. The single-write-after pattern means we lose the
// log entirely if the function crashes between delete and log; the
// alternative (write-before then update-after) doubles the write cost
// for a marginal forensics gain.
//
// Auth: must be admin + step-up active (90s window, see migration 0019).
// Refuses self-delete, refuses deleting another admin (revoke admin first).
//
// Deploy:
//   supabase functions deploy admin-delete-user

// deno-lint-ignore-file no-explicit-any
import {
  adminCorsHeaders,
  jsonResponseWithCors,
  preflightResponseWithCors,
} from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

function structuredLog(event: string, fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'admin-delete-user',
      event,
      ...fields,
    }),
  );
}

Deno.serve(async (req: Request) => {
  const cors = adminCorsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return preflightResponseWithCors(cors);
  const json = (b: unknown, s = 200) => jsonResponseWithCors(b, s, cors);

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req);
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  // Admin gate.
  const { data: adminCheck, error: adminErr } = await auth.client.rpc('is_admin');
  if (adminErr || adminCheck !== true) {
    return json({ error: 'Admin access required' }, 403);
  }

  // Step-up gate. 419 is non-standard but communicates "stale auth"
  // distinctly to the client which can re-prompt and retry.
  const { data: stepUp } = await auth.client.rpc('admin_step_up_active');
  if (stepUp !== true) {
    return json({ error: 'Step-up auth required', step_up_required: true }, 419);
  }

  let body: { user_id?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const userId = body.user_id;
  if (!userId || typeof userId !== 'string') {
    return json({ error: 'user_id is required' }, 400);
  }
  if (userId === auth.user_id) {
    return json({ error: "Don't delete yourself from the admin panel" }, 400);
  }

  // Refuse to delete another admin via this endpoint — revoke admin first.
  const { data: targetIsAdmin } = await auth.client
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (targetIsAdmin) {
    return json(
      { error: 'Revoke admin status before deleting an admin' },
      400,
    );
  }

  const reason = (body.reason ?? '').slice(0, 500);

  // Snapshot the target's profile so the audit log entry has identifying
  // info even after the cascade scrubs the auth row.
  const { data: targetProfile } = await auth.admin
    .from('profiles')
    .select('display_name, account_status')
    .eq('id', userId)
    .maybeSingle();
  const { data: targetAuth } = await auth.admin.auth.admin.getUserById(userId);
  const snapshot = {
    email: targetAuth?.user?.email ?? null,
    display_name: targetProfile?.display_name ?? null,
    account_status: targetProfile?.account_status ?? null,
  };

  structuredLog('delete_attempt', {
    admin_id: auth.user_id,
    target_id: userId,
    snapshot,
  });

  const { error: deleteErr } = await auth.admin.auth.admin.deleteUser(userId);

  // Always log, with success/failure status. The audit row uses service-role
  // client which bypasses RLS — admin_actions has no public insert anyway.
  await auth.admin.from('admin_actions').insert({
    admin_id: auth.user_id,
    action: 'delete_user',
    target_kind: 'user',
    target_id: userId,
    notes: reason || null,
    metadata: snapshot,
    succeeded: !deleteErr,
    error: deleteErr ? deleteErr.message : null,
  });

  if (deleteErr) {
    structuredLog('delete_failed', {
      admin_id: auth.user_id,
      target_id: userId,
      err: deleteErr.message,
    });
    return json({ error: deleteErr.message }, 500);
  }

  structuredLog('delete_succeeded', {
    admin_id: auth.user_id,
    target_id: userId,
  });
  return json({ ok: true });
});
