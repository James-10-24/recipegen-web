import * as Haptics from 'expo-haptics';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useQueryClient } from '@tanstack/react-query';

import { defaultStep, roundQty } from '@/lib/pantry-step-defaults';
import {
  PantryItem,
  PantryLocation,
  pantryKeys,
  useAdjustPantryQty,
  usePantryList,
} from '@/lib/queries/pantry';

const EXPIRY_WARN_DAYS = 3;

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(iso + 'T00:00:00');
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

type Section = {
  key: string;
  /** Discriminator for the section header — translated at render time. */
  kind: 'expiring' | PantryLocation;
  warn?: boolean;
  items: PantryItem[];
};

function sectionize(items: PantryItem[]): Section[] {
  const expiring: PantryItem[] = [];
  const byLoc = new Map<PantryLocation, PantryItem[]>();
  for (const item of items) {
    const d = daysUntil(item.expires_at);
    if (d !== null && d <= EXPIRY_WARN_DAYS) {
      expiring.push(item);
      continue;
    }
    const arr = byLoc.get(item.location) ?? [];
    arr.push(item);
    byLoc.set(item.location, arr);
  }
  // Cluster Other items by their free-text location detail so same-named
  // spots (e.g. "garage fridge") sit together.
  const other = byLoc.get('other');
  if (other) {
    other.sort((a, b) => {
      const ad = (a.location_detail ?? '').toLowerCase();
      const bd = (b.location_detail ?? '').toLowerCase();
      if (ad === bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return ad.localeCompare(bd);
    });
  }
  const sections: Section[] = [];
  if (expiring.length) {
    sections.push({ key: 'expiring', kind: 'expiring', warn: true, items: expiring });
  }
  for (const loc of ['fridge', 'freezer', 'pantry', 'other'] as PantryLocation[]) {
    const arr = byLoc.get(loc);
    if (arr?.length) {
      sections.push({ key: loc, kind: loc, items: arr });
    }
  }
  return sections;
}

function SectionBlock({
  section,
  index,
  onMinusTap,
  tintItemId,
}: {
  section: Section;
  index: number;
  /** Tap handler for the inline minus stepper on each row. Lives on the
   *  parent screen so the coalescing window + toast can survive scrolling
   *  through the list. */
  onMinusTap: (item: PantryItem) => void;
  /** When this id matches an item's id, render the qty number with a
   *  brief terracotta tint (the 200ms "the action landed" affordance). */
  tintItemId: string | null;
}) {
  const router = useRouter();
  const { t } = useTranslation('pantry');
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;

  // Helpers that need t() — inlined here so the lib pantry helper stays
  // ASCII-only and SectionBlock owns its own translation lookups.
  const locationLabelFor = (loc: PantryLocation): string => {
    switch (loc) {
      case 'fridge': return t('locationLabels.fridge');
      case 'freezer': return t('locationLabels.freezer');
      case 'pantry': return t('locationLabels.pantry');
      case 'other': return t('locationLabels.other');
    }
  };
  const sectionLabel =
    section.kind === 'expiring' ? t('sections.expiringSoon') : locationLabelFor(section.kind);
  const itemLocationLabel = (item: PantryItem): string => {
    if (item.location === 'other' && item.location_detail) {
      return item.location_detail;
    }
    return locationLabelFor(item.location);
  };
  const expiryLabelFor = (iso: string | null): string | null => {
    const d = daysUntil(iso);
    if (d === null) return null;
    if (d < 0) return t('expiry.expiredAgo', { count: -d });
    if (d === 0) return t('expiry.today');
    if (d === 1) return t('expiry.tomorrow');
    return t('expiry.inDays', { count: d });
  };

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 280,
        delay: index * 60,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 280,
        delay: index * 60,
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY, index]);

  return (
    <Animated.View
      style={{ opacity, transform: [{ translateY }] }}
      className="mb-8"
    >
      {section.warn ? (
        <View className="mb-3">
          <View className="mb-3 h-px bg-black" />
          <Text className="font-serif text-2xl italic text-black">
            {sectionLabel}
          </Text>
        </View>
      ) : (
        <Text className="mb-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {sectionLabel}
        </Text>
      )}

      {section.items.map((item, i) => {
        const label = expiryLabelFor(item.expires_at);
        const d = daysUntil(item.expires_at);
        const warn = d !== null && d <= EXPIRY_WARN_DAYS;
        const isLast = i === section.items.length - 1;
        return (
          <View key={item.id}>
            <Pressable
              onPress={() => router.push(`/pantry/${item.id}` as any)}
              className="flex-row items-center py-3"
            >
              <View className="flex-1 pr-3">
                {warn && label ? (
                  <>
                    <Text className="font-serif italic text-base text-red-700">
                      {label}
                    </Text>
                    <Text className="mt-1 text-xs text-gray-600">
                      <Text className="font-serif">{item.ingredient_name}</Text>
                      {'  '}
                      <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
                        {itemLocationLabel(item)}
                      </Text>
                    </Text>
                  </>
                ) : (
                  <>
                    <Text className="font-serif text-lg" numberOfLines={1}>
                      {item.ingredient_name}
                    </Text>
                    {section.key === 'other' && item.location_detail ? (
                      <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-400">
                        {item.location_detail}
                      </Text>
                    ) : null}
                    {label ? (
                      <Text className="mt-0.5 text-xs text-gray-500">{label}</Text>
                    ) : null}
                  </>
                )}
              </View>
              {/* Stepper cluster: inline minus button immediately left of
                  the qty/unit number. Numeric quantity stays in system
                  sans for faster scanning; ingredient names are in
                  Fraunces above. */}
              <View className="ml-2 flex-row items-center gap-2">
                <Pressable
                  onPress={(e) => {
                    // Stop the parent Pressable (whole row → detail)
                    // from receiving this tap.
                    e.stopPropagation?.();
                    onMinusTap(item);
                  }}
                  disabled={item.qty <= 0}
                  hitSlop={8}
                  accessibilityLabel={t('row.useSomeA11y', { name: item.ingredient_name })}
                  className={`h-7 w-7 items-center justify-center rounded-full border ${
                    item.qty <= 0
                      ? 'border-gray-200'
                      : 'border-gray-300 bg-white'
                  }`}
                >
                  <Text
                    className={`text-base ${
                      item.qty <= 0 ? 'text-gray-300' : 'text-terracotta-600'
                    }`}
                  >
                    −
                  </Text>
                </Pressable>
                {item.qty <= 0 ? (
                  <Text className="text-[10px] font-semibold uppercase tracking-[2px] text-gray-500">
                    {t('row.outBadge')}
                  </Text>
                ) : (
                  <Text
                    className={`text-base ${
                      tintItemId === item.id
                        ? 'text-terracotta-600'
                        : 'text-gray-900'
                    }`}
                    style={{ fontVariant: ['tabular-nums'] }}
                  >
                    {roundQty(item.qty)}{' '}
                    <Text className="text-sm text-gray-500">{item.unit}</Text>
                  </Text>
                )}
              </View>
            </Pressable>
            {!isLast && <View className="h-px bg-gray-100" />}
          </View>
        );
      })}
    </Animated.View>
  );
}

