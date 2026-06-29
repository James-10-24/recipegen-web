import { Redirect, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';

const MIN_LEN = 6;

/**
 * Voluntary password change for an already-signed-in user, reached
 * from Settings.
 *
 * Supabase's updateUser({ password }) doesn't require the current
 * password — but we ask for it anyway as a defense against an attacker
 * who has briefly grabbed an unlocked phone. Verification is via
 * signInWithPassword on the user's own email; if it succeeds the
 * session refreshes, if it fails Supabase returns a 400 and we tell
 * the user.
 *
 * Guests can't change a password they don't have, so we redirect them
 * to /sign-in (the upgrade flow) when they land here.
 */
export default function ChangePasswordScreen() {
  const router = useRouter();
  const { session, loading: authLoading, isGuest } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { t } = useTranslation('auth');

  // All hooks must run on every render in the same order — keep the
  // useEffect above any conditional returns so rules-of-hooks holds.
  // helperText derives from state hooks above, so compute it here.
  const tooShort = next.length > 0 && next.length < MIN_LEN;
  const mismatch = confirm.length > 0 && next !== confirm;
  const sameAsOld = next.length > 0 && next === current;
  const valid =
    current.length > 0 &&
    next.length >= MIN_LEN &&
    next === confirm &&
    next !== current;

  const helperText = tooShort
    ? t('passwordHelper.tooShort', { minLen: MIN_LEN })
    : sameAsOld
      ? t('passwordHelper.sameAsOld')
      : mismatch
        ? t('passwordHelper.mismatch')
        : valid
          ? t('passwordHelper.valid')
          : '';

  // accessibilityLiveRegion is Android-only — fire announceForAccessibility
  // so iOS VoiceOver also reads validation state changes.
  useEffect(() => {
    if (helperText) {
      AccessibilityInfo.announceForAccessibility(helperText);
    }
  }, [helperText]);

  if (!authLoading && !session) {
    return <Redirect href="/sign-in" />;
  }
  if (isGuest) {
    return <Redirect href="/sign-in" />;
  }

  const verifyErrorAlert = (rawMessage: string) => {
    // Supabase doesn't expose typed error codes for this on RN, so we
    // sniff the message string. Branching keeps users out of a "wrong
    // password" loop when they're actually being rate-limited or
    // offline.
    const msg = rawMessage.toLowerCase();
    if (/rate.?limit|too many|429/.test(msg)) {
      Alert.alert(
        t('changePassword.alerts.rateLimitTitle'),
        t('changePassword.alerts.rateLimitBody'),
      );
      return;
    }
    if (/network|fetch|offline|connection/.test(msg)) {
      Alert.alert(
        t('changePassword.alerts.networkTitle'),
        t('changePassword.alerts.networkBody'),
      );
      return;
    }
    if (/invalid login|wrong password|invalid email|invalid credentials/.test(msg)) {
      Alert.alert(
        t('changePassword.alerts.wrongCurrentTitle'),
        t('changePassword.alerts.wrongCurrentBody'),
      );
      return;
    }
    Alert.alert(t('changePassword.alerts.verifyFailedTitle'), rawMessage);
  };

  const submit = async () => {
    if (!valid || submitting) return;
    const email = session?.user?.email;
    if (!email) {
      Alert.alert(
        t('changePassword.alerts.noEmailTitle'),
        t('changePassword.alerts.noEmailBody'),
      );
      return;
    }

    setSubmitting(true);
    try {
      // Verify current password by re-signing in. Supabase refreshes
      // the session on success; on failure it returns a 400. The
      // session is unchanged either way (the user stays signed in).
      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email,
        password: current,
      });
      if (verifyError) {
        verifyErrorAlert(verifyError.message);
        return;
      }

      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) {
        Alert.alert(t('changePassword.alerts.updateFailedTitle'), error.message);
        return;
      }

      // Navigate first, no Alert. router.replace (not back) so the
      // destination is deterministic regardless of how this screen was
      // reached. The query param drives a "✓ Password updated" flash on
      // Settings — without it the user would see no feedback that the
      // change actually went through.
      router.replace({
        pathname: '/settings',
        params: { passwordChanged: '1' },
      } as any);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ padding: 24, paddingTop: 24 }}
        keyboardShouldPersistTaps="handled"
        className="bg-white"
      >
        <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
          {t('changePassword.eyebrow')}
        </Text>
        <Text className="mb-3 font-serif-bold text-3xl">
          {t('changePassword.headline')}
        </Text>
        <Text className="mb-8 max-w-[40ch] text-base leading-6 text-gray-600">
          {t('changePassword.body', { minLen: MIN_LEN })}
        </Text>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('changePassword.currentLabel')}
        </Text>
        <TextInput
          className="mb-5 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('changePassword.currentPlaceholder')}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={current}
          onChangeText={setCurrent}
          editable={!submitting}
        />

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('changePassword.newLabel')}
        </Text>
        <TextInput
          className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('changePassword.newPlaceholder', { minLen: MIN_LEN })}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={next}
          onChangeText={setNext}
          editable={!submitting}
        />
        <TextInput
          className="mb-2 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('changePassword.confirmPlaceholder')}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={confirm}
          onChangeText={setConfirm}
          editable={!submitting}
        />
        <Text
          accessibilityLiveRegion="polite"
          accessibilityLabel={helperText || t('passwordHelper.ariaPrompt')}
          className={`mb-6 text-[10px] uppercase tracking-[2px] ${
            mismatch || tooShort || sameAsOld ? 'text-red-600' : 'text-gray-500'
          }`}
        >
          {helperText || ' '}
        </Text>

        <Pressable
          onPress={submit}
          disabled={!valid || submitting}
          className={`mb-3 items-center rounded-lg py-3 ${
            valid && !submitting ? 'bg-black' : 'bg-gray-300'
          }`}
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-base font-semibold text-white">
              {t('changePassword.submitButton')}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
