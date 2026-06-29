// Supabase Edge Function: revenuecat-webhook
//
// Receives subscription + consumable events from RevenueCat and updates the
// user's profile to match. The iOS app's source of truth on subscription
// status is the profiles row — keeping this in sync is what makes
// is_pro() and claim_ai_op work.
//
// Handled events:
//   INITIAL_PURCHASE      first paid sub
//   TRIAL_STARTED         intro free-trial period began — Pro entitlement active
//   TRIAL_CONVERTED       trial ended successfully — first paid period begins
//   TRIAL_CANCELLED       user cancelled during trial — access until expires_at
//   RENEWAL               successful renewal at end of period
//   PRODUCT_CHANGE        switched between monthly / yearly
//   UNCANCELLATION        user resubscribed after cancelling within period
//   CANCELLATION          user cancelled — access until expires_at
//   EXPIRATION            access lost (after grace if billing_issue)
//   BILLING_ISSUE         payment failed; in grace
//   NON_RENEWING_PURCHASE consumable (credit pack) — grants ops
//   SUBSCRIBER_ALIAS      not used (we always use auth.uid())
//   TEST                  dashboard test pings — ack and ignore
//
// Auth: a shared secret in the Authorization header. Set
//   supabase secrets set REVENUECAT_WEBHOOK_AUTH=<random-string>
// then paste the same value into RevenueCat dashboard → Project →
// Integrations → Webhooks → Authorization header.
//
// Deploy:
//   supabase functions deploy revenuecat-webhook --no-verify-jwt
//
// (--no-verify-jwt because RevenueCat doesn't send a Supabase JWT; we do
// our own auth via the shared secret above.)

// deno-lint-ignore-file no-explicit-any
import {
  createClient,
  type SupabaseClient,
} from 'https://esm.sh/@supabase/supabase-js@2.45.4';

import { jsonResponse, preflightResponse } from '../_shared/cors.ts';

// Map App Store product identifiers → subscription status / credit grant.
// Keep in lockstep with App Store Connect product IDs and RevenueCat's
// product config. Product IDs are the literal identifiers configured in
// App Store Connect (case-sensitive), NOT the RevenueCat package
// identifiers (`$rc_monthly` etc — those are package types, separate).
const PRODUCT_TO_STATUS: Record<string, 'pro_monthly' | 'pro_yearly'> = {
  monthly: 'pro_monthly',
  yearly: 'pro_yearly',
};

const CREDIT_PACKS: Record<string, number> = {
  consumable: 10,
};

type RcEvent = {
  type: string;
  id?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  product_id?: string;
  expiration_at_ms?: number | null;
  purchased_at_ms?: number;
  store?: string;
  transaction_id?: string;
  // CANCELLATION events tell us if the user cancelled but still has time
  // remaining; we treat that as 'cancelled' status with expires_at set.
  cancel_reason?: string;
  is_trial_period?: boolean;
};

type RcWebhookPayload = {
  api_version: string;
  event: RcEvent;
};

