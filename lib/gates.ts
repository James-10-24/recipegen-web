// Subscription-aware friction helpers used at AI call sites and recipe
// creation flows.
//
// requireAiOp(): pre-checks the user's monthly AI quota. If they have
// quota OR credits left, returns true and the caller proceeds. If both
// buckets are empty, opens an editorial Alert that routes to the paywall
// (or to a credit-pack purchase) and returns false. The server-side
// claim_ai_op is the actual gate; this is a UX nicety to avoid a hidden
// 429 round-trip when we already know the answer.
//
// requireRecipeSlot(): pre-checks the recipe-count cap (50 for free).
// Hard block — over the cap routes straight to the paywall. The DB-level
// recipes_insert RLS is the actual enforcement.
//
// Both helpers are React hooks (use the auth + quota queries) so they
// have to be called from a component context. Wrap them with
// useCallback in the call sites for stability.

import { useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useMyAiQuota } from '@/lib/queries/subscription';
import { useRecipesList } from '@/lib/queries/recipes';

export type GateResult = boolean;

// Bumped from 50 to 100 in the pricing grill (see docs/PRICING_DECISIONS.md).
// The cap governs CREATION only — Discover clones (saved_from_id NOT NULL)
// are excluded from the count so saving from the public library doesn't
// punish free users.
const FREE_RECIPE_CAP = 100;

/**
 * Pre-check the AI quota before launching an AI op. Returns true if the
 * caller should proceed; false if the user was presented with a prompt
 * (and either tapped Cancel or accepted a route to the paywall).
 *
 * Pass a short verb describing what will be charged so the prompt's
 * copy can be specific ("Generate recipe", "Import URL", "Snap pantry").
 */
export function useAiOpGate() {
  const router = useRouter();
  const quota = useMyAiQuota();
  const { t } = useTranslation('errors');

  const requireAiOp = async (action: string): Promise<GateResult> => {
    // Not loaded yet — let the server gate. Better to round-trip than to
    // false-block a user who actually has quota.
    if (!quota.data) return true;
    if (quota.data.tier === 'pro') return true;

    const { ops_used_this_month, ops_cap_this_month, credits_remaining } =
      quota.data;
    if (ops_used_this_month < ops_cap_this_month) return true;
    if (credits_remaining > 0) return true;

    // Out of free quota AND credits.
    return await new Promise<GateResult>((resolve) => {
      Alert.alert(
        t('aiCap.alertTitle', { cap: ops_cap_this_month }),
        t('aiCap.alertBody'),
        [
          {
            text: t('aiCap.alertCancel'),
            style: 'cancel',
            onPress: () => resolve(false),
          },
          {
            text: t('aiCap.alertSeeOptions'),
            onPress: () => {
              router.push(`/paywall?reason=ai_cap` as any);
              resolve(false);
            },
          },
        ],
      );
    });
  };

  return { quota: quota.data, requireAiOp };
}

/**
 * Read-only AI quota status — non-imperative variant of useAiOpGate.
 * Returns derived state the caller can render inline (per the AI features
 * grill Q1/Q3 locks: counter near-cap only, inline cap-hit state instead
 * of Alert + paywall navigation).
 *
 * Returns:
 *   · isLoading — initial fetch in flight; render nothing AI-cap-related.
 *   · isPro     — unlimited; no counter, no cap-hit state.
 *   · isCapped  — out of free ops AND credits. Caller renders <AiCapBlock />.
 *   · opsLeft   — free ops remaining this month (0 when capped from free,
 *                 even if credits remain). Used to drive the Q1 near-cap
 *                 annotation (visible when ≤ 2).
 *   · creditsLeft — bonus credits still available. Caller can choose to
 *                 mention them in copy ("3 credits available") or not.
 *   · canRun    — true if the next AI op is permitted (server is still
 *                 the actual gate). Convenience for caller logic.
 *
 * Pair this with useAiOpGate when you want pre-flight blocking on FREE
 * tier; or use this alone and let the server return 429 + the inline
 * cap-block surface handle the friendlier explanation.
 */
export function useAiOpStatus() {
  const quota = useMyAiQuota();
  if (!quota.data) {
    return {
      isLoading: true as const,
      isPro: false,
      isCapped: false,
      opsLeft: 0,
      opsCap: 0,
      creditsLeft: 0,
      canRun: true, // optimistic — server will gate
    };
  }
  if (quota.data.tier === 'pro') {
    return {
      isLoading: false as const,
      isPro: true,
      isCapped: false,
      opsLeft: Infinity,
      opsCap: Infinity,
      creditsLeft: quota.data.credits_remaining,
      canRun: true,
    };
  }
  const { ops_used_this_month, ops_cap_this_month, credits_remaining } =
    quota.data;
  const opsLeft = Math.max(0, ops_cap_this_month - ops_used_this_month);
  const isCapped = opsLeft === 0 && credits_remaining === 0;
  return {
    isLoading: false as const,
    isPro: false,
    isCapped,
    opsLeft,
    opsCap: ops_cap_this_month,
    creditsLeft: credits_remaining,
    canRun: !isCapped,
  };
}

/**
 * Pre-check the recipe count cap. Free users hit the cap at 50;
 * Pro users have no cap. Guests hit it at 10 (handled separately by
 * the existing GUEST_RECIPE_CAP). Returns true if the caller should
 * proceed with showing the New Recipe form / submitting the insert.
 */
export function useRecipeSlotGate() {
  const router = useRouter();
  const quota = useMyAiQuota();
  const list = useRecipesList();
  const { t } = useTranslation('errors');

  const requireRecipeSlot = async (): Promise<GateResult> => {
    if (!quota.data || !list.data) return true; // server is the source of truth
    if (quota.data.tier === 'pro') return true;
    // Count CREATIONS only — Discover clones don't count toward the free
    // cap. "Save unlimited from Discover" is part of the free-tier promise.
    const ownCount = list.data.filter((r) => r.saved_from_id == null).length;
    if (ownCount < FREE_RECIPE_CAP) return true;

    return await new Promise<GateResult>((resolve) => {
      Alert.alert(
        t('recipeCap.alertTitle'),
        t('recipeCap.alertBody', { cap: FREE_RECIPE_CAP }),
        [
          {
            text: t('recipeCap.alertCancel'),
            style: 'cancel',
            onPress: () => resolve(false),
          },
          {
            text: t('recipeCap.alertSeePro'),
            onPress: () => {
              router.push(`/paywall?reason=recipe_cap` as any);
              resolve(false);
            },
          },
        ],
      );
    });
  };

  // Count creations only — matches the cap semantics. Callers using this
  // for display ("X / 100 recipes") should show creations, not the total
  // including clones, so the number aligns with the wall they'll actually
  // hit.
  const count =
    list.data?.filter((r) => r.saved_from_id == null).length ?? 0;
  return { count, requireRecipeSlot };
}
