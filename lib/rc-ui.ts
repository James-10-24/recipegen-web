// Native re-export of react-native-purchases-ui (RevenueCat's prebuilt
// Paywall + Customer Center UI). Consumers import through this wrapper so
// the web build can substitute rc-ui.web.ts and keep the native-only
// package out of the web bundle. Transparent pass-through on iOS/Android.

export { default } from 'react-native-purchases-ui';
export * from 'react-native-purchases-ui';