function structuredLog(event: string, fields: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'revenuecat-webhook',
      event,
      ...fields,
    }),
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  // Shared-secret auth. RevenueCat lets you set an Authorization header
  // value in the dashboard; we compare it constant-time-ish to our env var.
  const secret = Deno.env.get('REVENUECAT_WEBHOOK_AUTH');
  if (!secret) {
    structuredLog('misconfigured', { detail: 'REVENUECAT_WEBHOOK_AUTH not set' });
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }
  const auth = req.headers.get('Authorization') ?? '';
  // Accept either "Bearer <secret>" or the bare secret (RevenueCat lets
  // you put either in the dashboard).
  const expected1 = `Bearer ${secret}`;
  if (auth !== expected1 && auth !== secret) {
    structuredLog('auth_failed', {});
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let payload: RcWebhookPayload;
  try {
    payload = (await req.json()) as RcWebhookPayload;
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  const ev = payload.event;
  if (!ev || !ev.type) {
    return jsonResponse({ error: 'Missing event' }, 400);
  }

  // Test pings from the dashboard — just ack.
  if (ev.type === 'TEST') {
    structuredLog('test_ping', {});
    return jsonResponse({ ok: true, ack: 'test' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRole) {
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }
  const admin: SupabaseClient = createClient(supabaseUrl, serviceRole);

  const userId = ev.app_user_id;
  if (!userId) {
    structuredLog('no_user_id', { type: ev.type, id: ev.id });
    return jsonResponse({ ok: true, skipped: 'no_user_id' });
  }

  // Verify the user exists. RevenueCat may send events for a user we've
  // since deleted — log and skip, don't error.
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (!profile) {
    structuredLog('profile_not_found', { user_id: userId, type: ev.type });
    return jsonResponse({ ok: true, skipped: 'profile_not_found' });
  }

  // ─── Consumable: credit pack ─────────────────────────────────────────
  if (ev.type === 'NON_RENEWING_PURCHASE') {
    const productId = ev.product_id ?? '';
    const ops = CREDIT_PACKS[productId];
    if (!ops) {
      structuredLog('unknown_credit_pack', { product_id: productId });
      return jsonResponse({ ok: true, skipped: 'unknown_credit_pack' });
    }
    const txId = ev.transaction_id ?? `${ev.id}-${ev.purchased_at_ms}`;
    const { data: granted, error } = await admin.rpc(
      'record_credit_pack_purchase',
      {
        p_user_id: userId,
        p_store_transaction_id: txId,
        p_ops_granted: ops,
        p_product_id: productId,
      },
    );
    if (error) {
      structuredLog('credit_pack_failed', {
        user_id: userId,
        err: error.message,
      });
      return jsonResponse({ error: error.message }, 500);
    }
    structuredLog('credit_pack_granted', {
      user_id: userId,
      product_id: productId,
      ops_granted: granted,
      tx_id: txId,
    });
    return jsonResponse({ ok: true, granted });
  }

  // ─── Subscription state ──────────────────────────────────────────────
  const productStatus = PRODUCT_TO_STATUS[ev.product_id ?? ''];
  const expiresAt = ev.expiration_at_ms
    ? new Date(ev.expiration_at_ms).toISOString()
    : null;

  let nextStatus: 'free' | 'pro_monthly' | 'pro_yearly' | 'cancelled' = 'free';
  let willRenew = false;

  switch (ev.type) {
    case 'INITIAL_PURCHASE':
    case 'TRIAL_STARTED':
    case 'RENEWAL':
    case 'TRIAL_CONVERTED':
    case 'PRODUCT_CHANGE':
    case 'UNCANCELLATION':
      // Active subscription. Pro entitlement is live for all of these:
      //   · INITIAL_PURCHASE / RENEWAL — paid period running
      //   · TRIAL_STARTED — intro free trial just began; Pro features active
      //     immediately (Apple grants entitlement at trial start)
      //   · TRIAL_CONVERTED — trial ended successfully, first paid period
      //     begins; functionally equivalent to RENEWAL
      //   · PRODUCT_CHANGE — switched plan tier; still Pro
      //   · UNCANCELLATION — user re-enabled auto-renew before expiry
      // willRenew = true unless the event was explicitly a cancellation.
      // is_trial_period on the event tells us whether the current period is
      // a trial; we don't currently surface that in the profile but
      // expires_at lets the UI compute "trial ends X" copy if needed.
      nextStatus = productStatus ?? 'free';
      willRenew = true;
      break;

    case 'CANCELLATION':
    case 'TRIAL_CANCELLED':
      // User cancelled; access continues until expiration_at_ms (either
      // end of paid period, or end of trial). Mark as 'cancelled' so we
      // know not to advertise renewal copy in Settings.
      // is_pro() still returns true while expires_at is in the future.
      // TRIAL_CANCELLED is the cancel-during-trial variant — same downstream
      // semantics, RC fires this instead of CANCELLATION when the user
      // is still inside their intro free trial.
      nextStatus = 'cancelled';
      willRenew = false;
      break;

    case 'BILLING_ISSUE':
      // In grace period — keep current status (don't downgrade), but flag
      // willRenew=false so the UI can warn. Without a current-status read
      // we conservatively keep the productStatus active.
      nextStatus = productStatus ?? 'cancelled';
      willRenew = false;
      break;

    case 'EXPIRATION':
      // Access lost. Drop to free.
      nextStatus = 'free';
      willRenew = false;
      break;

    case 'SUBSCRIBER_ALIAS':
      // We always use auth.uid() as app_user_id, so aliases shouldn't
      // happen. Log and skip.
      structuredLog('alias_event_skipped', { user_id: userId });
      return jsonResponse({ ok: true, skipped: 'alias' });

    default:
      structuredLog('unhandled_event', { type: ev.type });
      return jsonResponse({ ok: true, skipped: 'unhandled' });
  }

  const { error: applyErr } = await admin.rpc('apply_subscription_state', {
    p_user_id: userId,
    p_status: nextStatus,
    p_expires_at: expiresAt,
    p_will_renew: willRenew,
    p_revenuecat_app_user_id: ev.original_app_user_id ?? userId,
  });
  if (applyErr) {
    structuredLog('apply_failed', {
      user_id: userId,
      type: ev.type,
      err: applyErr.message,
    });
    return jsonResponse({ error: applyErr.message }, 500);
  }

  structuredLog('applied', {
    user_id: userId,
    type: ev.type,
    status: nextStatus,
    expires_at: expiresAt,
    will_renew: willRenew,
  });
  return jsonResponse({ ok: true, status: nextStatus });
});
