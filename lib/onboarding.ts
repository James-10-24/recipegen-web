// Onboarding-seen flag, stored in AsyncStorage. Bumping the key suffix
// (v1 → v2) re-triggers onboarding for everyone — useful if we ever
// rewrite the intro and want existing users to see it again.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'recipegen.onboarding.seen.v1';

export async function readOnboardingSeen(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v === '1';
  } catch {
    // If AsyncStorage is unavailable for some reason, fail OPEN — i.e.
    // skip onboarding. Better than blocking the user behind a broken
    // flag check.
    return true;
  }
}

export async function writeOnboardingSeen(seen: boolean): Promise<void> {
  try {
    if (seen) {
      await AsyncStorage.setItem(KEY, '1');
    } else {
      await AsyncStorage.removeItem(KEY);
    }
  } catch {
    // Same reasoning as above — if storage is broken, we don't want to
    // hard-error. The next launch may also skip onboarding.
  }
}
