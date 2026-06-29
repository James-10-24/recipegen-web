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
 * Lands here after the recovery email link, via /auth/callback. The
 * recovery flow signs the user in with a one-time recovery session; we
 * use that session to call updateUser({ password }) and set a new one.
 *
 * Two gates protect this screen:
 *
 *   · session must exist (otherwise → /sign-in)
 *   · recoveryActive must be true (otherwise → /(tabs))
 *
 * `recoveryActive` is set in AuthContext when Supabase fires the
 * PASSWORD_RECOVERY auth event — i.e., the user just verified a
 * recovery email. Without this gate, a normally-signed-in user could
 * navigate directly to /auth/reset and change their password without
 * entering the current one. That'd be a privilege escalation versus
 * /auth/change-password.
 */
export default function ResetPasswordScreen() {
  const router = useRouter();
  const {
    session,
    loading: authLoading,
    recoveryActive,
    clearRecovery,
    markOnboardingSeen,
  } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { t } = useTranslation('auth');

  // All hooks must run on every render in the same order — keep the
  // useEffect above the conditional Redirect returns so rules-of-hooks
  // holds. helperText derives from the state hooks above; computed here.
  //
  // Don't trim — leading/trailing whitespace is part of the password.
  const tooShort = password.length > 0 && password.length < MIN_LEN;
  const mismatch = confirm.length > 0 && password !== confirm;
  const valid = password.length >= MIN_LEN && password === confirm;

  const helperText = tooShort
    ? t('passwordHelper.tooShort', { minLen: MIN_LEN })
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
  // Only the recovery flow may pass through this screen. A normal
  // signed-in user trying to change their password belongs in
  // /auth/change-password (which requires the current password).
  if (!authLoading && session && !recoveryActive) {
    return <Redirect href="/(tabs)" />;
  }

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        Alert.alert(t('reset.alerts.updateFailedTitle'), error.message);
        return;
      }
      // Recovery cycle is done — clear the flag so re-visiting the
      // screen later won't bypass change-password's verification.
      clearRecovery();
      // The user clearly used the app before (they have an account); if
      // this is a fresh install, skip past onboarding on next launch.
      await markOnboardingSeen();
      // Navigate immediately. Skipping the success Alert avoids the
      // Android edge case where dismissing the dialog (back button)
      // would never fire the onPress and strand the user here.
      router.replace('/(tabs)' as any);
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
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        keyboardShouldPersistTaps="handled"
        className="bg-white"
      >
        <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
          {t('reset.eyebrow')}
        </Text>
        <Text className="mb-3 font-serif-bold text-4xl">{t('reset.headline')}</Text>
        <Text className="mb-8 max-w-[40ch] text-base leading-6 text-gray-600">
          {t('reset.body', { minLen: MIN_LEN })}
        </Text>

        <TextInput
          className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('reset.newPlaceholder')}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          value={password}
          onChangeText={setPassword}
          editable={!submitting}
        />
        <TextInput
          className="mb-2 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('reset.confirmPlaceholder')}
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
            mismatch || tooShort ? 'text-red-600' : 'text-gray-500'
          }`}
        >
          {helperText || ' '}
        </Text>

        <Pressable
          onPress={submit}
          disabled={!valid || submitting}
          className={`items-center rounded-lg py-3 ${
            valid && !submitting ? 'bg-black' : 'bg-gray-300'
          }`}
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-base font-semibold text-white">
              {t('reset.submitButton')}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
