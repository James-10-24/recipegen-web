import { Link, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Swipeable } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  addDays,
  monthDay,
  startOfWeek,
  toISODate,
  weekRangeLabel,
} from '@/lib/dates';
import {
  GroceryListItem,
  useActiveList,
  useCompleteList,
  useDeleteList,
  useEditListItemQty,
  useGenerateList,
  useIsListStale,
  useRemoveListItem,
  useToggleItemChecked,
  useUndoRemoveListItem,
  WasteRisk,
} from '@/lib/queries/grocery';

type Preset = 'thisWeek' | 'nextWeek';

function presetRange(p: Preset): { start: string; end: string } {
  const today = new Date();
  const thisMonday = startOfWeek(today);
  const start = p === 'thisWeek' ? thisMonday : addDays(thisMonday, 7);
  return { start: toISODate(start), end: toISODate(addDays(start, 6)) };
}

// Store-flow ordering. Loosely matches Western supermarket layout:
// produce at the entry, then chilled goods (dairy/meat/seafood), then
// dry goods. This is the order most users physically walk the store
// in, so the list reads as a shopping path.
const CATEGORY_ORDER: Record<string, number> = {
  produce: 0,
  dairy: 1,
  meat: 2,
  seafood: 3,
  grain: 4,
  pantry: 5,
};

type Section = {
  key: string;
  items: GroceryListItem[];
};

/** Group + sort items by category. Labels are translated at render
 *  time inside SectionBlock — this stays pure so it can be a
 *  useMemo dep without re-running on language change. */
function groupByCategory(items: GroceryListItem[]): Section[] {
  const map = new Map<string, GroceryListItem[]>();
  for (const it of items) {
    const key = it.category ?? '__other';
    const arr = map.get(key) ?? [];
    arr.push(it);
    map.set(key, arr);
  }
  const sections = Array.from(map.entries()).map(([key, arr]) => ({
    key,
    // Within each category: unchecked items first (still need to grab),
    // then checked items at the bottom of the section. Within each
    // bucket, alphabetical by ingredient name.
    items: arr.sort((a, b) => {
      const aChecked = a.checked_at ? 1 : 0;
      const bChecked = b.checked_at ? 1 : 0;
      if (aChecked !== bChecked) return aChecked - bChecked;
      return a.ingredient_name.localeCompare(b.ingredient_name);
    }),
  }));
  sections.sort((a, b) => {
    const oa = CATEGORY_ORDER[a.key] ?? 99;
    const ob = CATEGORY_ORDER[b.key] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.key.localeCompare(b.key);
  });
  return sections;
}

/**
 * Q15 — waste annotation. Returns a structured triple (dot color + label
 * + reason copy) for high/medium risk items; null for low.
 *
 * Reasons match the lib's threshold logic (see lib/grocery.ts):
 *   · HIGH:   shelf ≤ 5 days AND excess > 1.8× shortfall → "bulk pack on a {N}-day shelf"
 *   · MED-A:  shelf ≤ 14 days AND excess > 1.4×          → "{X}× more than you'll use"
 *   · MED-B:  shelf null AND excess > 1.8×               → "pack size is generous"
 *
 * When the row carries shelf_life_days (added to GroceryListItem in the
 * grocery-query lib commit alongside this refinement), the high-risk
 * case names the specific shelf life — actionable, not generic. When
 * shelf is null the medium-B reason fires.
 *
 * Color palette: terracotta-600 for high (matches the established
 * editorial accent for emphasis, not the alarmist pure red);
 * amber-600/700 for medium; absent for low (the calm-grid default).
 */
type WasteAnnotation = {
  /** Tailwind text color for the dot — used as a colored Unicode ● glyph. */
  dotColor: string;
  /** Tailwind text color for the label + reason. */
  textColor: string;
  /** Small-caps headline ("Likely waste" / "Might waste"). */
  label: string;
  /** Brief actionable reason after the · separator. */
  reason: string;
};

/** Translated builder. Caller passes t() from useTranslation('shop')
 *  so this stays a pure function (easier to test). Labels + reasons
 *  are interpolated server-style by i18next. */
