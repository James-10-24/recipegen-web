// Client-side entitlement check, driven by RevenueCat's customerInfo
// listener. Use this for *immediate* UI updates after a purchase
// completes (RC fires the listener as soon as Apple confirms, before the
// webhook → DB → my_ai_quota round-trip lands).
//
// For the *server-truth* check (what the AI edge functions enforce), the
// canonical source is is_pro() / my_ai_quota — see lib/queries/subscription.
// Both should agree once the webhook lands; the entitlement listener just
// makes the UI feel snappy.

import { useEffect, useState } from 'react';
import Purchases, { type CustomerInfo } from '@/lib/rc';

import { isPurchasesConfigured } from '@/lib/purchases';

/** RevenueCat entitlement identifier — must match the entitlement
 *  configured in the RevenueCat dashboard exactly (case + spacing).
 *  All Pro features are gated behind this single entitlement. */
export const PRO_ENTITLEMENT = 'RecipeGen Pro';

/**
 * Subscribe to the caller's RevenueCat entitlement state. Returns:
 *   null      — still loading (or RC unavailable)
 *   true      — entitlement active
 *   false     — entitlement absent
 *
 * The hook re-renders whenever RC fires a customerInfo update, so post-
 * purchase the UI flips from false → true within a frame or two.
 */
export function useIsEntitled(
  entitlementId: string = PRO_ENTITLEMENT,
): boolean | null {
  const [entitled, setEntitled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isPurchasesConfigured()) {
      setEntitled(false);
      return;
    }

    let active = true;
    const handler = (info: CustomerInfo) => {
      if (!active) return;
      const entitlement = info?.entitlements?.active?.[entitlementId];
      setEntitled(!!entitlement);
    };

    // Prime the state from cached customerInfo, then keep it in sync.
    Purchases.getCustomerInfo()
      .then(handler)
      .catch(() => active && setEntitled(false));
    Purchases.addCustomerInfoUpdateListener(handler);

    return () => {
      active = false;
      Purchases.removeCustomerInfoUpdateListener(handler);
    };
  }, [entitlementId]);

  return entitled;
}

/**
 * One-shot non-reactive entitlement check, useful inside event handlers
 * where a hook isn't appropriate (e.g. a tap handler that wants to gate
 * a flow without re-rendering).
 */
export async function isEntitledNow(
  entitlementId: string = PRO_ENTITLEMENT,
): Promise<boolean> {
  if (!isPurchasesConfigured()) return false;
  try {
    const info = await Purchases.getCustomerInfo();
    return !!info?.entitlements?.active?.[entitlementId];
  } catch {
    return false;
  }
}