/** State machine for the coalesced off-recipe-usage deduction window.
 *  Held at the screen level so the toast + timer survive scrolling
 *  through the list. Per-item: tapping minus on a different row
 *  commits the previous pending immediately and starts a new one. */
type PendingDeduction = {
  pantryItemId: string;
  ingredientName: string;
  totalDeducted: number;
  unit: string;
};

const COALESCE_WINDOW_MS = 4_000;
const TINT_MS = 200;

export default function PantryScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useTranslation('pantry');
  const { data, isLoading, isRefetching, refetch, error } = usePantryList();
  const sections = useMemo(() => sectionize(data ?? []), [data]);
  const adjust = useAdjustPantryQty();

  // ─── Off-recipe usage: coalesced deduct + toast + undo ──────────────
  const [pending, setPending] = useState<PendingDeduction | null>(null);
  const pendingRef = useRef<PendingDeduction | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tintItemId, setTintItemId] = useState<string | null>(null);

  // Toast slide-up animation.
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTranslate = useRef(new Animated.Value(24)).current;
  useEffect(() => {
    if (pending) {
      Animated.parallel([
        Animated.timing(toastOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(toastTranslate, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(toastOpacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(toastTranslate, {
          toValue: 24,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start();
    }
    // Animate only on appearance / disappearance — not on totalDeducted
    // changes within the same pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending != null]);

  /** Fire the server commit for a pending deduction. Cache is already
   *  optimistic; on error the mutation's onError invalidates the list
   *  and the next refetch corrects the UI. */
  const commitPending = useCallback(
    (p: PendingDeduction) => {
      adjust.mutate({ id: p.pantryItemId, delta: -p.totalDeducted });
    },
    [adjust],
  );

  /** Force-commit whatever's pending right now. Called on navigation
   *  away, on app background, and when minus is tapped on a different
   *  item mid-window. */
  const commitPendingNow = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    pendingRef.current = null;
    setPending(null);
    commitPending(p);
  }, [commitPending]);

  /** Tap on the inline minus button for an item. */
  const onMinusTap = useCallback(
    (item: PantryItem) => {
      const step = defaultStep(item.unit);
      const actualDelta = Math.min(step, item.qty);
      if (actualDelta <= 0) {
        // Disabled state already blocks this, but defensive: warn-style
        // haptic so user feels the tap registered but nothing happened.
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Warning,
        );
        return;
      }

      // Confirmation haptic + 200ms tint on the qty number.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (tintTimerRef.current) clearTimeout(tintTimerRef.current);
      setTintItemId(item.id);
      tintTimerRef.current = setTimeout(() => setTintItemId(null), TINT_MS);

      // Optimistic cache update — pantry list reflects the new qty
      // before the server has confirmed (and survives the whole
      // coalescing window with no server call until commit).
      const newQty = roundQty(item.qty - actualDelta);
      qc.setQueryData<PantryItem[]>(pantryKeys.list(), (old) => {
        if (!old) return old;
        return old.map((it) =>
          it.id === item.id ? { ...it, qty: newQty } : it,
        );
      });

      // Coalesce with existing pending OR commit existing + start new.
      const prev = pendingRef.current;
      if (prev && prev.pantryItemId === item.id) {
        const next: PendingDeduction = {
          ...prev,
          totalDeducted: roundQty(prev.totalDeducted + actualDelta),
        };
        pendingRef.current = next;
        setPending(next);
      } else {
        if (prev) commitPending(prev);
        const next: PendingDeduction = {
          pantryItemId: item.id,
          ingredientName: item.ingredient_name,
          totalDeducted: actualDelta,
          unit: item.unit,
        };
        pendingRef.current = next;
        setPending(next);
      }

      // Reset 4-second window.
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = null;
        commitPendingNow();
      }, COALESCE_WINDOW_MS);
    },
    [qc, commitPending, commitPendingNow],
  );

  /** Tap on the Undo button. Reverts the local cache, cancels the
   *  pending timer, never sends a server request. */
  const onUndo = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    qc.setQueryData<PantryItem[]>(pantryKeys.list(), (old) => {
      if (!old) return old;
      return old.map((it) =>
        it.id === p.pantryItemId
          ? { ...it, qty: roundQty(it.qty + p.totalDeducted) }
          : it,
      );
    });
    pendingRef.current = null;
    setPending(null);
  }, [qc]);

  // Clean up timers + commit any pending deduction on unmount. Tab
  // switching keeps the pantry mounted, so this fires only on full
  // unmount (rare in the tab-router). The "commit on tab change" case
  // is handled by the timer naturally expiring during inactivity.
  useEffect(
    () => () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
      if (tintTimerRef.current) clearTimeout(tintTimerRef.current);
      const p = pendingRef.current;
      if (p) commitPending(p);
    },
    [commitPending],
  );

  // After /pantry/snap/review bulk-adds, the review screen redirects
  // here with ?snapAdded=N&snapMerged=M. Surface a brief flash so the
  // user gets feedback that the items landed.
  //
  // Q13 conditional copy:
  //   merged > 0 → "N added · M merged"
  //   merged = 0 → "N added to pantry"
  // First-time users with empty pantry never see the merged suffix; it
  // appears organically once weekly snaps start hitting existing rows.
  const { snapAdded, snapMerged } = useLocalSearchParams<{
    snapAdded?: string;
    snapMerged?: string;
  }>();
  const [snapFlash, setSnapFlash] = useState<{
    added: number;
    merged: number;
  } | null>(null);
  const snapFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const added = Number(snapAdded);
    const merged = Number(snapMerged);
    if (!Number.isFinite(added) || added <= 0) return;
    setSnapFlash({
      added,
      merged: Number.isFinite(merged) ? Math.max(0, merged) : 0,
    });
    if (snapFlashTimer.current) clearTimeout(snapFlashTimer.current);
    // 4s window — long enough to read, short enough to not linger.
    snapFlashTimer.current = setTimeout(() => setSnapFlash(null), 4000);
    router.setParams({ snapAdded: '', snapMerged: '' } as any);
  }, [snapAdded, snapMerged, router]);
  useEffect(
    () => () => {
      if (snapFlashTimer.current) clearTimeout(snapFlashTimer.current);
    },
    [],
  );

  const total = data?.length ?? 0;
  const expiringCount = useMemo(
    () =>
      (data ?? []).filter((i) => {
        const d = daysUntil(i.expires_at);
        return d !== null && d <= EXPIRY_WARN_DAYS;
      }).length,
    [data],
  );

  // Item count plus an optional "· N expiring" suffix. Plural forms
  // are CLDR-routed by i18next (en uses _one/_other; zh-Hans collapses
  // to _other). .toUpperCase() is a no-op for CJK so safe across both
  // languages — the small-caps look comes from the tracking class.
  const headerMeta =
    total === 0
      ? ''
      : `${t('header.items', { count: total })}${
          expiringCount > 0 ? t('header.expiringSuffix', { count: expiringCount }) : ''
        }`.toUpperCase();

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-white">
      <View className="px-6 pb-4 pt-3">
        <View className="flex-row items-center justify-between">
          <Text className="font-serif-bold text-3xl">{t('title')}</Text>
          <View className="flex-row items-center gap-2">
            {/* Snap is the marquee feature — primary visual weight.
                Manual + New is the deterministic fallback, demoted to
                secondary so the user's eye lands on the AI path first. */}
            <Link href="/pantry/new" asChild>
              <Pressable
                hitSlop={8}
                className="rounded-full border border-gray-300 px-3 py-1.5"
              >
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                  {t('header.newButton')}
                </Text>
              </Pressable>
            </Link>
            <Link href="/pantry/snap" asChild>
              <Pressable
                hitSlop={8}
                className="rounded-full border border-black bg-black px-3 py-1.5"
              >
                {/* Word alone — emoji rendering varies across iOS/Android
                    fonts (color glyph vs monochrome) and the black pill
                    is already visually unmistakable. */}
                <Text className="text-[11px] uppercase tracking-[2px] text-white">
                  {t('header.snapButton')}
                </Text>
              </Pressable>
            </Link>
          </View>
        </View>
        {headerMeta ? (
          <Text className="mt-1 text-[11px] uppercase tracking-[2px] text-gray-500">
            {headerMeta}
          </Text>
        ) : null}
        {snapFlash != null ? (
          <Text className="mt-2 text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {snapFlash.merged > 0
              ? t('snapFlash.addedAndMerged', { added: snapFlash.added, merged: snapFlash.merged })
              : t('snapFlash.addedOnly', { added: snapFlash.added })}
          </Text>
        ) : null}
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#000" />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-red-600">{(error as Error).message}</Text>
        </View>
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(s) => s.key}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 48 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor="#000"
              colors={Platform.OS === 'android' ? ['#000'] : undefined}
            />
          }
          ListEmptyComponent={
            <View className="mt-16 items-center px-8">
              <Text className="font-serif text-2xl italic text-gray-400">
                {t('empty.headline')}
              </Text>
              <Text className="mt-3 max-w-[36ch] text-center text-sm leading-5 text-gray-600">
                {t('empty.body')}
              </Text>
              {/* In-block CTAs mirror the header chips so the action is
                  obvious in the user's eye-flow on first install — matches
                  the Recipes tab empty-state pattern. */}
              <View className="mt-5 flex-row items-center gap-4">
                <Link href="/pantry/snap" asChild>
                  <Pressable className="rounded-full border border-black bg-black px-4 py-2">
                    <Text className="text-[11px] uppercase tracking-[2px] text-white">
                      {t('empty.snapCta')}
                    </Text>
                  </Pressable>
                </Link>
                <Link href="/pantry/new" asChild>
                  <Pressable hitSlop={6}>
                    <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                      {t('empty.manualCta')}
                    </Text>
                  </Pressable>
                </Link>
              </View>
            </View>
          }
          renderItem={({ item: section, index }) => (
            <SectionBlock
              section={section}
              index={index}
              onMinusTap={onMinusTap}
              tintItemId={tintItemId}
            />
          )}
        />
      )}

      {/* ─── Off-recipe usage toast (coalesced 4s undo window) ───
          Renders only while a deduction is pending. Slide-up from
          below + fade. Tapping anywhere outside the Undo button does
          nothing — the toast auto-dismisses on commit. */}
      {pending ? (
        <Animated.View
          style={{
            opacity: toastOpacity,
            transform: [{ translateY: toastTranslate }],
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 24,
            zIndex: 50,
          }}
          pointerEvents="box-none"
        >
          <View className="flex-row items-center justify-between rounded-lg bg-black px-4 py-3">
            <Text
              className="flex-1 pr-3 font-serif text-base text-white"
              numberOfLines={1}
            >
              {t('toast.used', {
                qty: roundQty(pending.totalDeducted),
                unit: pending.unit,
                name: pending.ingredientName,
              })}
            </Text>
            <Pressable onPress={onUndo} hitSlop={8}>
              <Text className="text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-400">
                {t('toast.undo')}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </SafeAreaView>
  );
}