function wasteAnnotation(
  item: GroceryListItem,
  t: ReturnType<typeof useTranslation<'shop'>>['t'],
): WasteAnnotation | null {
  if (item.waste_risk === 'low') return null;
  const shortfall = Math.max(0, item.needed_qty - item.pantry_qty);
  const ratio = shortfall > 0 ? item.qty_to_buy / shortfall : 1;
  // Round to 1 decimal place so the copy reads "1.4×" not "1.43924×".
  const ratioLabel = `${Math.round(ratio * 10) / 10}×`;
  const shelf = item.shelf_life_days;
  if (item.waste_risk === 'high') {
    return {
      dotColor: 'text-terracotta-600',
      textColor: 'text-terracotta-600',
      label: t('waste.highLabel'),
      reason:
        shelf != null
          ? t('waste.reasonShelfBulk', { days: shelf })
          : t('waste.reasonBulkNoShelf', { ratio: ratioLabel }),
    };
  }
  // Medium: split on whether we have shelf data. The lib's two MEDIUM
  // triggers fire on different conditions — shelf-aware (excess > 1.4×
  // on ≤14d shelf) vs no-shelf (excess > 1.8× when shelf is unknown).
  // Mirror that split in the copy so the user reads a reason that
  // matches what triggered the flag.
  return {
    dotColor: 'text-amber-600',
    textColor: 'text-amber-700',
    label: t('waste.mediumLabel'),
    reason:
      shelf != null
        ? t('waste.reasonShelfRatio', { ratio: ratioLabel })
        : t('waste.reasonNoShelfGenerous'),
  };
}

