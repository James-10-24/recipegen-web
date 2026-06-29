import { useQuery } from '@tanstack/react-query';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Redirect, useRouter } from 'expo-router';
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
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/lib/auth-context';
import {
  classifyRestoreResult,
  useRestorePurchases,
} from '@/lib/queries/subscription';
import { supabase } from '@/lib/supabase';

/**
 * Three-row count of the guest's content. Drives the detect-and-branch UI:
 * if total > 0, we show the two-explicit-choice card instead of forcing
 * sign-up mode (the previous default). Lightweight enough to run on
 * every sign-in screen mount; counts use head:true so no rows transfer.
 */
function useGuestContentSummary(enabled: boolean) {
  return useQuery({
    queryKey: ['guest-content-summary'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const [recipesRes, pantryRes, plansRes] = await Promise.all([
        supabase.from('recipes').select('id', { count: 'exact', head: true }),
        supabase.from('pantry_items').select('id', { count: 'exact', head: true }),
        supabase.from('meal_plans').select('id', { count: 'exact', head: true }),
      ]);
      return {
        recipes: recipesRes.count ?? 0,
        pantryItems: pantryRes.count ?? 0,
        mealPlans: plansRes.count ?? 0,
      };
    },
  });
}

// Sign in with Apple is offered as an equivalent option to email/password.
// Requires (all of these must be true):
//   - usesAppleSignIn: true on the iOS config in app.json
//   - "expo-apple-authentication" in the plugins array in app.json
//   - Sign in with Apple capability enabled in the Apple Developer portal
//     for this bundle ID
//   - Supabase Auth → Providers → Apple enabled with the matching Service
//     ID, Team ID, Key ID, and the private .p8 key contents
// Disabled automatically on Android (Platform.OS !== 'ios') and on the
// guest-upgrade path (signInWithIdToken creates a different user_id than
// the guest's, which would silently discard the guest's data).
const APPLE_SIGN_IN_ENABLED = true;

// Auth confirmation emails redirect here. The web page at this URL is a
// thin bridge that bounces the user into the app via the recipegen://
// scheme. Source: web/auth/callback.html. The URL must also be in the
// Supabase project's allowlist (Authentication → URL Configuration →
// Additional redirect URLs).
const EMAIL_REDIRECT_URL = 'https://ideagen.tech/auth/callback';

