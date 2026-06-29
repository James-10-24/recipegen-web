import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
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

// Same bridge used by the sign-up confirmation flow — see app/auth/
// callback.tsx + web/auth/callback.html. Supabase routes the recovery
// link through this URL; the bridge bounces into the app's deep-link
// handler which detects type=recovery and lands the user on /auth/reset.
const EMAIL_REDIRECT_URL = 'https://ideagen.tech/auth/callback';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const { isGuest } = useAuth();
  // If the user came here from /sign-in with the email field already
  // filled, pass it through so they don't retype.
  const { email: prefillEmail } = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(prefillEmail ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const { t } = useTranslation('auth');

  // Guests don't have an account to recover. Bounce to /sign-in (which
  // will show the upgrade-from-anon framing if they're mid-guest).
  if (isGuest) {
    return <Redirect href="/sign-in" />;
  }

  const submit = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      Alert.alert(t('forgot.alerts.missingTitle'), t('forgot.alerts.missingBody'));
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo: EMAIL_REDIRECT_URL,
      });
      if (error) {
        Alert.alert(t('forgot.alerts.failedTitle'), error.message);
        return;
      }
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  // Shared centered-column wrapping. ScrollView guards small phones
  // where the keyboard would otherwise crowd out the Submit button.
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
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
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );

  if (sent) {
    return (
      <Wrapper>
        <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
          {t('forgot.sentEyebrow')}
        </Text>
        <Text className="mb-8 font-serif-bold text-4xl">{t('forgot.sentHeadline')}</Text>
        <Text className="mb-8 max-w-[40ch] text-base leading-6 text-gray-600">
          {t('forgot.sentBodyPrefix')}{' '}
          <Text className="text-gray-900">{email.trim()}</Text>
          {t('forgot.sentBodySuffix')}
        </Text>

        <Pressable
          onPress={() => router.replace('/sign-in' as any)}
          className="items-center rounded-lg border border-black bg-white py-3"
        >
          <Text className="text-base font-semibold text-black">
            {t('forgot.sentPrimary')}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setSent(false)}
          hitSlop={6}
          className="mt-3 items-center py-2"
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('forgot.sentRetryLink')}
          </Text>
        </Pressable>
      </Wrapper>
    );
  }

  return (
    <Wrapper>
      <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
        {t('forgot.eyebrow')}
      </Text>
      <Text className="mb-3 font-serif-bold text-4xl">{t('forgot.headline')}</Text>
      <Text className="mb-8 max-w-[40ch] text-base leading-6 text-gray-600">
        {t('forgot.body')}
      </Text>

      <TextInput
        className="mb-4 rounded-lg border border-gray-300 px-4 py-3 text-base"
        placeholder={t('forgot.emailPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        editable={!submitting}
      />

      <Pressable
        onPress={submit}
        disabled={submitting}
        className="mb-3 items-center rounded-lg bg-black py-3"
      >
        {submitting ? (
          <ActivityIndicator color="white" />
        ) : (
          <Text className="text-base font-semibold text-white">
            {t('forgot.submitButton')}
          </Text>
        )}
      </Pressable>

      <Pressable
        onPress={() => router.back()}
        hitSlop={6}
        className="items-center py-2"
      >
        <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('forgot.backLink')}
        </Text>
      </Pressable>
    </Wrapper>
  );
}