function round(n: number, dp = 2): number {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

function SectionBlock({
  section,
  index,
  onToggle,
  onRemove,
  onEditQty,
}: {
  section: Section;
  index: number;
  onToggle: (itemId: string, checked: boolean) => void;
  /** Swipe-left "Remove" — user is dropping the item from the list
   *  without buying. Pantry untouched; regen will re-add if the plan
   *  still needs it. Parent handles the Toast undo. */
  onRemove: (item: GroceryListItem) => void;
  /** Tap on qty number — opens the inline edit sheet for this item. */
  onEditQty: (item: GroceryListItem) => void;
}) {
  const { t } = useTranslation('shop');
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(8)).current;

  // Translated category label. Enum keys come from the DB (lowercase
  // 'produce' / 'dairy' / …); '__other' is the null-category bucket.
  // Switch keeps typed-key autocomplete vs. dynamic interpolation.
  const categoryLabel = (key: string): string => {
    switch (key) {
      case 'produce': return t('categoryLabels.produce');
      case 'dairy': return t('categoryLabels.dairy');
      case 'meat': return t('categoryLabels.meat');
      case 'seafood': return t('categoryLabels.seafood');
      case 'grain': return t('categoryLabels.grain');
      case 'pantry': return t('categoryLabels.pantry');
      case '__other':
      default: return t('categoryLabels.other');
    }
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
      <Text className="mb-3 text-[11px] uppercase tracking-[2px] text-gray-500">
        {categoryLabel(section.key)}
      </Text>
      {section.items.map((item, i) => {
        const annotation = wasteAnnotation(item, t);
        const isLast = i === section.items.length - 1;
        const isChecked = !!item.checked_at;
        const hasUnconv = item.unconvertible_count > 0;
        const overridden = item.qty_overridden_by_user;

        // Swipe-left reveals a terracotta-pill "Remove" action. Tap the
        // pill (or finish the swipe past threshold) → onRemove fires
        // and the parent shows a Toast with Undo.
        const renderRightActions = () => (
          <Pressable
            onPress={() => onRemove(item)}
            className="my-1 flex-row items-center justify-center bg-terracotta-600 px-5"
          >
            <Text className="text-[11px] font-semibold uppercase tracking-[2px] text-white">
              {t('row.removeSwipe')}
            </Text>
          </Pressable>
        );

        return (
          <View key={item.id}>
            <Swipeable
              renderRightActions={renderRightActions}
              friction={1.5}
              rightThreshold={40}
              onSwipeableOpen={() => onRemove(item)}
            >
              <Pressable
                onPress={() => onToggle(item.id, !isChecked)}
                className="flex-row items-start bg-white py-3"
              >
                <View
                  className={`mr-3 mt-1 h-5 w-5 items-center justify-center rounded-sm border ${
                    isChecked
                      ? 'border-black bg-black'
                      : 'border-gray-400 bg-white'
                  }`}
                >
                  {isChecked && (
                    <Text className="text-[10px] font-bold text-white">✓</Text>
                  )}
                </View>
                <View className="flex-1 pr-3">
                  <Text
                    className={`font-serif text-lg ${isChecked ? 'text-gray-400 line-through' : 'text-black'}`}
                    numberOfLines={1}
                  >
                    {item.ingredient_name}
                  </Text>
                  {isChecked ? (
                    <Text className="mt-0.5 text-[10px] font-semibold uppercase tracking-[2px] text-forest-700">
                      {t('row.inPantry')}
                    </Text>
                  ) : (
                    <>
                      <Text className="mt-0.5 text-xs text-gray-500">
                        {item.pantry_qty > 0
                          ? t('row.needWithPantry', {
                              qty: round(item.needed_qty),
                              unit: item.unit,
                              pantry: round(item.pantry_qty),
                            })
                          : t('row.needPlain', {
                              qty: round(item.needed_qty),
                              unit: item.unit,
                            })}
                      </Text>
                      {annotation ? (
                        // Q15: colored dot · small-caps label · brief
                        // reason. Three-layer visual hierarchy — glance
                        // sees the dot, saccade sees the label, read
                        // sees the reason. Editorial small-caps tracking
                        // matches the leftover provenance pattern on the
                        // plan tab and the "Cooks N meals" annotation.
                        <View className="mt-0.5 flex-row items-baseline">
                          <Text className={`text-[10px] ${annotation.dotColor}`}>
                            ●
                          </Text>
                          <Text
                            className={`ml-1 text-[10px] uppercase tracking-[2px] ${annotation.textColor}`}
                          >
                            {annotation.label}
                          </Text>
                          <Text className="ml-1 text-[10px] uppercase tracking-[2px] text-gray-500">
                            · {annotation.reason}
                          </Text>
                        </View>
                      ) : null}
                      {hasUnconv ? (
                        // Q16: plain-language "+ Extra for unclear amounts"
                        // replaces the engineering-speak "Unit mismatch ·
                        // estimate only." Gray-500 (informational, not
                        // alarm). No count shown — the action is the same
                        // whether 1 ingredient or 5 was unclear.
                        <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-500">
                          {t('row.extraUnclear')}
                        </Text>
                      ) : null}
                    </>
                  )}
                </View>
                {/* Tap the qty cluster to inline-edit. Hit target is
                    just the qty, not the whole row — preserves the
                    row's existing tap-to-toggle behavior. */}
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation?.();
                    onEditQty(item);
                  }}
                  hitSlop={6}
                  className="ml-2 items-end"
                >
                  <Text
                    className={`text-base ${
                      isChecked
                        ? 'text-gray-400'
                        : overridden
                          ? 'text-terracotta-600'
                          : 'text-gray-900'
                    }`}
                    style={{ fontVariant: ['tabular-nums'] }}
                  >
                    {round(item.qty_to_buy)}{' '}
                    <Text className="text-sm text-gray-500">{item.unit}</Text>
                  </Text>
                  {overridden && !isChecked ? (
                    <Text className="mt-0.5 text-[9px] uppercase tracking-[1.5px] text-terracotta-600">
                      {t('row.editedBadge')}
                    </Text>
                  ) : null}
                </Pressable>
              </Pressable>
            </Swipeable>
            {!isLast && <View className="h-px bg-gray-100" />}
          </View>
        );
      })}
    </Animated.View>
  );
}

/** Held in screen state while the Undo toast is showing. On expiry or
 *  navigate-away, the snapshot is dropped (removal is permanent). On
 *  Undo, the row is re-inserted with this snapshot. */
type RemovedSnapshot = {
  list_id: string;
  ingredient_id: string;
  ingredient_name: string;
  needed_qty: number;
  qty_to_buy: number;
  pantry_qty: number;
  unit: string;
  waste_risk: WasteRisk;
  unconvertible_count: number;
  notes: string | null;
  checked_at: string | null;
  qty_overridden_by_user: boolean;
};

