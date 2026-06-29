import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';

/**
 * Deep-link handler for Supabase auth confirmation emails.
 *
 * The web bridge at https://ideagen.tech/auth/callback redirects to
 * recipegen://auth/callback?<params>. Here we read those params and
 * either:
 *
 *   · token_hash + type → modern PKCE flow → verifyOtp()
 *   · access_token + refresh_token → legacy fragment flow → setSession()
 *   · error → show alert and route to /sign-in
 *
 * After session is established, AuthProvider's onAuthStateChange fires
 * and downstream gates re-evaluate. We just need to land on a route
 * that's friendly with whatever state we end up in.
 */
type Params = {
  token_hash?: string;
  type?: string; // 'signup' | 'recovery' | 'magiclink' | 'invite' | 'email_change'
  access_token?: string;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

export default function AuthCallbackScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const { markRecoveryActive } = useAuth();
  const handledRef = useRef(false);
  const { t } = useTranslation('auth');

  useEffect(() => {
    // Only run once even if params change due to re-renders.
    if (handledRef.current) return;
    handledRef.current = true;

    const handle = async () => {
      if (params.error) {
        Alert.alert(
          t('callback.alerts.signInFailedTitle'),
          params.error_description ?? params.error ?? t('callback.alerts.signInFailedFallback'),
        );
        router.replace('/sign-in' as any);
        return;
      }

      try {
        if (params.token_hash && params.type) {
          // PKCE / OTP-style verification — modern Supabase email links.
          const { error } = await supabase.auth.verifyOtp({
            token_hash: params.token_hash,
            type: params.type as
              | 'signup'
              | 'recovery'
              | 'invite'
              | 'magiclink'
              | 'email_change'
              | 'email',
          });
          if (error) throw error;
        } else if (params.access_token && params.refresh_token) {
          // Legacy fragment flow — tokens already minted, just install
          // them as the active session.
          const { error } = await supabase.auth.setSession({
            access_token: params.access_token,
            refresh_token: params.refresh_token,
          });
          if (error) throw error;
        } else {
          Alert.alert(
            t('callback.alerts.invalidLinkTitle'),
            t('callback.alerts.invalidLinkBody'),
          );
          router.replace('/sign-in' as any);
          return;
        }
      } catch (e: unknown) {
        const message =
          (e as { message?: string })?.message ?? t('callback.alerts.confirmFailedFallback');
        Alert.alert(t('callback.alerts.confirmFailedTitle'), message);
        router.replace('/sign-in' as any);
        return;
      }

      // Recovery flow goes to the new-password screen instead of the
      // tabs — the user came here specifically to set a password.
      // Sign-up confirmations and email-change confirmations land in
      // (tabs) directly.
      if (params.type === 'recovery') {
        // Set the recovery flag imperatively before navigating, so
        // /auth/reset's gate can't race the PASSWORD_RECOVERY auth
        // event ordering. Belt-and-suspenders alongside the listener
        // in AuthProvider.
        markRecoveryActive();
        router.replace('/auth/reset' as any);
        return;
      }
      router.replace('/(tabs)' as any);
    };

    void handle();
  }, [params, router]);

  return (
    <View className="flex-1 items-center justify-center bg-white">
      <ActivityIndicator size="large" color="#000" />
      <Text className="mt-6 text-[11px] uppercase tracking-[2px] text-gray-500">
        {t('callback.loading')}
      </Text>
    </View>
  );
}
