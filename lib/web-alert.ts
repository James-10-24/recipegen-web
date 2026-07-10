// Native no-op. React Native's Alert works natively, so there's nothing to
// patch. The web counterpart (web-alert.web.ts) replaces react-native-web's
// no-op Alert.alert with real browser dialogs. Imported for side effects in
// app/_layout.tsx; Metro picks the platform variant.
export {};
