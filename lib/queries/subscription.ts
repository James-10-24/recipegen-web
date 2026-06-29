import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Linking } from 'react-native';
import Purchases, {
  CustomerInfo,
  PurchasesPackage,
  PurchasesError,
} from '@/lib/rc';

import { isPurchasesConfigured } from '@/lib/purchases';
import { supabase } from '@/lib/supabase';

/** Mirrors the my_ai_quota RPC return shape (migration 0020). The iOS app
 *  uses this both to render "5 of 5 ops used" copy and to decide whether
 *  to show paywall friction before the user tries an AI action. */
export type AiQuotaPro = {
  tier: 'pro';
  subscription_status: 'pro_monthly' | 'pro_yearly' | 'cancelled';
  expires_at: string | null;
  credits_remaining: number;
};

export type AiQuotaFree = {
  tier: 'free';
  ops_used_this_month: number;
  ops_cap_this_month: number;
  credits_remaining: number;
  reset_at: string;
};

export type AiQuota = AiQuotaPro | AiQuotaFree;

export const subscriptionKeys = {
  quota: ['ai-quota'] as const,
  offerings: ['rc-offerings'] as const,
};

/** Live snapshot of the caller's AI quota. Always invalidate after a
 *  successful purchase or after a successful AI op so the count reflects
 *  reality. */
export function useMyAiQuota() {
  return useQuery({
    queryKey: subscriptionKeys.quota,
    staleTime: 30_000,
    queryFn: async (): Promise<AiQuota> => {
      const { data, error } = await supabase.rpc('my_ai_quota');
      if (error) throw error;
      return data as AiQuota;
    },
  });
}

/** RevenueCat offerings. We expect exactly one offering with two packages:
 *  monthly and annual (or whatever the dashboard configures). The paywall
 *  reads from `current` and renders the available packages.
 *
 *  Returns null when RevenueCat isn't configured (dev env without keys);
 *  the paywall surfaces a friendly "unavailable" message in that case. */
export function useOfferings() {
  return useQuery({
    queryKey: subscriptionKeys.offerings,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (!isPurchasesConfigured()) return null;
      const offerings = await Purchases.getOfferings();
      return offerings.current;
    },
  });
}

/** Buy a subscription or consumable package. RevenueCat handles the Apple
 *  Pay flow; we invalidate ai-quota + profile so the new state reflects.
 *  The webhook also fires server-side and updates profiles independently —
 *  this just speeds up the local refresh. */
export function usePurchasePackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pkg: PurchasesPackage) => {
      if (!isPurchasesConfigured()) {
        throw new Error('Purchases not available — restart the app');
      }
      const result = await Purchases.purchasePackage(pkg);
      return result.customerInfo;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: subscriptionKeys.quota });
    },
  });
}

/** Restore previously-purchased subscriptions. Apple requires this button
 *  on every paywall. */
export function useRestorePurchases() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!isPurchasesConfigured()) {
        throw new Error('Purchases not available — restart the app');
      }
      return await Purchases.restorePurchases();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: subscriptionKeys.quota });
    },
  });
}

/** Classify the outcome of a RevenueCat restorePurchases() call into one
 *  of three branches so the UX can guide the user to the right next step.
 *  Without this, "Nothing to restore" gets shown for THREE distinct cases:
 *  truly-no-purchase / expired-history / purchase-on-different-Apple-ID,
 *  and the user rage-quits when they DID actually pay.
 *
 *  - 'restored'             — entitlements.active has at least one entry;
 *                             show success copy and let the cache refresh.
 *  - 'nothing-on-apple-id'  — entitlements.all is empty; user has truly
 *                             never bought anything on this Apple ID, OR
 *                             they bought on a different Apple ID. Tell
 *                             them to check their Apple ID.
 *  - 'inactive-history'     — entitlements.all has entries but .active
 *                             is empty; subscription expired, or it's
 *                             tied to a different RecipeGen account.
 *                             Tell them to sign in to the right account
 *                             or check subscription status.
 */
export type RestoreOutcome =
  | { kind: 'restored'; activeEntitlements: string[] }
  | { kind: 'nothing-on-apple-id' }
  | { kind: 'inactive-history'; pastEntitlements: string[] };

export function classifyRestoreResult(info: CustomerInfo): RestoreOutcome {
  const activeKeys = Object.keys(info.entitlements?.active ?? {});
  if (activeKeys.length > 0) {
    return { kind: 'restored', activeEntitlements: activeKeys };
  }
  const allKeys = Object.keys(info.entitlements?.all ?? {});
  if (allKeys.length === 0) {
    return { kind: 'nothing-on-apple-id' };
  }
  return { kind: 'inactive-history', pastEntitlements: allKeys };
}

/** Detect user-cancelled purchases so the caller doesn't show an error
 *  toast for a normal "user tapped Cancel" flow. */
export function isUserCancelledPurchaseError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === 'object' &&
    'userCancelled' in err &&
    (err as PurchasesError).userCancelled === true
  );
}

/** Open Apple's Manage Subscription URL — apps must offer a way to reach
 *  it from inside the app. */
export async function openManageSubscription(): Promise<void> {
  await Linking.openURL('https://apps.apple.com/account/subscriptions');
}
