// AI usage metering — tier-aware claim/finalize/release flow.
//
// Edge functions follow this pattern:
//
//   const claim = await claimOp(user_id, 'recipe_generate', estCents, admin);
//   if (!claim.ok) return jsonResponse({ error: aiCapExceededMessage(claim), ...claim }, 429);
//   try {
//     const chat = await openaiChat(...);
//     await finalizeUsage(claim.claim_id, chat.tokens_in, chat.tokens_out, costCents(...), admin);
//   } catch (err) {
//     await releaseOp(claim.claim_id, admin);
//     throw err;
//   }
//
// claim_ai_op (migration 0020) handles the tier logic:
//   - Pro user: claim against the daily 200¢ fair-use cap (~100 ops/day)
//   - Free user under 5/month: claim from free quota
//   - Free user over 5/month with credits: spend a credit
//   - Free user over 5/month, no credits: deny with reason='free_cap'
//
// releaseOp refunds a credit-source claim if the OpenAI call fails — a
// failed call should never burn a paid op.

// deno-lint-ignore-file no-explicit-any
import { type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export type AiKind =
  | 'recipe_generate'
  | 'url_parse'
  | 'ingredient_normalize'
  | 'pantry_extract'
  | 'paste_import';

export type AiOpSource = 'free_quota' | 'pro' | 'credits';

// Cents per 1M tokens. Pinned snapshots are used by callers; this map keys
// off the family prefix so OpenAI's response model name (e.g.
// "gpt-4o-mini-2024-07-18") still resolves correctly.
const PRICING_PER_MILLION = {
  'gpt-4o-mini': { input: 15, output: 60 },
  'gpt-4o': { input: 250, output: 1000 },
} as const;

function modelKey(model: string): keyof typeof PRICING_PER_MILLION {
  if (model.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (model.startsWith('gpt-4o')) return 'gpt-4o';
  return 'gpt-4o-mini';
}

export function costCents(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING_PER_MILLION[modelKey(model)];
  const cents = (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
  return Math.max(1, Math.ceil(cents));
}

/** Result of claim_ai_op. The successful shape always includes claim_id +
 *  source. The denied shape includes a `reason` and the relevant counters
 *  so the client can show a useful "5 of 5 used" message. */
export type ClaimOpResult =
  | {
      ok: true;
      claim_id: string;
      source: AiOpSource;
      // Only populated on the source-relevant path:
      ops_used_this_month?: number;
      ops_cap_this_month?: number;
      credits_remaining?: number;
      spent_cents_today?: number;
      cap_cents_today?: number;
    }
  | {
      ok: false;
      reason: 'free_cap' | 'pro_fair_use';
      ops_used_this_month?: number;
      ops_cap_this_month?: number;
      credits_remaining?: number;
      spent_cents_today?: number;
      cap_cents_today?: number;
      reset_at?: string;
    };

export async function claimOp(
  user_id: string,
  kind: AiKind,
  estimated_cents: number,
  admin: SupabaseClient,
): Promise<ClaimOpResult> {
  const { data, error } = await admin.rpc('claim_ai_op', {
    p_user_id: user_id,
    p_kind: kind,
    p_estimated_cents: estimated_cents,
  });
  if (error) throw error;
  return data as ClaimOpResult;
}

export async function finalizeUsage(
  claim_id: string,
  tokens_in: number,
  tokens_out: number,
  cost_cents: number,
  admin: SupabaseClient,
): Promise<void> {
  const params = {
    p_claim_id: claim_id,
    p_tokens_in: tokens_in,
    p_tokens_out: tokens_out,
    p_cost_cents: cost_cents,
  };
  // Retry once on transient failure. If both attempts fail, the placeholder
  // row stays at the estimated cost (fail-closed for the cap), and we log
  // loudly so the team can spot persistent telemetry trouble.
  const first = await admin.rpc('finalize_ai_usage', params);
  if (!first.error) return;
  await new Promise((r) => setTimeout(r, 400));
  const second = await admin.rpc('finalize_ai_usage', params);
  if (second.error) {
    console.error(
      'finalize_ai_usage failed twice; placeholder cost stays:',
      second.error.message,
    );
  }
}

/** Refund an unused claim. If the source was 'credits', the credit is
 *  returned to the user's balance — a failed OpenAI call shouldn't burn a
 *  paid op. */
export async function releaseOp(
  claim_id: string,
  admin: SupabaseClient,
): Promise<void> {
  const { error } = await admin.rpc('release_ai_op', { p_claim_id: claim_id });
  if (error) console.error('release_ai_op failed:', error.message);
}

/** Friendly user-facing message for a denied claim. The client also gets
 *  the structured fields back in the JSON so it can show specific UI
 *  (e.g. "Buy a credit pack" CTA) — this string is the fallback display. */
export function aiCapExceededMessage(c: Extract<ClaimOpResult, { ok: false }>): string {
  if (c.reason === 'pro_fair_use') {
    const reset = c.reset_at ? new Date(c.reset_at) : null;
    if (reset) {
      const ms = reset.getTime() - Date.now();
      if (Number.isFinite(ms) && ms > 0) {
        const hours = Math.ceil(ms / 3_600_000);
        return `Daily AI limit reached. Resets in ~${hours}h.`;
      }
    }
    return 'Daily AI limit reached. Try again tomorrow.';
  }

  // free_cap — surface the specific situation
  const used = c.ops_used_this_month ?? 0;
  const cap = c.ops_cap_this_month ?? 5;
  const credits = c.credits_remaining ?? 0;
  if (credits > 0) {
    return `You've used ${used} of ${cap} free AI ops this month. Buy a credit pack to keep going.`;
  }
  return `You've used your ${cap} free AI ops this month. Upgrade to Pantry Pro for unlimited use, or buy a credit pack.`;
}
