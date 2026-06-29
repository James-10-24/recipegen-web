// Web stub for the RevenueCat lifecycle module (lib/purchases.ts).
//
// RevenueCat's IAP SDK is iOS/Android-only — there is no in-browser Apple/
// Google billing, so the PWA cannot run purchases. Every entry point here
// fails soft: the app boots, paywalls render an "unavailable" state, and
// purchase buttons are gated off (see app/paywall.web.tsx).
//
// This does NOT disable Pro for web users who subscribed on mobile: the
// canonical entitlement check is server-side (my_ai_quota / is_pro RPC in
// lib/queries/subscription), which works identically on web.
//
// Metro resolves this file instead of purchases.ts when bundling for web
// (`.web.ts` platform extension). Keep the exported signatures in sync with
// lib/purchases.ts.

/** Always false on web — RevenueCat is never configured in the browser. */
export function isPurchasesConfigured(): boolean {
  return false;
}

export function configurePurchases(): void {
  // no-op on web
}

export async function loginPurchases(_userId: string): Promise<void> {
  // no-op on web
}

export async function logoutPurchases(): Promise<void> {
  // no-op on web
}
