// Supabase Edge Function: admin-step-up
//
// Verifies the caller's password and stamps a fresh row in admin_step_up.
// Destructive admin RPCs (and admin-delete-user) check admin_step_up_active()
// — true if the caller has stamped within the last 90 seconds.
//
// Why a separate function and not just RPC:
//   · Verifying a password requires signInWithPassword, which is an Auth API
//     call. RPCs can't do that.
//   · We verify against a fresh anon-key client so the user's existing
//     session JWT isn't replaced or refreshed by the verification call.
//
// Rate limit: failed-attempt counts are recorded in admin_step_up_attempts.
// >10 fails in the last hour → 429 with a cool-down message. Successful
// attempts are also logged but don't count toward the cap.
//
// Auth required + admin status required.
//
// Deploy:
//   supabase functions deploy admin-step-up

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

import { adminCorsHeaders, jsonResponseWithCors, preflightResponseWithCors } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';

const RATE_LIMIT_FAIL_THRESHOLD = 10; // fails per hour before lockout

function structuredLog(event: string, fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), fn: 'admin-step-up', event, ...fields }),
  );
}

Deno.serve(async (req: Request) => {
  const cors = adminCorsHeaders(req.headers.get('Origin'));
  if (req.method === 'OPTIONS') return preflightResponseWithCors(cors);
  const json = (body: unknown, status = 200) => jsonResponseWithCors(body, status, cors);

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req);
  if (!auth) return json({ error: 'Unauthorized' }, 401);

  // Admin gate.
  const { data: isAdmin, error: adminErr } = await auth.client.rpc('is_admin');
  if (adminErr || isAdmin !== true) {
    return json({ error: 'Admin access required' }, 403);
  }

  // Rate limit BEFORE accepting the password — protects against brute-force
  // even if the attacker has a valid admin JWT. Read via service-role client
  // so RLS on admin_step_up_attempts doesn't interfere.
  const { data: failCount } = await auth.client.rpc(
    'admin_step_up_recent_fails',
    { p_user_id: auth.user_id },
  );
  if ((failCount ?? 0) >= RATE_LIMIT_FAIL_THRESHOLD) {
    structuredLog('rate_limit_hit', { admin_id: auth.user_id, fail_count: failCount });
    return json(
      {
        error:
          'Too many failed step-up attempts. Try again in an hour or reach out to a co-admin.',
      },
      429,
    );
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const password = body.password;
  if (!password || typeof password !== 'string') {
    return json({ error: 'password is required' }, 400);
  }

  // Read the user's email from the JWT-backed user record so we verify
  // against the actual account, not a client-supplied email.
  const { data: userResp } = await auth.client.auth.getUser();
  const email = userResp?.user?.email;
  if (!email) {
    return json({ error: 'No email on this account; cannot step up.' }, 400);
  }

  // Verify the password using a FRESH anon-key client. The verification's
  // returned session is discarded — the user's existing browser session is
  // unaffected.
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    return json({ error: 'Server misconfigured' }, 500);
  }
  const verifier = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: verifyErr } = await verifier.auth.signInWithPassword({
    email,
    password,
  });

  // Always log the attempt, success or fail. Service-role client bypasses
  // the RLS that hides this table from authenticated.
  await auth.admin.from('admin_step_up_attempts').insert({
    admin_id: auth.user_id,
    succeeded: !verifyErr,
  });

  if (verifyErr) {
    structuredLog('verify_failed', { admin_id: auth.user_id });
    return json({ error: 'Password did not match' }, 401);
  }

  // Stamp the step-up row using service role (RLS doesn't allow user-scoped
  // writes to admin_step_up; only this function should ever write).
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await auth.admin.from('admin_step_up').upsert({
    admin_id: auth.user_id,
    confirmed_at: nowIso,
  });
  if (upsertErr) {
    structuredLog('upsert_failed', { admin_id: auth.user_id, err: upsertErr.message });
    return json({ error: upsertErr.message }, 500);
  }

  structuredLog('confirmed', { admin_id: auth.user_id });
  return json({
    ok: true,
    valid_until: new Date(Date.now() + 90 * 1000).toISOString(),
    window_seconds: 90,
  });
});
