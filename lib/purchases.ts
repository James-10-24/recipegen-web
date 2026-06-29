// RevenueCat lifecycle. Configure once on app boot, then logIn/logOut as
// the Supabase session changes so RevenueCat's app_user_id matches the
// auth.users id we use everywhere else (and that the revenuecat-webhook
// edge function expects).
//
// Public API:
//   configurePurchases() — idempotent, call once at app mount
//   loginPurchases(userId) — call when a real user signs in
//   logoutPurchases() — call when a user signs out
//
// Fails soft when EXPO_PUBLIC_REVENUECAT_APPLE_KEY isn't set (development
// without the key shouldn't crash; the app still works, paywalls show an
// "unavailable" state).

import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import { Platform } from 'react-native';

// Public SDK keys. Production keys from the RevenueCat dashboard start with
// `appl_` (iOS) and `goog_` (Android). The `test_` value below is a
// development fallback so the app stops crashing without keys configured —
// SWAP IT for the real `appl_...` key from RevenueCat → Project Settings →
// Apps → iOS before App Store submission. Env vars in .env.local take
// precedence so the swap doesn't require a code change.
const APPLE_KEY =
  process.env.EXPO_PUBLIC_REVENUECAT_APPLE_KEY ??
  'test_upBBohgLoUZifUIsOHhywLdeYeG';
const ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY;

let configured = false;

/** True if RevenueCat has a real key and is initialized. The paywall and
 *  purchase mutations check this and surface a friendly error when it's
 *  false (e.g. dev environment without keys configured). */
export function isPurchasesConfigured(): boolean {
  return configured;
}

export function configurePurchases(): void {
  if (configured) return;
  const key = Platform.OS === 'ios' ? APPLE_KEY : ANDROID_KEY;
  if (!key) {
    if (__DEV__) {
      console.warn(
        'RevenueCat key missing — set EXPO_PUBLIC_REVENUECAT_APPLE_KEY in .env.local. Purchases are disabled.',
      );
    }
    return;
  }
  if (key.startsWith('test_')) {
    if (__DEV__) {
      console.warn(
        'RevenueCat is configured with a test_ key. Swap to your appl_... key from the RevenueCat dashboard before App Store submission.',
      );
    } else {
      // Production build with a test key. The app would still launch
      // but every purchase would silently fail or return sandbox
      // receipts that don't grant real entitlements. Crash loudly so
      // the misconfig is caught at TestFlight smoke test, not after
      // launch when nobody can charge customers.
      throw new Error(
        'RevenueCat: refusing to launch a production build with a test_ key. ' +
          'Set EXPO_PUBLIC_REVENUECAT_APPLE_KEY in EAS secrets to the appl_... ' +
          'key from the RevenueCat dashboard, then rebuild.',
      );
    }
  }
  try {
    Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN);
    Purchases.configure({ apiKey: key });
    configured = true;
  } catch (e) {
    console.warn('Purchases.configure failed', e);
  }
}

/** Bind a Supabase user id to the RevenueCat session so subsequent purchases
 *  + the webhook can match by app_user_id. Idempotent — calling repeatedly
 *  with the same id is fine. */
export async function loginPurchases(userId: string): Promise<void> {
  if (!configured) configurePurchases();
  if (!configured) return;
  try {
    await Purchases.logIn(userId);
  } catch (e) {
    console.warn('Purchases.logIn failed', e);
  }
}

/** Reset to anonymous app_user_id so the next user's purchases don't
 *  collide. Call on Supabase signOut. */
export async function logoutPurchases(): Promise<void> {
  if (!configured) return;
  try {
    await Purchases.logOut();
  } catch (e) {
    // Calling logOut while already anonymous throws — safe to ignore.
    if (__DEV__) console.warn('Purchases.logOut', e);
  }
}
