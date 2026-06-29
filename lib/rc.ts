// Native re-export of react-native-purchases.
//
// Consumers import the SDK through this wrapper (not the package directly)
// so the web build can swap in a stub via rc.web.ts without the native
// package ever entering the web bundle graph. On iOS/Android this is a
// transparent pass-through. TypeScript resolves this file (not rc.web.ts)
// for type-checking, so callers keep the real RevenueCat types.

export { default } from 'react-native-purchases';
export * from 'react-native-purchases';
