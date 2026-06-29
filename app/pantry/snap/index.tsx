import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AiCapBlock, AiQuotaHint } from '@/components/ai-cap-block';
import { GuestLocked } from '@/components/guest-locked';
import { useAuth } from '@/lib/auth-context';
import { useAiOpStatus } from '@/lib/gates';
import {
  type ExtractMode,
  useExtractPantryItems,
} from '@/lib/queries/pantry';

type CapturedPhoto = {
  uri: string;
  base64: string;
};

export default function SnapPantryScreen() {
  const router = useRouter();
  const { isGuest } = useAuth();
  const extract = useExtractPantryItems();
  const aiStatus = useAiOpStatus();
  const { t } = useTranslation('pantry');
  const { t: tCommon } = useTranslation('common');

  // Translated label/hint lookups keyed by extract mode. Switch keeps
  // the typed-key augmentation tight — same pattern as cook-sheet's
  // mode-keyed text and plan's meal-type labels.
  const modeLabel = (m: ExtractMode): string =>
    m === 'haul' ? t('snap.modeLabels.haul') : t('snap.modeLabels.receipt');
  const modeHint = (m: ExtractMode): string =>
    m === 'haul' ? t('snap.modeHints.haul') : t('snap.modeHints.receipt');

  const [mode, setMode] = useState<ExtractMode>('haul');
  const [busy, setBusy] = useState(false);
  // Holds the just-captured photo while we wait for / handle the AI
  // result. If extraction returns 0 items, we surface this inline with
  // a Retry / Discard recovery rather than booting the user back to a
  // blank capture screen with no memory of what they snapped.
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [emptyResult, setEmptyResult] = useState(false);

  if (isGuest) {
    return (
      <SafeAreaView style={{ flex: 1 }} className="bg-white">
        <Stack.Screen options={{ title: t('snap.stackTitle') }} />
        <GuestLocked
          headline={t('snap.guestGate.headline')}
          body={t('snap.guestGate.body')}
          ctaLabel={t('snap.guestGate.cta')}
        />
      </SafeAreaView>
    );
  }

  // Q3 cap-hit state: free-tier user out of monthly AI ops + credits.
  // Renders the editorial cap-block instead of the camera CTAs so the
  // user doesn't take a photo, wait, and THEN see a paywall — they see
  // the cap context up front and choose to engage with the upgrade or
  // come back next month.
  if (aiStatus.isCapped) {
    return (
      <SafeAreaView style={{ flex: 1 }} className="bg-white">
        <Stack.Screen options={{ title: t('snap.stackTitle') }} />
        <View className="flex-1 px-6 pt-6">
          <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {t('snap.eyebrow')}
          </Text>
          <Text className="mb-6 font-serif-bold-italic text-3xl">
            {t('snap.headline')}
          </Text>
          <AiCapBlock surface="snap" />
          <Pressable
            onPress={() => router.replace('/pantry/new' as any)}
            className="mt-6 items-center py-2"
            hitSlop={6}
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('snap.addByHand')}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const runExtraction = async (asset: CapturedPhoto): Promise<void> => {
    // Pre-flight cap gate now happens at the screen-level via aiStatus
    // (Q3 lock — render AiCapBlock instead of Alert + paywall). By the
    // time we're in runExtraction the user has already passed that gate.
    // Server still gates via claim_ai_op as a backstop.
    setEmptyResult(false);
    setBusy(true);
    try {
      const res = await extract.mutateAsync({
        image_base64: asset.base64,
        mode,
      });
      if (res.items.length === 0) {
        setEmptyResult(true);
        return;
      }
      // Clear the photo BEFORE pushing — if we cleared after, the
      // router.push could tear down this screen first and React would
      // log a "state update on unmounted component" warning.
      setPhoto(null);
      // Push (not replace) so Android hardware back from the review
      // screen lands the user back here with a logical "step out" stop.
      router.push({
        pathname: '/pantry/snap/review',
        params: { items: JSON.stringify(res.items), mode: res.mode },
      } as any);
    } catch (e: any) {
      // Q2 trust signal: edge function releases the AI op on extraction
      // failure (claim_ai_op release path) so the user isn't charged for
      // failed calls. Reassure them in the alert copy so they don't worry
      // about a wasted op.
      const detail = e?.message ?? t('snap.alerts.extractFailedFallback');
      Alert.alert(
        mode === 'receipt'
          ? t('snap.alerts.extractFailedTitleReceipt')
          : t('snap.alerts.extractFailedTitleHaul'),
        t('snap.alerts.extractFailedBody', { detail }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handlePickResult = async (
    result: ImagePicker.ImagePickerResult,
  ): Promise<void> => {
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.base64) {
      Alert.alert(
        t('snap.alerts.photoUnavailableTitle'),
        t('snap.alerts.photoUnavailableBody'),
      );
      return;
    }
    const captured = { uri: asset.uri, base64: asset.base64 };
    setPhoto(captured);
    await runExtraction(captured);
  };

  const openCamera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('snap.alerts.cameraDeniedTitle'),
        t('snap.alerts.cameraDeniedBody'),
        [
          { text: tCommon('cancel'), style: 'cancel' },
          { text: t('snap.alerts.settingsAction'), onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      // Compressing client-side keeps the base64 payload under ~250 KB
      // and forces re-encode to JPEG (avoids HEIC issues with the
      // vision API).
      quality: 0.55,
      base64: true,
      exif: false,
    });
    await handlePickResult(res);
  };

  const openLibrary = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t('snap.alerts.libraryDeniedTitle'),
        t('snap.alerts.libraryDeniedBody'),
        [
          { text: tCommon('cancel'), style: 'cancel' },
          { text: t('snap.alerts.settingsAction'), onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 0.55,
      base64: true,
      exif: false,
    });
    await handlePickResult(res);
  };

  // Loading takeover — italic Fraunces headline matching the editorial
  // ceremony screens (onboarding / forgot-password sent state). The
  // hairline rule pulses from gray-300 ↔ black so the wait has a sign
  // of life.
  if (busy) {
    return <BusyState mode={mode} />;
  }

  // Empty-extraction recovery — keep the photo on screen with retry +
  // discard affordances, rather than showing an alert and stranding
  // the user on a blank capture screen with no memory of what they
  // snapped. Wrapped in ScrollView so the photo + body + 3 buttons +
  // back-link don't get clipped on small phones (SE, mini).
  if (emptyResult && photo) {
    return (
      <SafeAreaView style={{ flex: 1 }} className="bg-white">
        <Stack.Screen options={{ title: t('snap.tryAgainStackTitle') }} />
        <ScrollView
          contentContainerStyle={{ padding: 24, paddingTop: 16, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {mode === 'receipt' ? t('snap.empty.eyebrowReceipt') : t('snap.empty.eyebrowHaul')}
          </Text>
          <Text className="mb-4 font-serif-bold-italic text-3xl">
            {t('snap.empty.headline')}
          </Text>
          <View className="mb-6 overflow-hidden rounded-lg border border-gray-200">
            <Image
              source={{ uri: photo.uri }}
              style={{ width: '100%', aspectRatio: 4 / 3 }}
              contentFit="cover"
            />
          </View>
          <Text className="mb-2 max-w-[40ch] text-base leading-6 text-gray-600">
            {mode === 'receipt' ? t('snap.empty.hintReceipt') : t('snap.empty.hintHaul')}
          </Text>
          {/* Reassurance: empty results don't count against the monthly AI
              quota. Edge function refunded the op atomically — this copy
              tells the user so they don't worry about a wasted credit. */}
          <Text className="mb-6 font-serif text-sm italic text-forest-700">
            {t('snap.empty.quotaReassurance')}
          </Text>
          <Pressable
            onPress={() => runExtraction(photo)}
            className="mb-3 items-center rounded-lg bg-black py-3.5"
            disabled={extract.isPending}
          >
            {extract.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-base font-semibold text-white">
                {t('snap.empty.retryPhoto')}
              </Text>
            )}
          </Pressable>
          <Pressable
            // Re-launch the library picker directly so the user doesn't
            // have to backtrack to the source-selection screen and tap
            // "Pick from library" again. Library beats camera here —
            // they already have a (failed) photo and likely want to
            // pick a different one from their roll.
            onPress={() => {
              setPhoto(null);
              setEmptyResult(false);
              void openLibrary();
            }}
            className="items-center rounded-lg border border-black bg-white py-3.5"
          >
            <Text className="text-base font-semibold text-black">
              {t('snap.empty.chooseAnother')}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => router.replace('/pantry/new' as any)}
            className="mt-4 items-center py-2"
            hitSlop={6}
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('snap.addByHand')}
            </Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }} className="bg-white">
      <Stack.Screen options={{ title: t('snap.stackTitle') }} />
      <View className="flex-1 px-6 pt-6">
        <Text className="mb-1 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
          {t('snap.eyebrow')}
        </Text>
        <Text className="mb-3 font-serif-bold-italic text-3xl">
          {t('snap.headline')}
        </Text>
        <Text className="mb-8 max-w-[40ch] text-base leading-6 text-gray-600">
          {modeHint(mode)}
        </Text>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('snap.sourceEyebrow')}
        </Text>
        <View className="mb-8 flex-row gap-2">
          {(['haul', 'receipt'] as ExtractMode[]).map((m) => {
            const active = mode === m;
            return (
              <Pressable
                key={m}
                onPress={() => setMode(m)}
                className={`flex-1 rounded-full border px-3 py-3 ${
                  active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                }`}
              >
                <Text
                  className={`text-center text-[11px] uppercase tracking-[2px] ${
                    active ? 'text-white' : 'text-gray-700'
                  }`}
                >
                  {modeLabel(m)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          onPress={openCamera}
          className="mb-3 items-center rounded-lg bg-black py-4"
        >
          <Text className="text-base font-semibold text-white">{t('snap.takePhoto')}</Text>
        </Pressable>

        <Pressable
          onPress={openLibrary}
          className="items-center rounded-lg border border-black bg-white py-4"
        >
          <Text className="text-base font-semibold text-black">
            {t('snap.pickFromLibrary')}
          </Text>
        </Pressable>

        {/* Q1: near-cap counter only — renders nothing unless opsLeft is
            1 or 2. Replaces the legacy daily-cents budget line which
            showed unconditionally and didn't reflect the actual monthly
            quota model. AiQuotaHint already short-circuits for Pro. */}
        {!aiStatus.isPro ? (
          <View className="mt-6 items-center">
            <AiQuotaHint opsLeft={aiStatus.opsLeft} />
          </View>
        ) : null}

        <View className="flex-1" />

        <Pressable
          // Always reachable; "instead" implies the user is choosing
          // the manual path, so router.replace is intentional — the
          // back button on /pantry/new should NOT bring them back here
          // (they'd get an unmounted-camera state).
          onPress={() => router.replace('/pantry/new' as any)}
          className="mb-2 items-center py-2"
          hitSlop={6}
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('snap.addByHand')}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/**
 * Busy state with a pulsing hairline rule. Extracted into a sub-component
 * so the Animated.Value lives in its own lifecycle and doesn't run
 * forever on the parent.
 */
function BusyState({ mode }: { mode: ExtractMode }) {
  const pulse = useRef(new Animated.Value(0.3)).current;
  const { t } = useTranslation('pantry');

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <SafeAreaView style={{ flex: 1 }} className="bg-white">
      <Stack.Screen options={{ title: t('snap.stackTitle') }} />
      <View className="flex-1 items-center justify-center px-8">
        <View className="w-full max-w-[480px] items-start">
          <Text className="mb-3 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {mode === 'receipt' ? t('snap.busy.eyebrowReceipt') : t('snap.busy.eyebrowHaul')}
          </Text>
          <Text className="font-serif-bold-italic text-4xl leading-[1.05] tracking-[-0.5px]">
            {t('snap.busy.headline')}
          </Text>
          <Animated.View
            className="mt-5 h-px w-12 bg-black"
            style={{ opacity: pulse }}
          />
          <Text className="mt-5 max-w-[40ch] font-serif text-base leading-7 text-gray-800">
            {t('snap.busy.body')}
          </Text>
          <ActivityIndicator className="mt-7" color="#000" />
        </View>
      </View>
    </SafeAreaView>
  );
}