const UNDO_WINDOW_MS = 4_000;

/** Memoized localized weekday + month short labels — same shape as
 *  plan.tsx's useDateLabels. Kept inline here rather than promoted to
 *  a shared lib helper because it's a leaf-of-leaves dependency; if
 *  a third screen needs it, lift then. */
function useShopDateLabels() {
  const { t } = useTranslation('common');
  return useMemo(
    () => [
      t('dates.monthShort.jan'),
      t('dates.monthShort.feb'),
      t('dates.monthShort.mar'),
      t('dates.monthShort.apr'),
      t('dates.monthShort.may'),
      t('dates.monthShort.jun'),
      t('dates.monthShort.jul'),
      t('dates.monthShort.aug'),
      t('dates.monthShort.sep'),
      t('dates.monthShort.oct'),
      t('dates.monthShort.nov'),
      t('dates.monthShort.dec'),
    ],
    [t],
  );
}

export default function ShopScreen() {
  const router = useRouter();
  const { t } = useTranslation('shop');
  const monthLabels = useShopDateLabels();
  const { data, isLoading, isRefetching, refetch, error } = useActiveList();
  const stale = useIsListStale(data);
  const generate = useGenerateList();
  const toggle = useToggleItemChecked();
  const complete = useCompleteList();
  const del = useDeleteList();
  const remove = useRemoveListItem();
  const undoRemove = useUndoRemoveListItem();
  const editQty = useEditListItemQty();

  const [preset, setPreset] = useState<Preset>('thisWeek');

  // ─── Inline qty edit ─────────────────────────────────────────────────
  const [editTarget, setEditTarget] = useState<GroceryListItem | null>(null);
  const [editValue, setEditValue] = useState('');

  const openEdit = (item: GroceryListItem) => {
    setEditTarget(item);
    setEditValue(String(round(item.qty_to_buy)));
  };

  const submitEdit = async () => {
    if (!editTarget) return;
    const parsed = parseFloat(editValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      Alert.alert(
        t('alerts.setToRemoveTitle'),
        t('alerts.setToRemoveBody'),
      );
      return;
    }
    try {
      await editQty.mutateAsync({
        itemId: editTarget.id,
        qtyToBuy: parsed,
      });
      setEditTarget(null);
    } catch (e: any) {
      Alert.alert(t('alerts.saveFailedTitle'), e.message ?? t('alerts.unknownError'));
    }
  };

  // ─── Swipe-remove + Undo toast ───────────────────────────────────────
  const [undoSnap, setUndoSnap] = useState<RemovedSnapshot | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  const toastTranslate = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    if (undoSnap) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoSnap != null]);

  const handleRemove = (item: GroceryListItem) => {
    if (!data) return;
    // Capture the snapshot BEFORE the optimistic mutation lands, so undo
    // can re-insert without re-fetching.
    const snap: RemovedSnapshot = {
      list_id: data.id,
      ingredient_id: item.ingredient_id,
      ingredient_name: item.ingredient_name,
      needed_qty: item.needed_qty,
      qty_to_buy: item.qty_to_buy,
      pantry_qty: item.pantry_qty,
      unit: item.unit,
      waste_risk: item.waste_risk,
      unconvertible_count: item.unconvertible_count,
      notes: item.notes,
      checked_at: item.checked_at,
      qty_overridden_by_user: item.qty_overridden_by_user,
    };
    setUndoSnap(snap);
    remove.mutate(item.id);

    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = setTimeout(() => {
      setUndoSnap(null);
      undoTimerRef.current = null;
    }, UNDO_WINDOW_MS);
  };

  const handleUndo = () => {
    if (!undoSnap) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    const { ingredient_name: _name, ...rest } = undoSnap;
    undoRemove.mutate(rest);
    setUndoSnap(null);
  };

  useEffect(
    () => () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    },
    [],
  );

  const sections = useMemo(() => groupByCategory(data?.items ?? []), [data]);

  const total = data?.items.length ?? 0;
  const checked = data?.items.filter((i) => i.checked_at).length ?? 0;
  const allChecked = total > 0 && checked === total;

  const handleGenerate = async () => {
    const { start, end } = presetRange(preset);
    try {
      await generate.mutateAsync({ rangeStart: start, rangeEnd: end });
    } catch (e: any) {
      Alert.alert(t('alerts.generateFailedTitle'), e.message ?? t('alerts.unknownError'));
    }
  };

  const handleRegenerate = () => {
    Alert.alert(
      t('alerts.regenTitle'),
      t('alerts.regenBody'),
      [
        { text: t('editModal.cancel'), style: 'cancel' },
        { text: t('alerts.regenConfirm'), onPress: handleGenerate },
      ],
    );
  };

  const handleDelete = () => {
    if (!data) return;
    Alert.alert(t('alerts.discardTitle'), undefined, [
      { text: t('editModal.cancel'), style: 'cancel' },
      {
        text: t('alerts.discardConfirm'),
        style: 'destructive',
        onPress: () => del.mutate(data.id),
      },
    ]);
  };

  const handleComplete = () => {
    if (!data) return;
    complete.mutate(data.id);
  };

  const handleToggle = (itemId: string, checked: boolean) => {
    toggle.mutate({ itemId, checked });
  };

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1 }} className="bg-white">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#000" />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={{ flex: 1 }} className="bg-white">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-red-600">{(error as Error).message}</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!data) {
    const r = presetRange(preset);
    const presetLabelFor = (p: Preset): string =>
      p === 'thisWeek' ? t('presets.thisWeek') : t('presets.nextWeek');
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-white">
        <View className="px-6 pb-4 pt-3">
          <View className="flex-row items-center justify-between">
            <Text className="font-serif-bold text-3xl">{t('title')}</Text>
            <Link href="/shop/history" asChild>
              <Pressable hitSlop={8}>
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                  {t('pastListsLink')}
                </Text>
              </Pressable>
            </Link>
          </View>
          <Text className="mt-1 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('subtitle.noList')}
          </Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 24 }}>
          <Text className="font-serif text-2xl italic text-gray-400">
            {t('noList.headline')}
          </Text>
          <Text className="mt-2 text-sm text-gray-600">
            {t('noList.body')}
          </Text>

          <Text className="mb-2 mt-8 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('presets.forEyebrow')}
          </Text>
          <View className="mb-4 flex-row gap-2">
            {(['thisWeek', 'nextWeek'] as Preset[]).map((p) => {
              const active = preset === p;
              const rr = presetRange(p);
              return (
                <Pressable
                  key={p}
                  onPress={() => setPreset(p)}
                  className={`flex-1 rounded-full border px-3 py-3 ${
                    active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                  }`}
                >
                  <Text
                    className={`text-[11px] uppercase tracking-[2px] ${active ? 'text-white' : 'text-gray-700'}`}
                  >
                    {presetLabelFor(p)}
                  </Text>
                  <Text
                    className={`mt-1 text-xs ${active ? 'text-gray-300' : 'text-gray-500'}`}
                  >
                    {t('noList.rangeFooter', {
                      start: monthDay(new Date(rr.start + 'T00:00:00'), monthLabels),
                      end: monthDay(new Date(rr.end + 'T00:00:00'), monthLabels),
                    })}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            onPress={handleGenerate}
            disabled={generate.isPending}
            className="mt-4 items-center rounded-lg border border-black bg-black py-3"
          >
            {generate.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-base font-semibold text-white">
                {t('noList.generate')}
              </Text>
            )}
          </Pressable>

          <Pressable
            onPress={() => router.push('/plan' as any)}
            className="mt-6 items-center py-2"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('noList.nothingPlanned')}
            </Text>
          </Pressable>
          {/* Secondary debug-range hint, kept subtle */}
          <Text className="mt-4 text-center text-[10px] uppercase tracking-[2px] text-gray-300">
            {t('noList.rangeFooter', {
              start: monthDay(new Date(r.start + 'T00:00:00'), monthLabels),
              end: monthDay(new Date(r.end + 'T00:00:00'), monthLabels),
            })}
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Q14 — past-range empty state. When the list's range ended before
  // today, treat it as obsolete: hide the old items, show a primary
  // "Generate for this week" CTA, offer a quiet recovery link to view
  // the archived list via /shop/history. Different severity from
  // inputs-changed (still on the punch list; needs meal_plans.updated_at
  // to land before it can be implemented properly).
  const todayISO = toISODate(new Date());
  const isPastRange = data.range_end < todayISO;
  if (isPastRange) {
    const r = presetRange('thisWeek');
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-white">
        <View className="px-6 pb-4 pt-3">
          <View className="flex-row items-center justify-between">
            <Text className="font-serif-bold text-3xl">{t('title')}</Text>
            <Link href="/shop/history" asChild>
              <Pressable hitSlop={8}>
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                  {t('pastListsLink')}
                </Text>
              </Pressable>
            </Link>
          </View>
          <Text className="mt-1 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('subtitle.pastRange')}
          </Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 24, paddingTop: 24 }}>
          <Text className="font-serif text-2xl italic text-gray-400">
            {t('pastRange.headline')}
          </Text>
          <Text className="mt-2 max-w-[36ch] text-sm leading-5 text-gray-600">
            {t('pastRange.body')}
          </Text>

          <Pressable
            onPress={() => {
              setPreset('thisWeek');
              handleGenerate();
            }}
            disabled={generate.isPending}
            className="mt-6 items-center rounded-lg bg-black py-3"
          >
            {generate.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-base font-semibold text-white">
                {t('pastRange.ctaIdle')}
              </Text>
            )}
          </Pressable>

          {/* Recovery link — preserves access to the archived list for
              users who want to reference what they bought last week.
              Safe default: hide obsolete data from the active surface,
              keep one tap away for reference. */}
          <Link href="/shop/history" asChild>
            <Pressable className="mt-6 items-center py-2" hitSlop={6}>
              <Text className="text-[11px] uppercase tracking-[2px] text-gray-500 underline">
                {t('pastRange.viewArchived')}
              </Text>
            </Pressable>
          </Link>

          <Text className="mt-8 text-center text-[10px] uppercase tracking-[2px] text-gray-300">
            {t('pastRange.newRange', {
              start: monthDay(new Date(r.start + 'T00:00:00'), monthLabels),
              end: monthDay(new Date(r.end + 'T00:00:00'), monthLabels),
            })}
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const rangeStartDate = new Date(data.range_start + 'T00:00:00');
  const rangeLabel = weekRangeLabel(rangeStartDate, monthLabels);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-white">
      <View className="px-6 pb-3 pt-3">
        <View className="flex-row items-center justify-between">
          <Text className="font-serif-bold text-3xl">{t('title')}</Text>
          <Pressable
            onPress={handleRegenerate}
            hitSlop={8}
            className="rounded-full border border-black px-3 py-1.5"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-black">
              {t('active.regenerate')}
            </Text>
          </Pressable>
        </View>
        <View className="mt-1 flex-row items-center justify-between">
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('subtitle.rangeAndProgress', { range: rangeLabel, checked, total })}
          </Text>
          <Link href="/shop/history" asChild>
            <Pressable hitSlop={6}>
              <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
                {t('pastListsLink')}
              </Text>
            </Pressable>
          </Link>
        </View>
      </View>

      {/* Q14 second half — inputs-changed banner. Shows when plan or
          pantry has been updated since the list's generated_at (server-
          side check via useIsListStale → meal_plans.updated_at after
          0027, pantry_items.updated_at since 0001). Editorial small-caps
          headline + italic-serif context + terracotta tracked "Regenerate"
          action. Sits above the FlatList so the user sees it on every
          re-entry to the shop tab without scrolling. */}
      {stale.data && total > 0 ? (
        <View className="mx-6 mb-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <Text className="text-[10px] uppercase tracking-[2px] text-amber-700">
            {t('active.staleHeadline')}
          </Text>
          <Text className="mt-0.5 font-serif text-sm italic text-gray-700">
            {t('active.staleBody')}
          </Text>
          <Pressable
            onPress={handleRegenerate}
            disabled={generate.isPending}
            hitSlop={6}
            className="mt-1 self-start py-1"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-terracotta-600">
              {generate.isPending ? t('active.regeneratePending') : t('active.staleRegen')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {total === 0 ? (
        <ScrollView contentContainerStyle={{ padding: 24 }}>
          <Text className="font-serif text-xl italic text-gray-400">
            {t('active.emptyHeadline')}
          </Text>
          <Text className="mt-2 text-sm text-gray-600">
            {t('active.emptyBody')}
          </Text>
          <Pressable
            onPress={() => router.push('/plan' as any)}
            className="mt-4 py-2"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
              {t('active.checkPlan')}
            </Text>
          </Pressable>
          <Pressable onPress={handleDelete} className="mt-10 items-center py-2">
            <Text className="text-[11px] uppercase tracking-[2px] text-red-600">
              {t('active.discardList')}
            </Text>
          </Pressable>
        </ScrollView>
      ) : (
        <FlatList
          data={sections}
          keyExtractor={(s) => s.key}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 120 }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor="#000"
              colors={Platform.OS === 'android' ? ['#000'] : undefined}
            />
          }
          ListFooterComponent={
            <View className="mt-10">
              {allChecked && (
                <Pressable
                  onPress={handleComplete}
                  disabled={complete.isPending}
                  className="mb-4 items-center rounded-lg bg-black py-3"
                >
                  {complete.isPending ? (
                    <ActivityIndicator color="white" />
                  ) : (
                    <Text className="text-base font-semibold text-white">
                      {t('active.markComplete')}
                    </Text>
                  )}
                </Pressable>
              )}
              <Pressable onPress={handleDelete} className="items-center py-2">
                <Text className="text-[11px] uppercase tracking-[2px] text-red-600">
                  {t('active.discardList')}
                </Text>
              </Pressable>
            </View>
          }
          renderItem={({ item: section, index }) => (
            <SectionBlock
              section={section}
              index={index}
              onToggle={handleToggle}
              onRemove={handleRemove}
              onEditQty={openEdit}
            />
          )}
        />
      )}

      {/* ─── Inline qty-edit modal ─────────────────────────────────── */}
      <Modal
        visible={editTarget != null}
        animationType="fade"
        transparent
        onRequestClose={() => setEditTarget(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <Pressable
            onPress={() => setEditTarget(null)}
            className="flex-1 items-center justify-center bg-black/40 px-6"
          >
            <Pressable className="w-full max-w-sm rounded-2xl bg-white p-6">
              <Text className="mb-1 text-[11px] uppercase tracking-[2px] text-gray-500">
                {t('editModal.eyebrow')}
              </Text>
              <Text className="mb-4 font-serif-bold text-xl">
                {editTarget?.ingredient_name}
              </Text>
              <View className="mb-3 flex-row items-center gap-3">
                <TextInput
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-base"
                  keyboardType="decimal-pad"
                  value={editValue}
                  onChangeText={setEditValue}
                  autoFocus
                  selectTextOnFocus
                />
                <Text className="w-12 text-base text-gray-600">
                  {editTarget?.unit}
                </Text>
              </View>
              {editTarget && !editTarget.qty_overridden_by_user ? (
                <Text className="mb-4 font-serif text-sm italic text-gray-500">
                  {t('editModal.suggested', {
                    qty: round(editTarget.qty_to_buy),
                    unit: editTarget.unit,
                  })}
                </Text>
              ) : (
                <Text className="mb-4 font-serif text-sm italic text-terracotta-600">
                  {t('editModal.overrideNote')}
                </Text>
              )}
              <View className="flex-row justify-end gap-3">
                <Pressable
                  onPress={() => setEditTarget(null)}
                  hitSlop={6}
                  className="px-3 py-2"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
                    {t('editModal.cancel')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={submitEdit}
                  disabled={editQty.isPending}
                  className="rounded-full bg-black px-4 py-2"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-white">
                    {editQty.isPending ? t('editModal.saving') : t('editModal.save')}
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* ─── Undo toast for swipe-remove ────────────────────────────── */}
      {undoSnap ? (
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
              {t('toast.removed', { name: undoSnap.ingredient_name })}
            </Text>
            <Pressable onPress={handleUndo} hitSlop={8}>
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
