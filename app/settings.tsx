import { useQueryClient } from '@tanstack/react-query';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import RevenueCatUI from '@/lib/rc-ui';

import { useAuth } from '@/lib/auth-context';
import { isPurchasesConfigured } from '@/lib/purchases';
import {
  useDeleteAccount,
  useUpdateDisplayName,
  useUpdateHouseholdSize,
} from '@/lib/queries/account';
import {
  useBlockedUsers,
  useMyReports,
  useUnblockUser,
  useWithdrawReport,
} from '@/lib/queries/moderation';
import { useProfile } from '@/lib/queries/profile';
import {
  classifyRestoreResult,
  subscriptionKeys,
  useMyAiQuota,
  useRestorePurchases,
} from '@/lib/queries/subscription';
import {
  RECIPE_LANGUAGE_LABEL,
  type RecipeLanguage,
} from '@/lib/recipe-language';
import { supabase } from '@/lib/supabase';
import { RECIPE_LANGUAGES, useUiLanguage } from '@/lib/ui-language';

// REASON / STATUS / relTime moved inside the component so they can route
// through useTranslation('settings') and stay typed. See locales/en/
// settings.json (reports.reasons / reports.statuses / relTime).

export default function SettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const profile = useProfile();
  const updateName = useUpdateDisplayName();
  const updateHousehold = useUpdateHouseholdSize();
  const deleteAccount = useDeleteAccount();
  const blocked = useBlockedUsers();
  const unblock = useUnblockUser();
  const reports = useMyReports();
  const withdraw = useWithdrawReport();
  const quota = useMyAiQuota();
  const restore = useRestorePurchases();
  const [uiLanguage, setUiLanguage] = useUiLanguage();
  const { resetOnboarding, isGuest, session, loading: authLoading } = useAuth();
  const { t } = useTranslation('settings');
  const { t: tCommon } = useTranslation('common');

  // Inline relTime + lookups so they can use the translator. Avoids
  // dynamic-key gymnastics with i18next's typed augmentation.
  const relTime = (iso: string): string => {
    const d = new Date(iso);
    const ms = Date.now() - d.getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days < 1) return t('relTime.today');
    if (days === 1) return t('relTime.yesterday');
    if (days < 30) return t('relTime.daysAgo', { count: days });
    if (days < 365)
      return t('relTime.monthsAgo', { count: Math.floor(days / 30) });
    return t('relTime.yearsAgo', { count: Math.floor(days / 365) });
  };

  const reasonLabel = (reason: string): string => {
    switch (reason) {
      case 'inappropriate':
        return t('reports.reasons.inappropriate');
      case 'spam':
        return t('reports.reasons.spam');
      case 'incorrect':
        return t('reports.reasons.incorrect');
      case 'other':
        return t('reports.reasons.other');
      default:
        return reason;
    }
  };

  const statusLabel = (status: string): string => {
    switch (status) {
      case 'pending':
        return t('reports.statuses.pending');
      case 'reviewed':
        return t('reports.statuses.reviewed');
      case 'dismissed':
        return t('reports.statuses.dismissed');
      case 'actioned':
        return t('reports.statuses.actioned');
      default:
        return status;
    }
  };
  const [displayName, setDisplayName] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  // Household size editor — seeded from profile, edited locally, committed
  // via explicit Save button (same pattern as display name above).
  const [householdSize, setHouseholdSize] = useState(2);
  const [savedHouseholdFlash, setSavedHouseholdFlash] = useState(false);
  const householdFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Two-stage delete: first an Alert.alert "Continue?" then this typed
  // confirmation modal. We use a custom Modal (not Alert.prompt) because
  // Alert.prompt is iOS-only — on Android the second step would silently
  // never render.
  //
  // For real accounts (non-guest), we ALSO require the current password —
  // re-auth defends against an unattended phone destroying the account from
  // the lock screen. Guests have no password and skip this step.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteConfirmPassword, setDeleteConfirmPassword] = useState('');
  const [deleteAuthError, setDeleteAuthError] = useState<string | null>(null);
  const [reauthPending, setReauthPending] = useState(false);
  // Separate flash for the change-password success — different copy, but
  // same one-shot mechanism. Triggered when /auth/change-password
  // navigates back here with ?passwordChanged=1.
  const [passwordFlash, setPasswordFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordChangedParam = useLocalSearchParams<{
    passwordChanged?: string;
  }>().passwordChanged;

  useEffect(() => {
    if (profile.data?.display_name != null) {
      setDisplayName(profile.data.display_name ?? '');
    }
  }, [profile.data?.display_name]);

  useEffect(() => {
    if (profile.data?.household_size != null) {
      setHouseholdSize(profile.data.household_size);
    }
  }, [profile.data?.household_size]);

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (passwordFlashTimer.current) clearTimeout(passwordFlashTimer.current);
      if (householdFlashTimer.current) clearTimeout(householdFlashTimer.current);
    };
  }, []);

  // Catch the change-password redirect and surface a confirmation. We
  // also clear the route param so a navigation refresh / re-render
  // doesn't re-trigger the flash.
  useEffect(() => {
    if (passwordChangedParam !== '1') return;
    setPasswordFlash(true);
    if (passwordFlashTimer.current) clearTimeout(passwordFlashTimer.current);
    passwordFlashTimer.current = setTimeout(
      () => setPasswordFlash(false),
      2400,
    );
    router.setParams({ passwordChanged: '' } as any);
  }, [passwordChangedParam, router]);

  const trimmed = displayName.trim();
  const dirty =
    profile.data != null && trimmed !== (profile.data.display_name ?? '').trim();

  const handleSaveName = async () => {
    try {
      await updateName.mutateAsync(trimmed);
      setSavedFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 2400);
    } catch (e: any) {
      Alert.alert(
        t('profile.alerts.saveFailedTitle'),
        e.message ?? t('profile.alerts.saveFailedFallback'),
      );
    }
  };

  const householdDirty =
    profile.data != null && householdSize !== (profile.data.household_size ?? 2);

  const handleSaveHousehold = async () => {
    try {
      await updateHousehold.mutateAsync(householdSize);
      setSavedHouseholdFlash(true);
      if (householdFlashTimer.current) clearTimeout(householdFlashTimer.current);
      householdFlashTimer.current = setTimeout(
        () => setSavedHouseholdFlash(false),
        2400,
      );
    } catch (e: any) {
      Alert.alert(
        t('profile.alerts.saveFailedTitle'),
        e.message ?? t('profile.alerts.saveFailedFallback'),
      );
    }
  };

  // RevenueCat's Customer Center is exposed only via the imperative
  // presentCustomerCenter() method in react-native-purchases-ui v8 — there's
  // no JSX component. Earlier code attempted <RevenueCatUI.CustomerCenter>
  // in a /manage route which crashed at runtime. Inline call from Settings
  // is the supported pattern: opens RC's native modal (handles cancel /
  // refund / plan switch / "why are you cancelling?" survey). On dismissal
  // we invalidate the profile + quota caches so the subscription panel
  // reflects whatever the user did inside the modal without waiting on the
  // RevenueCat webhook to round-trip.
  const handleManageSubscription = async () => {
    if (!isPurchasesConfigured()) {
      Alert.alert(
        t('subscription.alerts.manageUnavailableTitle'),
        t('subscription.alerts.manageUnavailableBody'),
      );
      return;
    }
    try {
      await RevenueCatUI.presentCustomerCenter();
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: subscriptionKeys.quota });
    } catch (e: any) {
      Alert.alert(
        t('subscription.alerts.manageFailedTitle'),
        e?.message ?? t('subscription.alerts.manageFailedFallback'),
      );
    }
  };

  const handleSignOut = () => {
    if (isGuest) {
      Alert.alert(
        t('account.alerts.endGuestTitle'),
        t('account.alerts.endGuestBody'),
        [
          { text: tCommon('cancel'), style: 'cancel' },
          {
            text: t('account.alerts.endGuestConfirm'),
            style: 'destructive',
            onPress: () => supabase.auth.signOut(),
          },
        ],
      );
      return;
    }
    Alert.alert(t('account.alerts.signOutTitle'), undefined, [
      { text: tCommon('cancel'), style: 'cancel' },
      {
        text: t('account.alerts.signOutConfirm'),
        style: 'destructive',
        onPress: () => supabase.auth.signOut(),
      },
    ]);
  };

  const proceedDelete = async () => {
    try {
      await deleteAccount.mutateAsync();
      // For guests, also reset the onboarding flag — when they re-launch
      // they should re-experience the intro that pitched the app rather
      // than landing straight on /sign-in. For real users we leave the
      // flag alone (they've already seen it; no need on next install).
      if (isGuest) {
        await resetOnboarding();
      }
    } catch (e: any) {
      Alert.alert(
        t('dangerZone.alerts.deleteFailedTitle'),
        e.message ?? t('dangerZone.alerts.deleteFailedFallback'),
      );
    }
  };

  const handleDelete = () => {
    Alert.alert(
      t('dangerZone.alerts.deleteStartTitle'),
      t('dangerZone.alerts.deleteStartBody'),
      [
        { text: tCommon('cancel'), style: 'cancel' },
        {
          text: t('dangerZone.alerts.deleteStartConfirm'),
          style: 'destructive',
          onPress: () => {
            // Defer to next tick so the Alert can fully dismiss before
            // the Modal slides in — otherwise iOS occasionally shows them
            // overlapping for a frame.
            setDeleteConfirmText('');
            setDeleteConfirmPassword('');
            setDeleteAuthError(null);
            setDeleteConfirmOpen(true);
          },
        },
      ],
    );
  };

  const handleDeleteConfirmSubmit = async () => {
    if (deleteConfirmText.trim() !== 'DELETE') {
      Alert.alert(t('deleteModal.mismatchTitle'), t('deleteModal.mismatchBody'));
      return;
    }

    // Guests have no password — only the typed-DELETE check applies.
    if (isGuest) {
      setDeleteConfirmOpen(false);
      void proceedDelete();
      return;
    }

    const email = session?.user?.email;
    if (!email) {
      // Should never happen for a non-guest session, but bail rather than
      // proceeding with a destructive action on missing identity.
      setDeleteAuthError(t('deleteModal.noEmailError'));
      return;
    }
    if (!deleteConfirmPassword) {
      setDeleteAuthError(t('deleteModal.noPasswordError'));
      return;
    }

    setDeleteAuthError(null);
    setReauthPending(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password: deleteConfirmPassword,
      });
      if (error) {
        // Don't leak whether the email exists or specifically what failed —
        // generic "incorrect password" is enough for the user and gives
        // less to a shoulder-surfer.
        setDeleteAuthError(t('deleteModal.wrongPasswordError'));
        return;
      }
    } finally {
      setReauthPending(false);
    }

    setDeleteConfirmOpen(false);
    void proceedDelete();
  };

  const handleWithdrawReport = (id: string) => {
    Alert.alert(
      t('reports.alerts.withdrawTitle'),
      t('reports.alerts.withdrawBody'),
      [
        { text: tCommon('cancel'), style: 'cancel' },
        {
          text: t('reports.alerts.withdrawConfirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await withdraw.mutateAsync(id);
            } catch (e: any) {
              Alert.alert(
                t('reports.alerts.withdrawFailedTitle'),
                e.message ?? t('reports.alerts.withdrawFailedFallback'),
              );
            }
          },
        },
      ],
    );
  };

  const handleUnblock = (id: string, name: string | null) => {
    Alert.alert(
      name
        ? t('blocked.alerts.confirmTitle', { name })
        : t('blocked.alerts.confirmTitleFallback'),
      t('blocked.alerts.confirmBody'),
      [
        { text: tCommon('cancel'), style: 'cancel' },
        {
          text: t('blocked.alerts.confirmAction'),
          onPress: async () => {
            try {
              await unblock.mutateAsync(id);
            } catch (e: any) {
              Alert.alert(
                t('blocked.alerts.failedTitle'),
                e.message ?? t('blocked.alerts.failedFallback'),
              );
            }
          },
        },
      ],
    );
  };

  const blockedRows = blocked.data ?? [];
  const reportRows = reports.data ?? [];

  // Settings sits outside the (tabs) group, so it has no auth gate of
  // its own. When the user signs out (or a session expires) we'd
  // otherwise stay parked here with stale data. AuthProvider also
  // redirects globally; this is the local belt-and-suspenders so the
  // queries above don't fire against a dead session in the gap.
  if (!authLoading && !session) {
    return <Redirect href="/sign-in" />;
  }

  return (
    <ScrollView
      // Tinted background lets the rounded white cards read as iOS grouped
      // table sections. The whole screen pulls slightly cooler than the
      // pure-white app body, which signals "secondary chrome" without
      // breaking the editorial palette.
      contentContainerStyle={{ padding: 20, paddingBottom: 80 }}
      className="bg-gray-50"
      style={{ backgroundColor: '#f9fafb' }}
    >
      <Text className="mb-6 px-1 font-serif-bold text-3xl">{t('title')}</Text>

      {isGuest && (
        <View className="mb-8 rounded-lg border border-black bg-white p-5">
          <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {t('guest.eyebrow')}
          </Text>
          <Text className="mb-2 font-serif-bold text-2xl">
            {t('guest.headline')}
          </Text>
          <Text className="mb-5 text-sm leading-5 text-gray-700">
            {t('guest.body')}
          </Text>
          <Pressable
            onPress={() => router.push('/sign-in' as any)}
            className="items-center rounded-full bg-black py-3"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-white">
              {t('guest.saveAccountLink')}
            </Text>
          </Pressable>
        </View>
      )}

      {/* ---------- Subscription ---------- */}
      {!isGuest && quota.data ? (
        <View className="mb-2">
          <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('subscription.section')}
          </Text>
          {quota.data.tier === 'pro' ? (
            <View className="rounded-xl bg-white px-4 py-4">
              <Text className="text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
                {t('subscription.brand')}
              </Text>
              <Text className="mt-1 font-serif text-lg">
                {quota.data.subscription_status === 'pro_yearly'
                  ? t('subscription.planAnnual')
                  : quota.data.subscription_status === 'pro_monthly'
                    ? t('subscription.planMonthly')
                    : t('subscription.planCancelled')}
              </Text>
              {quota.data.expires_at ? (
                <Text className="mt-1 font-serif text-sm italic text-gray-600">
                  {quota.data.subscription_status === 'cancelled'
                    ? t('subscription.expires', {
                        date: new Date(quota.data.expires_at).toLocaleDateString(),
                      })
                    : t('subscription.renews', {
                        date: new Date(quota.data.expires_at).toLocaleDateString(),
                      })}
                </Text>
              ) : null}
              {quota.data.credits_remaining > 0 ? (
                <Text className="mt-2 text-[10px] uppercase tracking-[2px] text-gray-500">
                  {t('subscription.bonusCredits', { count: quota.data.credits_remaining })}
                </Text>
              ) : null}
              <Pressable
                onPress={handleManageSubscription}
                className="mt-3 self-start rounded-full border border-black px-4 py-2"
              >
                <Text className="text-[11px] uppercase tracking-[2px] text-black">
                  {t('subscription.manageLink')}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View className="rounded-xl bg-white px-4 py-4">
              <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
                {t('subscription.freeLabel')}
              </Text>
              <Text className="mt-1 font-serif-bold text-2xl">
                {t('subscription.freeHeadline')}
              </Text>
              <Text className="mt-1 font-serif text-sm italic leading-6 text-gray-600">
                {t('subscription.freeBody')}
              </Text>
              <View className="mt-3 flex-row items-center gap-3">
                <Pressable
                  onPress={() => router.push('/paywall' as any)}
                  className="rounded-full bg-black px-4 py-2"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-white">
                    {t('subscription.seePro')}
                  </Text>
                </Pressable>
                <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
                  {t('subscription.freeUsage', {
                    used: quota.data.ops_used_this_month,
                    cap: quota.data.ops_cap_this_month,
                  })}
                  {quota.data.credits_remaining > 0
                    ? t('subscription.freeUsageCredits', {
                        count: quota.data.credits_remaining,
                      })
                    : ''}
                </Text>
              </View>
            </View>
          )}
          <Pressable
            onPress={async () => {
              try {
                const info = await restore.mutateAsync();
                const outcome = classifyRestoreResult(info);
                switch (outcome.kind) {
                  case 'restored':
                    // RevenueCat → revenuecat-webhook → profiles can take
                    // 0.5–5s to propagate. The hook already invalidated
                    // the quota query; the success message warns the user
                    // it might take a beat to reflect in the rest of the
                    // UI so they don't tap around in confusion.
                    Alert.alert(
                      t('subscription.alerts.restoredTitle'),
                      t('subscription.alerts.restoredBody'),
                    );
                    break;
                  case 'nothing-on-apple-id':
                    Alert.alert(
                      t('subscription.alerts.nothingTitle'),
                      t('subscription.alerts.nothingBody'),
                    );
                    break;
                  case 'inactive-history':
                    Alert.alert(
                      t('subscription.alerts.inactiveTitle'),
                      t('subscription.alerts.inactiveBody'),
                    );
                    break;
                }
              } catch (e: any) {
                Alert.alert(
                  t('subscription.alerts.restoreFailedTitle'),
                  e?.message ?? t('subscription.alerts.restoreFailedFallback'),
                );
              }
            }}
            disabled={restore.isPending}
            className="mt-2 self-start py-2"
          >
            <Text className="text-[10px] uppercase tracking-[2px] text-gray-600">
              {restore.isPending
                ? t('subscription.restoring')
                : t('subscription.restoreLink')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* ---------- Profile (Display name) ---------- */}
      {!isGuest && (
        <View className="mb-2">
          <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('profile.section')}
          </Text>
          <View className="rounded-xl bg-white px-4 py-4">
            <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-400">
              {t('profile.displayNameLabel')}
            </Text>
            <TextInput
              className="rounded-lg border border-gray-200 px-3 py-3 text-base"
              placeholder={t('profile.displayNamePlaceholder')}
              autoCapitalize="words"
              autoCorrect={false}
              value={displayName}
              onChangeText={(next) => setDisplayName(next.slice(0, 60))}
            />
            {/* Small-caps counter matches the pattern in components/report-sheet
                so the 60-char cap doesn't silently swallow extra typing. */}
            <Text className="mt-1 text-[10px] uppercase tracking-[2px] text-gray-400">
              {t('profile.counter', { count: displayName.length, max: 60 })}
            </Text>
            <View className="mt-3 flex-row items-center gap-3">
              <Pressable
                onPress={handleSaveName}
                disabled={!dirty || updateName.isPending}
                hitSlop={6}
                className={`rounded-full border px-4 py-1.5 ${
                  dirty && !updateName.isPending
                    ? 'border-black bg-white'
                    : 'border-gray-300 bg-white'
                }`}
              >
                {updateName.isPending ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text
                    className={`text-[11px] uppercase tracking-[2px] ${
                      dirty ? 'text-black' : 'text-gray-400'
                    }`}
                  >
                    {t('profile.saveName')}
                  </Text>
                )}
              </Pressable>
              {savedFlash && (
                <Text className="text-[10px] font-semibold uppercase tracking-[2px] text-terracotta-600">
                  {t('profile.savedFlash')}
                </Text>
              )}
            </View>
          </View>
          <Text className="mt-2 px-3 text-[10px] uppercase tracking-[2px] text-gray-400">
            {t('profile.hint')}
          </Text>
        </View>
      )}

      {/* ---------- Household ----------
          Seeded from onboarding's activation slide. Drives default
          servings on the RecipePicker / cook-sheet and scales shopping
          list math. Visible to all signed-in users (incl. guests) since
          everyone benefits from getting the math right. */}
      {!isGuest && (
        <View className="mb-2">
          <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('household.section')}
          </Text>
          <View className="rounded-xl bg-white px-4 py-4">
            <Text className="mb-3 text-[11px] uppercase tracking-[2px] text-gray-400">
              {t('household.label')}
            </Text>
            <View className="flex-row items-center">
              <Pressable
                onPress={() =>
                  householdSize > 1 && setHouseholdSize((s) => s - 1)
                }
                disabled={householdSize <= 1}
                hitSlop={6}
                className={`h-11 w-11 items-center justify-center rounded-full border ${
                  householdSize > 1 ? 'border-gray-400' : 'border-gray-200'
                }`}
              >
                <Text
                  className={`text-xl ${
                    householdSize > 1 ? 'text-gray-900' : 'text-gray-300'
                  }`}
                >
                  −
                </Text>
              </Pressable>
              <Text className="mx-5 min-w-[36px] text-center font-serif-medium text-3xl">
                {householdSize}
              </Text>
              <Pressable
                onPress={() =>
                  householdSize < 8 && setHouseholdSize((s) => s + 1)
                }
                disabled={householdSize >= 8}
                hitSlop={6}
                className={`h-11 w-11 items-center justify-center rounded-full border ${
                  householdSize < 8 ? 'border-gray-400' : 'border-gray-200'
                }`}
              >
                {/* Chrome glyph — see the inline-ignore comment on the
                    other steppers (recipe-picker, batch-count-sheet,
                    onboarding) for why this one needs the suppression. */}
                {/* eslint-disable i18next/no-literal-string */}
                <Text
                  className={`text-xl ${
                    householdSize < 8 ? 'text-gray-900' : 'text-gray-300'
                  }`}
                >
                  +
                </Text>
                {/* eslint-enable i18next/no-literal-string */}
              </Pressable>
            </View>
            <View className="mt-3 flex-row items-center gap-3">
              <Pressable
                onPress={handleSaveHousehold}
                disabled={!householdDirty || updateHousehold.isPending}
                hitSlop={6}
                className={`rounded-full border px-4 py-1.5 ${
                  householdDirty && !updateHousehold.isPending
                    ? 'border-black bg-white'
                    : 'border-gray-300 bg-white'
                }`}
              >
                {updateHousehold.isPending ? (
                  <ActivityIndicator color="#000" />
                ) : (
                  <Text
                    className={`text-[11px] uppercase tracking-[2px] ${
                      householdDirty ? 'text-black' : 'text-gray-400'
                    }`}
                  >
                    {t('household.save')}
                  </Text>
                )}
              </Pressable>
              {savedHouseholdFlash && (
                <Text className="text-[10px] font-semibold uppercase tracking-[2px] text-terracotta-600">
                  {t('household.savedFlash')}
                </Text>
              )}
            </View>
          </View>
          <Text className="mt-2 px-3 text-[10px] uppercase tracking-[2px] text-gray-400">
            {t('household.hint')}
          </Text>
        </View>
      )}

      {/* ---------- Language ----------
          UI language for menus / buttons / onboarding. Defaults to the
          device locale on first launch; explicit override here persists
          via AsyncStorage. Recipe CONTENT language is detected per-recipe
          and tracked separately on recipes.language. Visible to guests
          too — UI language matters before sign-in too. */}
      <View className="mb-2">
        <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('language.section')}
        </Text>
        <View className="rounded-xl bg-white px-4 py-4">
          <Text className="mb-3 text-[11px] uppercase tracking-[2px] text-gray-400">
            {t('language.label')}
          </Text>
          <View className="flex-row gap-2">
            {RECIPE_LANGUAGES.map((lang) => {
              const active = uiLanguage === lang;
              return (
                <Pressable
                  key={lang}
                  onPress={() => setUiLanguage(lang)}
                  className={`rounded-full border px-3 py-1.5 ${
                    active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                  }`}
                >
                  <Text
                    className={`text-[11px] uppercase tracking-[2px] ${
                      active ? 'text-white' : 'text-gray-700'
                    }`}
                  >
                    {RECIPE_LANGUAGE_LABEL[lang as RecipeLanguage]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <Text className="mt-2 px-3 text-[10px] uppercase tracking-[2px] text-gray-400">
          {t('language.hint')}
        </Text>
      </View>

      {/* ---------- Account ---------- */}
      <View className="mt-6 mb-2">
        <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('account.section')}
        </Text>
        <View className="overflow-hidden rounded-xl bg-white">
          <SettingsRow
            label={t('account.terms')}
            onPress={() => router.push('/eula' as any)}
          />
          <SettingsRow
            label={t('account.privacy')}
            onPress={() => router.push('/privacy' as any)}
          />
          {!isGuest && (
            <SettingsRow
              label={t('account.changePassword')}
              onPress={() => router.push('/auth/change-password' as any)}
              trailing={
                passwordFlash ? (
                  <Text className="text-[10px] font-semibold uppercase tracking-[2px] text-terracotta-600">
                    {t('account.passwordFlash')}
                  </Text>
                ) : undefined
              }
            />
          )}
          <SettingsRow
            label={t('account.showIntro')}
            onPress={async () => {
              await resetOnboarding();
              router.replace('/onboarding' as any);
            }}
          />
          <SettingsRow
            label={isGuest ? t('account.endGuestSession') : t('account.signOut')}
            onPress={handleSignOut}
            isLast
          />
        </View>
      </View>

      {/* ---------- Blocked users ---------- */}
      <View className="mt-6 mb-2">
        <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('blocked.section')}
        </Text>
        <View className="overflow-hidden rounded-xl bg-white">
          {blocked.isLoading ? (
            <View className="px-4 py-5">
              <ActivityIndicator color="#000" />
            </View>
          ) : blockedRows.length === 0 ? (
            <View className="px-4 py-5">
              <Text className="font-serif text-base italic text-gray-500">
                {t('blocked.emptyHeadline')}
              </Text>
              <Text className="mt-1 text-xs text-gray-500">
                {t('blocked.emptyHint')}
              </Text>
            </View>
          ) : (
            blockedRows.map((b, idx) => {
              const isLast = idx === blockedRows.length - 1;
              return (
                <View
                  key={b.blocked_id}
                  className={`flex-row items-center justify-between px-4 py-3 ${
                    !isLast ? 'border-b border-gray-100' : ''
                  }`}
                >
                  <View className="flex-1 pr-3">
                    <Text className="font-serif text-base" numberOfLines={1}>
                      {b.display_name ?? t('blocked.unnamedUser')}
                    </Text>
                    <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-400">
                      {t('blocked.blockedAt', { time: relTime(b.blocked_at) })}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleUnblock(b.blocked_id, b.display_name)}
                    hitSlop={6}
                    className="rounded-full border border-black px-3 py-1.5"
                    disabled={unblock.isPending}
                  >
                    <Text className="text-[11px] uppercase tracking-[2px] text-black">
                      {t('blocked.unblockButton')}
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </View>
      </View>

      {/* ---------- My reports ---------- */}
      <View className="mt-6 mb-2">
        <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('reports.section')}
        </Text>
        <View className="overflow-hidden rounded-xl bg-white">
          {reports.isLoading ? (
            <View className="px-4 py-5">
              <ActivityIndicator color="#000" />
            </View>
          ) : reportRows.length === 0 ? (
            <View className="px-4 py-5">
              <Text className="font-serif text-base italic text-gray-500">
                {t('reports.emptyHeadline')}
              </Text>
              <Text className="mt-1 text-xs text-gray-500">
                {t('reports.emptyHint')}
              </Text>
            </View>
          ) : (
            reportRows.map((r, idx) => {
              const isLast = idx === reportRows.length - 1;
              return (
                <View
                  key={r.id}
                  className={`flex-row items-start justify-between px-4 py-3 ${
                    !isLast ? 'border-b border-gray-100' : ''
                  }`}
                >
                  <View className="flex-1 pr-3">
                    <Text className="font-serif text-base" numberOfLines={1}>
                      {r.subject_kind === 'recipe'
                        ? r.recipe_title ?? t('reports.deletedRecipe')
                        : t('reports.userSubject')}
                    </Text>
                    <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-500">
                      {reasonLabel(r.reason)} · {statusLabel(r.status)} ·{' '}
                      {relTime(r.created_at)}
                    </Text>
                  </View>
                  {r.status === 'pending' ? (
                    <Pressable
                      onPress={() => handleWithdrawReport(r.id)}
                      hitSlop={6}
                      className="rounded-full border border-gray-300 px-3 py-1.5"
                      disabled={withdraw.isPending && withdraw.variables === r.id}
                    >
                      {withdraw.isPending && withdraw.variables === r.id ? (
                        <ActivityIndicator color="#374151" />
                      ) : (
                        <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                          {t('reports.withdrawButton')}
                        </Text>
                      )}
                    </Pressable>
                  ) : null}
                </View>
              );
            })
          )}
        </View>
        <Text className="mt-2 px-3 text-[10px] uppercase tracking-[2px] text-gray-400">
          {t('reports.slaHint')}
        </Text>
      </View>

      {/* ---------- Danger zone ---------- */}
      <View className="mt-8 mb-2">
        <Text className="mb-2 px-3 text-[11px] uppercase tracking-[2px] text-red-600">
          {t('dangerZone.section')}
        </Text>
        <View className="rounded-xl bg-white px-4 py-4">
          <Text className="mb-3 text-sm leading-5 text-gray-600">
            {isGuest ? t('dangerZone.guestBody') : t('dangerZone.userBody')}
          </Text>
          <Pressable
            onPress={handleDelete}
            disabled={deleteAccount.isPending}
            className="self-start rounded-full border border-red-500 px-4 py-2"
          >
            {deleteAccount.isPending ? (
              <ActivityIndicator color="#dc2626" />
            ) : (
              <Text className="text-[11px] uppercase tracking-[2px] text-red-600">
                {isGuest
                  ? t('dangerZone.deleteGuestData')
                  : t('dangerZone.deleteAccount')}
              </Text>
            )}
          </Pressable>
        </View>
      </View>

      {/* ---------- Final delete confirmation modal ---------- */}
      <Modal
        visible={deleteConfirmOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setDeleteConfirmOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <View className="flex-1 items-center justify-center bg-black/40 px-6">
            <View className="w-full max-w-sm rounded-2xl bg-white p-6">
              <Text className="mb-1 text-[11px] uppercase tracking-[2px] text-red-600">
                {t('deleteModal.eyebrow')}
              </Text>
              <Text className="mb-3 font-serif-bold text-xl">
                {isGuest
                  ? t('deleteModal.headlineGuest')
                  : t('deleteModal.headlineUser')}
              </Text>
              <Text className="mb-4 text-sm leading-5 text-gray-600">
                {t('deleteModal.body')}
              </Text>
              <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-400">
                {t('deleteModal.typeDeleteLabel')}
              </Text>
              <TextInput
                className="mb-4 rounded-lg border border-gray-300 px-4 py-3 text-base"
                placeholder={t('deleteModal.typeDeletePlaceholder')}
                autoCapitalize="characters"
                autoCorrect={false}
                value={deleteConfirmText}
                onChangeText={setDeleteConfirmText}
                returnKeyType="next"
                autoFocus
              />
              {!isGuest && (
                <>
                  <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-400">
                    {t('deleteModal.passwordLabel')}
                  </Text>
                  <TextInput
                    className={`mb-2 rounded-lg border px-4 py-3 text-base ${
                      deleteAuthError ? 'border-amber-400' : 'border-gray-300'
                    }`}
                    placeholder={t('deleteModal.passwordPlaceholder')}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="current-password"
                    textContentType="password"
                    value={deleteConfirmPassword}
                    onChangeText={(next) => {
                      setDeleteConfirmPassword(next);
                      if (deleteAuthError) setDeleteAuthError(null);
                    }}
                    onSubmitEditing={handleDeleteConfirmSubmit}
                    returnKeyType="done"
                  />
                  {deleteAuthError ? (
                    <Text className="mb-3 text-xs text-red-600">
                      {deleteAuthError}
                    </Text>
                  ) : (
                    <View className="mb-3" />
                  )}
                </>
              )}
              <View className="flex-row justify-end gap-3">
                <Pressable
                  onPress={() => setDeleteConfirmOpen(false)}
                  hitSlop={6}
                  className="px-3 py-2"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
                    {t('deleteModal.cancel')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleDeleteConfirmSubmit}
                  disabled={deleteAccount.isPending || reauthPending}
                  className="rounded-full border border-red-500 px-4 py-2"
                >
                  {reauthPending || deleteAccount.isPending ? (
                    <ActivityIndicator color="#dc2626" />
                  ) : (
                    <Text className="text-[11px] uppercase tracking-[2px] text-red-600">
                      {t('deleteModal.deleteButton')}
                    </Text>
                  )}
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

/**
 * iOS-style grouped table row. Renders as a tappable line inside a rounded
 * white card. The chevron-right glyph cues "drills down to another screen";
 * the optional trailing slot is for inline status (e.g. ✓ Updated flash
 * after a change-password redirect).
 */
function SettingsRow({
  label,
  onPress,
  trailing,
  isLast,
}: {
  label: string;
  onPress: () => void;
  trailing?: React.ReactNode;
  isLast?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center justify-between px-4 py-3 ${
        !isLast ? 'border-b border-gray-100' : ''
      }`}
    >
      <Text className="text-base text-gray-800">{label}</Text>
      <View className="flex-row items-center gap-2">
        {trailing}
        <Text className="text-base text-gray-300">›</Text>
      </View>
    </Pressable>
  );
}