export default function SignInScreen() {
  const { session, loading: authLoading, onboardingSeen, isGuest } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [submitting, setSubmitting] = useState(false);
  // Guest branching state. null = show the two-explicit-choice prompt
  // (rendered below when guest has content). 'save' = preserve guest
  // data via updateUser. 'abandon' = sign into a different account,
  // guest content is orphaned. Reset every screen mount.
  const [guestChoice, setGuestChoice] = useState<'save' | 'abandon' | null>(null);
  const restore = useRestorePurchases();
  const guestContent = useGuestContentSummary(isGuest);
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');
  const hasGuestContent =
    isGuest &&
    !!guestContent.data &&
    guestContent.data.recipes +
      guestContent.data.pantryItems +
      guestContent.data.mealPlans >
      0;
  const showGuestBranchPrompt = hasGuestContent && guestChoice === null;
  // When sign-up or upgrade succeeds but Supabase requires the user to
  // confirm a new email, the call returns without an active session.
  // We capture the email and show a "Check your inbox" state instead of
  // leaving the user staring at the form.
  const [confirmEmailSent, setConfirmEmailSent] = useState<{
    email: string;
    kind: 'sign-up' | 'email-change';
  } | null>(null);

  if (authLoading || onboardingSeen === null) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }
  // First-launch users see the intro before the sign-in form.
  if (!onboardingSeen) return <Redirect href="/onboarding" />;
  // Real (non-anonymous) sessions skip past this screen. Anonymous sessions
  // can still reach it — that's the upgrade path from Settings.
  if (session && !isGuest) return <Redirect href="/" />;

  // Branching:
  //   - Guest with content who chose 'save' → isUpgrading: force sign-up
  //     mode, use auth.updateUser, preserve user_id + all guest data.
  //   - Guest with content who chose 'abandon' → regular sign-in form,
  //     can sign into existing account; guest content gets orphaned.
  //   - Guest WITHOUT content → no branching needed; treat as regular
  //     user from form-behavior POV (they can sign in or sign up freely).
  //   - Non-guest → regular form.
  // When showGuestBranchPrompt is true, we render the choice card and
  // none of the form below matters yet.
  const isUpgrading = isGuest && guestChoice === 'save';
  const effectiveMode = isUpgrading ? 'sign-up' : mode;

  const submit = async () => {
    if (!email || !password) {
      Alert.alert(t('alerts.missingInfoTitle'), t('alerts.missingInfoBody'));
      return;
    }
    setSubmitting(true);
    try {
      if (isUpgrading) {
        // Anonymous → real: same user_id, all recipes/pantry/plans persist.
        // updateUser triggers an email change confirmation when
        // double_confirm_changes is on; emailRedirectTo lands the user
        // on our bridge page after they click the link.
        const { data, error } = await supabase.auth.updateUser(
          { email, password },
          { emailRedirectTo: EMAIL_REDIRECT_URL },
        );
        if (error) {
          handleAuthError(error.message, true);
          return;
        }
        // If `new_email` is set on the returned user, Supabase is
        // waiting for a confirmation click — show the inbox state.
        // Otherwise the email was applied immediately (e.g. the project
        // has double_confirm_changes off) and we can land them in
        // (tabs) right away. Either path preserves the existing
        // user_id and all guest data.
        if (data.user?.new_email) {
          setConfirmEmailSent({ email, kind: 'email-change' });
        } else {
          router.replace('/(tabs)' as any);
        }
        return;
      }
      if (effectiveMode === 'sign-in') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) handleAuthError(error.message, false);
        return;
      }
      // signUp: triggers a confirmation email when enable_confirmations
      // is on. data.session is null in that case until they click the
      // link; show the inbox state so they don't think it failed.
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: EMAIL_REDIRECT_URL },
      });
      if (error) {
        handleAuthError(error.message, false);
        return;
      }
      if (!data.session) {
        setConfirmEmailSent({ email, kind: 'sign-up' });
      }
      // If session is non-null, AuthProvider handles the redirect.
    } finally {
      setSubmitting(false);
    }
  };

  const handleAuthError = (message: string, isUpgradePath: boolean) => {
    // Friendlier copy on the most common upgrade-time error: the email
    // is already attached to a different account. Tell the user what
    // happens to their guest data if they switch.
    const isEmailTaken = /email.*(already|exists|registered|in use)/i.test(message);
    if (isUpgradePath && isEmailTaken) {
      Alert.alert(t('alerts.emailTakenTitle'), t('alerts.emailTakenBody'));
      return;
    }
    Alert.alert(t('alerts.authErrorTitle'), message);
  };

  const continueAsGuest = async () => {
    setSubmitting(true);
    try {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) Alert.alert(t('alerts.guestStartFailedTitle'), error.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Restore from this screen (before sign-in) lets a returning customer
  // restore their subscription without first remembering their password.
  // Purchases.restorePurchases() runs against an anonymous RevenueCat
  // app_user_id; on successful sign-in afterward, loginPurchases() moves
  // the entitlement to the real Supabase user_id (provided RevenueCat's
  // transferBehavior is 'transfer', the default).
  const handleRestore = async () => {
    try {
      const info = await restore.mutateAsync();
      const outcome = classifyRestoreResult(info);
      switch (outcome.kind) {
        case 'restored':
          Alert.alert(t('alerts.restoreSuccessTitle'), t('alerts.restoreSuccessBody'));
          break;
        case 'nothing-on-apple-id':
          Alert.alert(t('alerts.restoreNothingTitle'), t('alerts.restoreNothingBody'));
          break;
        case 'inactive-history':
          Alert.alert(t('alerts.restoreInactiveTitle'), t('alerts.restoreInactiveBody'));
          break;
      }
    } catch (e: any) {
      Alert.alert(
        t('alerts.restoreFailedTitle'),
        e?.message ?? t('alerts.restoreFailedFallback'),
      );
    }
  };

  const signInWithApple = async () => {
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) {
        Alert.alert(t('alerts.appleSignInTitle'), t('alerts.appleNoTokenBody'));
        return;
      }
      // Lock the form during the Supabase exchange so a frantic double-tap
      // doesn't kick off two parallel signInWithIdToken calls. The
      // AuthProvider's onAuthStateChange will redirect on success — the
      // screen unmounts before we'd ever need to reset submitting.
      setSubmitting(true);
      const { error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
      });
      if (error) {
        setSubmitting(false);
        Alert.alert(t('alerts.authErrorTitle'), error.message);
      }
      // Apple may have returned a private relay address (...@privaterelay.
      // appleid.com) — Supabase stores that as the user's email. On
      // subsequent sign-ins Apple may omit the email entirely; Supabase
      // identifies the user by the Apple `sub` claim regardless, so we
      // don't need to do anything special here.
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      // User dismissed the native sheet — no error, no alert.
      if (e.code === 'ERR_REQUEST_CANCELED') return;
      Alert.alert(t('alerts.appleFailedTitle'), e.message ?? t('alerts.appleFailedFallback'));
    }
  };

  // ───── Guest branch-prompt: "save my data" vs "sign in to existing" ─────
  if (showGuestBranchPrompt && guestContent.data) {
    const c = guestContent.data;
    const parts = [
      c.recipes > 0 && t('guestBranch.summary.recipe', { count: c.recipes }),
      c.pantryItems > 0 &&
        t('guestBranch.summary.pantryItem', { count: c.pantryItems }),
      c.mealPlans > 0 && t('guestBranch.summary.mealPlan', { count: c.mealPlans }),
    ].filter(Boolean) as string[];
    const summary = parts.join(' · ');

    const handleAbandon = () => {
      Alert.alert(
        t('guestBranch.deleteAlertTitle'),
        t('guestBranch.deleteAlertBody', { summary }),
        [
          { text: tCommon('cancel'), style: 'cancel' },
          {
            text: t('guestBranch.deleteAlertConfirm'),
            style: 'destructive',
            onPress: async () => {
              setSubmitting(true);
              try {
                // RLS scopes these deletes to the current (anon) user.
                // The account they're about to sign into is untouched.
                // Sentinel filter (created_at >= 1900-01-01) acts as a
                // delete-all-my-rows since PostgREST requires a filter.
                // Recipes deletion is the most important — public ones
                // would otherwise stay visible in Discover after the
                // guest abandons the session.
                await Promise.all([
                  supabase
                    .from('recipes')
                    .delete()
                    .gte('created_at', '1900-01-01'),
                  supabase
                    .from('pantry_items')
                    .delete()
                    .gte('created_at', '1900-01-01'),
                  supabase
                    .from('meal_plans')
                    .delete()
                    .gte('created_at', '1900-01-01'),
                ]);
                setGuestChoice('abandon');
              } catch (e: any) {
                Alert.alert(
                  t('guestBranch.deleteErrorTitle'),
                  e?.message ?? t('guestBranch.deleteErrorBody'),
                );
              } finally {
                setSubmitting(false);
              }
            },
          },
        ],
      );
    };

    return (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-1 justify-center bg-white px-6">
          <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {t('guestBranch.eyebrow')}
          </Text>
          <Text className="mb-2 font-serif-bold text-4xl">
            {t('guestBranch.headline')}
          </Text>
          <Text className="mb-8 max-w-[40ch] text-base leading-6 text-gray-600">
            {t('guestBranch.intro', { summary })}
          </Text>

          <Pressable
            onPress={() => setGuestChoice('save')}
            disabled={submitting}
            className="mb-3 rounded-lg bg-black px-4 py-4"
          >
            <Text className="text-base font-semibold text-white">
              {t('guestBranch.saveTitle')}
            </Text>
            <Text className="mt-1 text-xs text-gray-300">
              {t('guestBranch.saveBody')}
            </Text>
          </Pressable>

          <Pressable
            onPress={handleAbandon}
            disabled={submitting}
            className="mb-8 rounded-lg border border-gray-300 bg-white px-4 py-4"
          >
            {submitting ? (
              <ActivityIndicator />
            ) : (
              <>
                <Text className="text-base font-semibold text-black">
                  {t('guestBranch.abandonTitle')}
                </Text>
                <Text className="mt-1 text-xs text-gray-500">
                  {t('guestBranch.abandonBody')}
                </Text>
              </>
            )}
          </Pressable>

          <Pressable
            onPress={() => router.replace('/(tabs)' as any)}
            hitSlop={6}
            className="items-center py-2"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('keepUsingAsGuest')}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ───── Confirm-email-sent state ─────
  if (confirmEmailSent) {
    const isUpgrade = confirmEmailSent.kind === 'email-change';
    return (
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View className="flex-1 justify-center bg-white px-6">
          <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {t('confirmEmail.eyebrow')}
          </Text>
          <Text className="mb-8 font-serif-bold text-4xl">
            {isUpgrade
              ? t('confirmEmail.headlineUpgrade')
              : t('confirmEmail.headlineSignUp')}
          </Text>
          <Text className="mb-8 max-w-[40ch] text-base leading-6 text-gray-600">
            {t('confirmEmail.bodyPrefix')}{' '}
            <Text className="text-gray-900">{confirmEmailSent.email}</Text>
            {isUpgrade
              ? t('confirmEmail.bodySuffixUpgrade')
              : t('confirmEmail.bodySuffixSignUp')}
          </Text>

          <Pressable
            onPress={() => {
              setConfirmEmailSent(null);
              if (isUpgrade) router.replace('/(tabs)' as any);
            }}
            className="items-center rounded-lg border border-black bg-white py-3"
          >
            <Text className="text-base font-semibold text-black">
              {isUpgrade
                ? t('confirmEmail.primaryUpgrade')
                : t('confirmEmail.primarySignUp')}
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setConfirmEmailSent(null)}
            hitSlop={6}
            className="mt-3 items-center py-2"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('confirmEmail.differentEmailLink')}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ───── Form state ─────
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24 }}
        keyboardShouldPersistTaps="handled"
        className="bg-white"
      >
        {isUpgrading ? (
          <>
            <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
              {t('upgrade.eyebrow')}
            </Text>
            <Text className="mb-2 font-serif-bold text-4xl">
              {t('upgrade.headline')}
            </Text>
            <Text className="mb-8 max-w-[36ch] text-base text-gray-600">
              {t('upgrade.body')}
            </Text>
          </>
        ) : (
          <>
            {/* True italic font (Fraunces_700Bold_Italic) instead of
                synthesized italic — looks meaningfully better on the
                hero brand mark, especially on Android. */}
            <Text className="mb-2 font-serif-bold-italic text-4xl text-terracotta-600">
              {t('brandMark')}
            </Text>
            <Text className="mb-8 text-base text-gray-500">
              {t('tagline')}
            </Text>
          </>
        )}

        {/* Sign in with Apple — placed above the email form per Apple HIG
            (equal-or-higher prominence than other sign-in methods).
            Hidden on the upgrade path because signInWithIdToken creates
            a different user_id than the guest's; that branching is
            handled separately by the detect-and-branch UX. */}
        {APPLE_SIGN_IN_ENABLED && Platform.OS === 'ios' && !isUpgrading && (
          <>
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={
                effectiveMode === 'sign-in'
                  ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
                  : AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
              }
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={8}
              style={{ height: 48, marginBottom: 12 }}
              onPress={signInWithApple}
            />
            <View className="my-2 flex-row items-center gap-3">
              <View className="h-px flex-1 bg-gray-200" />
              <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
                {t('form.orEmail')}
              </Text>
              <View className="h-px flex-1 bg-gray-200" />
            </View>
          </>
        )}

        <TextInput
          className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('form.emailPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          editable={!submitting}
        />
        <TextInput
          className="mb-2 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('form.passwordPlaceholder')}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          editable={!submitting}
        />

        {/* Always rendered so the row's footprint is identical across
            modes. Hidden via opacity (visible) + pointerEvents (tappable)
            when not in plain sign-in mode. Guarantees zero layout shift
            when toggling sign-in / sign-up / upgrade. */}
        <Pressable
          onPress={() => {
            if (isUpgrading || effectiveMode !== 'sign-in') return;
            router.push({
              pathname: '/auth/forgot-password',
              params: email ? { email } : undefined,
            } as any);
          }}
          hitSlop={6}
          className={`mb-4 self-end ${
            !isUpgrading && effectiveMode === 'sign-in' ? '' : 'opacity-0'
          }`}
          pointerEvents={
            !isUpgrading && effectiveMode === 'sign-in' ? 'auto' : 'none'
          }
          accessibilityElementsHidden={
            isUpgrading || effectiveMode !== 'sign-in'
          }
          importantForAccessibility={
            !isUpgrading && effectiveMode === 'sign-in' ? 'auto' : 'no-hide-descendants'
          }
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500 underline">
            {t('form.forgotPasswordLink')}
          </Text>
        </Pressable>

        <Pressable
          onPress={submit}
          disabled={submitting}
          className="mb-3 items-center rounded-lg bg-black py-3"
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-base font-semibold text-white">
              {isUpgrading
                ? t('form.submitUpgrade')
                : effectiveMode === 'sign-in'
                  ? t('form.submitSignIn')
                  : t('form.submitSignUp')}
            </Text>
          )}
        </Pressable>

        {!isUpgrading && (
          <Pressable onPress={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
            <Text className="mb-3 text-center text-sm text-gray-600">
              {mode === 'sign-in'
                ? t('form.toggleToSignUp')
                : t('form.toggleToSignIn')}
            </Text>
          </Pressable>
        )}

        {!isUpgrading && (
          <>
            <View className="my-3 flex-row items-center gap-3">
              <View className="h-px flex-1 bg-gray-200" />
              <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
                {t('form.or')}
              </Text>
              <View className="h-px flex-1 bg-gray-200" />
            </View>

            <Pressable
              onPress={continueAsGuest}
              disabled={submitting}
              className="mb-4 items-center rounded-lg border border-black bg-white py-3"
            >
              <Text className="text-base font-semibold text-black">
                {t('form.continueAsGuest')}
              </Text>
            </Pressable>
            <Text className="mb-6 px-4 text-center text-[10px] uppercase tracking-[2px] text-gray-400">
              {t('form.guestHint')}
            </Text>
          </>
        )}

        {/* "Already subscribed? Restore →" — discreet placement for the
            returning customer who reinstalled and doesn't want to sign in
            first. The handler works against an anonymous RevenueCat
            app_user_id; loginPurchases() reattaches the entitlement to
            the real user_id once they sign in. Hidden during upgrade
            (a guest's prior purchases would be on a different user_id
            anyway). */}
        {!isUpgrading && (
          <Pressable
            onPress={handleRestore}
            disabled={restore.isPending}
            hitSlop={6}
            className="mb-4 items-center py-2"
          >
            <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
              {restore.isPending ? t('form.restoring') : t('form.restoreLink')}
            </Text>
          </Pressable>
        )}

        {/* Single Text container so the line wraps as one phrase rather than
            fragmenting on each Pressable. Nested Text inherits styling and
            honors onPress in RN. */}
        <Text className="mb-6 px-2 text-center text-[10px] uppercase tracking-[2px] text-gray-400">
          {t('legal.body', {
            verb: isUpgrading
              ? t('legal.verbUpgrade')
              : effectiveMode === 'sign-up'
                ? t('legal.verbSignUp')
                : t('legal.verbSignIn'),
          })}{' '}
          <Text
            className="text-gray-700 underline"
            accessibilityRole="link"
            accessibilityHint={t('legal.termsHint')}
            onPress={() => router.push('/eula' as any)}
          >
            {t('legal.terms')}
          </Text>
          {' & '}
          <Text
            className="text-gray-700 underline"
            accessibilityRole="link"
            accessibilityHint={t('legal.privacyHint')}
            onPress={() => router.push('/privacy' as any)}
          >
            {t('legal.privacy')}
          </Text>
          .
        </Text>

        {isUpgrading && (
          <Pressable
            // Always land back inside the app, regardless of how the user
            // reached this screen — router.back() was non-deterministic
            // (could pop nothing or to the wrong screen).
            onPress={() => router.replace('/(tabs)' as any)}
            className="items-center py-2"
            hitSlop={6}
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('keepUsingAsGuest')}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
