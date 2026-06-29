// Web stub for react-native-purchases (see rc.ts for the native side).
//
// RevenueCat's native billing SDK does not run in a browser. This stub
// satisfies the imports in lib/entitlements.ts and lib/queries/subscription
// so the web bundle builds. Read methods resolve to "no entitlements";
// write methods (purchase/restore) reject — but those code paths are gated
// behind isPurchasesConfigured() (always false on web), so they are never
// reached at runtime.

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('Purchases are not available on web'));

const Purchases = {
  getCustomerInfo: () =>
    Promise.resolve({ entitlements: { active: {}, all: {} } } as any),
  addCustomerInfoUpdateListener: (_handler: (info: any) => void) => {},
  removeCustomerInfoUpdateListener: (_handler: (info: any) => void) => {},
  getOfferings: () => Promise.resolve({ current: null } as any),
  purchasePackage: unavailable,
  restorePurchases: unavailable,
  logIn: () => Promise.resolve(),
  logOut: () => Promise.resolve(),
  configure: (_opts: any) => {},
  setLogLevel: (_level: any) => {},
};

export default Purchases;

// Type stubs — the real types come from rc.ts during type-checking; these
// keep rc.web.ts self-consistent if it is ever checked in isolation.
export type CustomerInfo = any;
export type PurchasesPackage = any;
export type PurchasesError = any;
export type PurchasesOffering = any;
export const LOG_LEVEL = { DEBUG: 'DEBUG', WARN: 'WARN' } as any;
