// Web stub for react-native-purchases-ui (see rc-ui.ts for native).
//
// RevenueCat's prebuilt Paywall / Customer Center are native modules with
// no web implementation. On web the dedicated app/paywall.web.tsx renders
// instead, and settings gates its "Manage subscription" action behind
// isPurchasesConfigured() (false on web), so these members are never
// invoked — the stub only needs to satisfy the imports.

const RevenueCatUI = {
  Paywall: (_props: any) => null,
  presentPaywall: () => Promise.resolve(),
  presentCustomerCenter: () => Promise.resolve(),
};

export default RevenueCatUI;
