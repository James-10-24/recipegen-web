// Web replacement for react-native-web's Alert, which ships as a no-op
// (`static alert() {}`). That no-op is why, on web, informational alerts
// silently vanish and — worse — button-based confirms never fire their
// onPress, so any Promise awaiting a button hangs forever.
//
// This patches Alert.alert once at app boot (imported for side effects in
// app/_layout.tsx) to route through the browser's native dialogs. Every
// existing `Alert.alert(...)` call site across the app then works on web
// with no per-file changes.
//
// Mapping:
//   · 0–1 buttons  → window.alert(); fire the lone button's onPress.
//   · 2+ buttons   → window.confirm(); OK runs the primary action
//     (destructive style, else the last button), Cancel runs the cancel
//     button (cancel style, else the first). 3-button dialogs degrade to
//     this two-way choice — acceptable; they're rare.

import { Alert } from 'react-native';

type WebAlertButton = {
  text?: string;
  onPress?: (value?: string) => void;
  style?: 'default' | 'cancel' | 'destructive';
};

function webAlert(
  title?: string,
  message?: string,
  buttons?: WebAlertButton[],
  _options?: unknown,
): void {
  const body = [title, message].filter(Boolean).join('\n\n');

  if (!buttons || buttons.length <= 1) {
    if (typeof window !== 'undefined') window.alert(body);
    buttons?.[0]?.onPress?.();
    return;
  }

  const cancelBtn =
    buttons.find((b) => b.style === 'cancel') ?? buttons[0];
  const primaryBtn =
    buttons.find((b) => b.style === 'destructive') ??
    [...buttons].reverse().find((b) => b !== cancelBtn) ??
    buttons[buttons.length - 1];

  const ok = typeof window !== 'undefined' ? window.confirm(body) : true;
  if (ok) primaryBtn?.onPress?.();
  else cancelBtn?.onPress?.();
}

// Alert is react-native-web's class with a static no-op `alert`; the static
// is writable, so we override it in place. Cast around the RN type.
(Alert as unknown as { alert: typeof webAlert }).alert = webAlert;

export {};
