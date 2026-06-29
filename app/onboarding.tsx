import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { supabase } from '@/lib/supabase';

/**
 * Onboarding — hybrid framing + activation flow.
 *
 * Locked decisions from the grill session:
 *   Q1: Hybrid pattern — one framing slide + one micro-action, then
 *       commit. NOT three informational slides.
 *   Q2: Micro-action is household_size (1-8). Highest ROI per second of
 *       the user's time; drives recipe servings + shopping list math.
 *   Q3: Framing slide uses the marketing tagline verbatim ("Plan meals,
 *       manage your pantry, never overbuy.") — recognition continuity
 *       from the landing page.
 *   Q4: Primary CTA on the last slide creates an anonymous session and
 *       drops the user into the app. "Already have an account? Sign in →"
 *       is the quiet secondary. Skip (top-right) = same as Continue but
 *       bypasses the household pick.
 *
 * The two-slide structure means the entire onboarding is ~10 seconds for
 * a user who knows their household size — measurably faster than the
 * prior 3-slide informational design.
 */

const HOUSEHOLD_DEFAULT = 2;
const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 8;

export default function OnboardingScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { session, markOnboardingSeen } = useAuth();
  const { t } = useTranslation('onboarding');
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const [householdSize, setHouseholdSize] = useState(HOUSEHOLD_DEFAULT);
  const [submitting, setSubmitting] = useState(false);

  const goToPage = (n: number) => {
    scrollRef.current?.scrollTo({ x: n * width, animated: true });
    setPage(n);
  };

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== page) setPage(next);
  };

  /**
   * Primary commitment path: anon sign-in (if no session), persist
   * household_size, mark onboarding seen, route into the tabs.
   *
   * If a session already exists (rare on first install — happens when
   * the user reaches /onboarding via Settings → "Show intro again"), we
   * skip the anon sign-in and just update household + mark seen.
   *
   * Skip (top-right) uses the same path with default household.
   */
  const startAsGuest = async () => {
    setSubmitting(true);
    try {
      if (!session) {
        const { error } = await supabase.auth.signInAnonymously();
        if (error) {
          Alert.alert(
            t('guestErrorTitle'),
            error.message ?? t('guestErrorBody'),
          );
          return;
        }
      }
      // Persist household_size to the profile row. After signInAnonymously
      // the user is created; the profile-creation trigger gives us a row
      // to update. For sessions that pre-existed (Show-intro-again path),
      // the profile already exists.
      const { data: u } = await supabase.auth.getUser();
      if (u.user) {
        await supabase
          .from('profiles')
          .update({ household_size: householdSize })
          .eq('id', u.user.id);
      }
      await markOnboardingSeen();
      router.replace('/(tabs)' as any);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Secondary path: user wants to sign in with their existing account
   * rather than try as a guest. Marks onboarding seen so they don't see
   * it again if they back out before completing sign-in, then routes to
   * /sign-in for the standard auth flow.
   */
  const goToSignIn = async () => {
    await markOnboardingSeen();
    router.replace('/sign-in' as any);
  };

  /**
   * Top-right Skip — fast-track guest session, bypassing the household
   * pick. Falls back to HOUSEHOLD_DEFAULT (2), which is what the rest of
   * the app uses as its fallback already (RecipePicker, etc.).
   */
  const skip = async () => {
    setHouseholdSize(HOUSEHOLD_DEFAULT);
    await startAsGuest();
  };

  const handleContinue = () => {
    if (page === 0) {
      goToPage(1);
    } else {
      void startAsGuest();
    }
  };

  const isLast = page === 1;

  return (
    <SafeAreaView style={{ flex: 1 }} className="bg-white">
      <View className="flex-row items-center justify-between px-6 pt-2">
        <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('brandTag')}
        </Text>
        <Pressable
          onPress={() => void skip()}
          hitSlop={10}
          disabled={submitting}
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('skip')}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        scrollEventThrottle={16}
        style={{ flex: 1 }}
      >
        <FramingSlide width={width} active={page === 0} t={t} />
        <ActivationSlide
          width={width}
          active={page === 1}
          value={householdSize}
          onChange={setHouseholdSize}
          t={t}
        />
      </ScrollView>

      <View className="px-6 pb-6">
        <View className="mb-6 flex-row items-center justify-center gap-2.5">
          {[0, 1].map((i) => (
            <View
              key={i}
              className={`h-1.5 rounded-full ${
                i === page ? 'w-6 bg-black' : 'w-1.5 bg-gray-300'
              }`}
            />
          ))}
        </View>

        <Pressable
          onPress={handleContinue}
          disabled={submitting}
          className="items-center rounded-lg bg-black py-3.5"
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-base font-semibold text-white">
              {isLast ? t('getStarted') : t('continue')}
            </Text>
          )}
        </Pressable>

        {isLast && !session && (
          <Pressable
            onPress={() => void goToSignIn()}
            disabled={submitting}
            className="mt-3 items-center py-2"
            hitSlop={6}
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
              {t('signInLink')}
            </Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

/**
 * Slide 1 — framing. Pure tagline display in italic-serif, no body
 * paragraph. Brand-eyebrow above ("From IdeaGen") for landing-page
 * continuity. Hairline divider below to match the established slide
 * template.
 */
function FramingSlide({
  width,
  active,
  t,
}: {
  width: number;
  active: boolean;
  t: ReturnType<typeof useTranslation<'onboarding'>>['t'];
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    if (!active) return;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [active, opacity, translateY]);

  return (
    <View style={{ width }} className="flex-1 justify-center px-8">
      <Animated.View style={{ opacity, transform: [{ translateY }] }}>
        <Text className="mb-3 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
          {t('framing.eyebrow')}
        </Text>
        <Text className="font-serif-bold-italic text-5xl leading-[1.05] tracking-[-0.5px]">
          {t('framing.tagline')}
        </Text>
        <View className="mt-6 h-px w-12 bg-black" />
      </Animated.View>
    </View>
  );
}

/**
 * Slide 2 — activation. Asks "How many are you cooking for?" with a
 * stepper. The user's pick is held in parent state and committed when
 * they tap "Get started" (or top-right Skip with the default).
 *
 * Stepper styling matches the pattern from BatchCountSheet — large
 * centered number with circular +/- buttons at typical hit-target size.
 */
function ActivationSlide({
  width,
  active,
  value,
  onChange,
  t,
}: {
  width: number;
  active: boolean;
  value: number;
  onChange: (v: number) => void;
  t: ReturnType<typeof useTranslation<'onboarding'>>['t'];
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;
  useEffect(() => {
    if (!active) return;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [active, opacity, translateY]);

  const canDec = value > HOUSEHOLD_MIN;
  const canInc = value < HOUSEHOLD_MAX;

  return (
    <View style={{ width }} className="flex-1 justify-center px-8">
      <Animated.View style={{ opacity, transform: [{ translateY }] }}>
        <Text className="mb-3 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
          {t('activation.eyebrow')}
        </Text>
        <Text className="font-serif-bold-italic text-5xl leading-[1.05] tracking-[-0.5px]">
          {t('activation.headline')}
        </Text>
        <View className="mt-6 h-px w-12 bg-black" />

        <View className="mt-10 flex-row items-center">
          <Pressable
            onPress={() => canDec && onChange(value - 1)}
            disabled={!canDec}
            hitSlop={6}
            className={`h-14 w-14 items-center justify-center rounded-full border ${
              canDec ? 'border-gray-400' : 'border-gray-200'
            }`}
          >
            <Text
              className={`text-2xl ${
                canDec ? 'text-gray-900' : 'text-gray-300'
              }`}
            >
              −
            </Text>
          </Pressable>
          <Text className="mx-8 min-w-[60px] text-center font-serif-medium text-6xl">
            {value}
          </Text>
          <Pressable
            onPress={() => canInc && onChange(value + 1)}
            disabled={!canInc}
            hitSlop={6}
            className={`h-14 w-14 items-center justify-center rounded-full border ${
              canInc ? 'border-gray-400' : 'border-gray-200'
            }`}
          >
            {/* Chrome glyph — eslint-plugin-i18next's \w+ tokenizer
                flags ASCII plus the same way it does in the other
                steppers (recipe-picker, batch-count-sheet). Inline
                ignore is the established pattern. */}
            {/* eslint-disable i18next/no-literal-string */}
            <Text
              className={`text-2xl ${
                canInc ? 'text-gray-900' : 'text-gray-300'
              }`}
            >
              +
            </Text>
            {/* eslint-enable i18next/no-literal-string */}
          </Pressable>
        </View>

        <Text className="mt-6 max-w-[40ch] font-serif text-base italic text-gray-600">
          {t('activation.hint')}
        </Text>
      </Animated.View>
    </View>
  );
}
