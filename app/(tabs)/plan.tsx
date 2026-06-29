import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  Text,
  UIManager,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  MealPlanRow,
  MealType,
  useAssignMeal,
  useCopyWeek,
  useDeleteMeal,
  useMealPlansForWeek,
  useUpdateMeal,
} from '@/lib/queries/meal-plans';
import {
  RecipePicker,
  type RecipePickerContext,
} from '@/components/recipe-picker';
import { BatchCountSheet } from '@/components/batch-count-sheet';
import {
  addDays,
  isSameDay,
  monthDay,
  startOfWeek,
  toISODate,
  weekRangeLabel,
  weekdayShort,
} from '@/lib/dates';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * What occupies a (date, meal_type) cell in the week grid.
 *
 *  · cook    — explicit row with kind='recipe'. The cooking event happens
 *              on this date. If meals_count > 1, the row also projects
 *              leftovers onto subsequent days.
 *  · leftover — derived cell. No DB row of its own; rendered because a
 *              cook earlier in the week has meals_count > 1 and projects
 *              onto this date. Source row carries the recipe title and
 *              the cook date.
 *  · no_cook — explicit row with kind='no_cook'. User marked the slot as
 *              eating-out / skip.
 *  · empty   — nothing planned. Shows the + chip affordance.
 */
type SlotInfo =
  | { kind: 'cook'; row: MealPlanRow }
  | { kind: 'leftover'; source: MealPlanRow }
  | { kind: 'no_cook'; row: MealPlanRow }
  | { kind: 'empty' };

function slotKey(date: string, meal_type: MealType): string {
  return `${date}|${meal_type}`;
}

/**
 * Build a map of (date, meal_type) → SlotInfo across the week.
 *
 * Two-pass algorithm:
 *   1. Place every explicit row into the map (cook or no_cook).
 *   2. For each cook row with meals_count > 1, project leftovers onto
 *      subsequent days — but never overwrite an explicit row. So if the
 *      user assigned a different recipe to Wednesday, Wednesday stays as
 *      that explicit cook even if Monday's batch would otherwise project
 *      a leftover onto it.
 *
 * This is the rendering algorithm that gives us the "shrink-from-end"
 * semantic on leftover replacement: replacing a middle leftover causes
 * the trailing leftover (the one beyond what's now displayed) to
 * disappear. Acceptable trade-off — most batch cooks are 2-3 meals where
 * this never matters.
 */
function buildSlotMap(rows: MealPlanRow[]): Map<string, SlotInfo> {
  const map = new Map<string, SlotInfo>();
  for (const r of rows) {
    const k = slotKey(r.date, r.meal_type);
    map.set(k, r.kind === 'recipe' ? { kind: 'cook', row: r } : { kind: 'no_cook', row: r });
  }
  for (const r of rows) {
    if (r.kind !== 'recipe' || r.meals_count <= 1) continue;
    const cookDate = new Date(r.date);
    for (let i = 1; i < r.meals_count; i++) {
      const lDate = addDays(cookDate, i);
      const k = slotKey(toISODate(lDate), r.meal_type);
      if (!map.has(k)) {
        map.set(k, { kind: 'leftover', source: r });
      }
    }
  }
  return map;
}

/** Order rendered meal types within a day. Snack is conditional per Q7. */
function mealTypesFor(day: string, snackVisibleDates: Set<string>): MealType[] {
  const base: MealType[] = ['breakfast', 'lunch', 'dinner'];
  if (snackVisibleDates.has(day)) base.push('snack');
  return base;
}

/** Count visible slots for the day's dot-summary in the day-header.
 *  Includes leftovers and no_cook rows because both occupy a slot the
 *  user committed to (planned consumption). Empty doesn't count. */
function visibleCount(
  date: string,
  slotMap: Map<string, SlotInfo>,
  mealTypes: MealType[],
): number {
  let n = 0;
  for (const mt of mealTypes) {
    const info = slotMap.get(slotKey(date, mt));
    if (info && info.kind !== 'empty') n++;
  }
  return n;
}

type IncomingParams = {
  recipeId?: string;
  date?: string;
  mealType?: MealType;
};

/** Context held in plan.tsx state for the active picker session. Carries
 *  what the picker needs to render + what plan.tsx needs to apply the
 *  user's selection on submit. */
type PickerSession = {
  date: string;
  meal_type: MealType;
  pickerContext: RecipePickerContext;
  /** id of the existing row at (date, meal_type), if any. Drives the
   *  delete-then-insert behavior for replacements + the remove exit. */
  currentRowId: string | null;
  /** Source cook row when picker was opened from a leftover slot. Drives
   *  the meals_count shrink. */
  source: { id: string; meals_count: number } | null;
};

/** Switch wrapper for the meal-type → small-caps label. Used in
 *  MealSlot + EmptyCell. Stays statically typed via the t() namespace
 *  augmentation; safer than a dynamic key lookup. */
function useMealLabel() {
  const { t } = useTranslation('plan');
  return (mt: MealType): string => {
    switch (mt) {
      case 'breakfast': return t('mealTypes.breakfast');
      case 'lunch': return t('mealTypes.lunch');
      case 'dinner': return t('mealTypes.dinner');
      case 'snack': return t('mealTypes.snack');
    }
  };
}

/** Memoized localized weekday + month short labels for the date
 *  helpers. Indexed by Date.getDay() / Date.getMonth(). */
function useDateLabels() {
  const { t } = useTranslation('common');
  const weekday = useMemo(
    () => [
      t('dates.weekdayShort.sun'),
      t('dates.weekdayShort.mon'),
      t('dates.weekdayShort.tue'),
      t('dates.weekdayShort.wed'),
      t('dates.weekdayShort.thu'),
      t('dates.weekdayShort.fri'),
      t('dates.weekdayShort.sat'),
    ],
    [t],
  );
  const month = useMemo(
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
  return { weekday, month };
}

export default function PlanScreen() {
  const router = useRouter();
  const incoming = useLocalSearchParams<IncomingParams>();
  const today = useMemo(() => new Date(), []);
  const { t } = useTranslation('plan');
  const dateLabels = useDateLabels();
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [expanded, setExpanded] = useState<string | null>(() => toISODate(today));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [session, setSession] = useState<PickerSession | null>(null);
  /** Per-day snack-row reveal state. Off by default; user opts in per
   *  day via the small "+ Snack" link below dinner. Resets on week-roll
   *  if we ever choose to, but for v1 just persists across week-navigation
   *  while the screen is mounted. */
  const [snackVisibleDates, setSnackVisibleDates] = useState<Set<string>>(() => new Set());
  /** Batch-count stepper sheet — opens when the user taps the "Cooks N
   *  meals · ›" annotation on a cook slot. Carries the row + initial
   *  servings/meals_count values for the sheet to seed. */
  const [batchSession, setBatchSession] = useState<{
    row: MealPlanRow;
    servings: number;
    meals_count: number;
  } | null>(null);

  const { data, isLoading, error } = useMealPlansForWeek(weekStart);
  const assign = useAssignMeal();
  const update = useUpdateMeal();
  const del = useDeleteMeal();
  const copyWeek = useCopyWeek();

  const slotMap = useMemo(() => buildSlotMap(data ?? []), [data]);

  const toggleDay = (iso: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((prev) => (prev === iso ? null : iso));
  };

  const handleShift = (weeks: number) => {
    setWeekStart((w) => addDays(w, weeks * 7));
  };

  const jumpToToday = () => {
    const start = startOfWeek(new Date());
    setWeekStart(start);
    setExpanded(toISODate(new Date()));
  };

  const revealSnack = (iso: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSnackVisibleDates((prev) => {
      const next = new Set(prev);
      next.add(iso);
      return next;
    });
  };

  const openBatchSheet = (row: MealPlanRow) => {
    setBatchSession({
      row,
      servings: row.servings_override ?? row.recipe_servings ?? 1,
      meals_count: row.meals_count,
    });
  };

  /** Hybrid copy-week (Q8): callable from both the empty-state primary
   *  CTA and the persistent toolbar link. RPC skips already-occupied
   *  (date, meal_type) slots so the mid-week call doesn't destroy work. */
  const handleCopyWeek = async () => {
    const sourceWeekStart = toISODate(addDays(weekStart, -7));
    const targetWeekStart = toISODate(weekStart);
    try {
      const count = await copyWeek.mutateAsync({ sourceWeekStart, targetWeekStart });
      if (count === 0) {
        Alert.alert(
          t('alerts.nothingToCopyTitle'),
          t('alerts.nothingToCopyBody'),
        );
      } else {
        Alert.alert(
          t('alerts.copiedTitle', { count }),
          t('alerts.copiedBody'),
        );
      }
    } catch (e: any) {
      Alert.alert(t('alerts.copyFailedTitle'), e?.message ?? t('alerts.unknownError'));
    }
  };

  // Cook-history scaffolding (Q1-Q3 of the cook-history grill):
  // todayISO is the date-string boundary between "editable future" and
  // "read-only past." Slots strictly before todayISO render with the
  // cooked/muted treatment from Q2 and route to recipe-detail on tap
  // per Q3. Memoized off the existing `today` so we don't recompute on
  // every render. Start-of-day comparison — tonight's slot stays
  // editable until midnight.
  const todayISO = useMemo(() => toISODate(today), [today]);
  const isPastDate = (dateISO: string) => dateISO < todayISO;

  /** Map slot state → picker context + session metadata. The single entry
   *  point for any slot-tap interaction. Empty / cook / leftover / no_cook
   *  all route here; the picker handles the editorial differences.
   *
   *  Q3 cook-history lock: past slots short-circuit to recipe-detail
   *  instead of opening the picker. Cook/leftover route to the recipe;
   *  empty/no_cook past slots are no-ops (no destination). */
  const openPickerForSlot = (date: string, meal_type: MealType, info: SlotInfo) => {
    if (isPastDate(date)) {
      if (info.kind === 'cook' && info.row.recipe_id) {
        router.push(`/recipe/${info.row.recipe_id}` as any);
      } else if (info.kind === 'leftover' && info.source.recipe_id) {
        router.push(`/recipe/${info.source.recipe_id}` as any);
      }
      // Past empty / no_cook slots: no-op. History has no recipe to
      // navigate to, and we don't let users retroactively edit
      // past plan entries in v1 (deferred to v1.1 per the grill).
      return;
    }

    let pickerContext: RecipePickerContext;
    let currentRowId: string | null = null;
    let source: PickerSession['source'] = null;

    switch (info.kind) {
      case 'empty':
        pickerContext = { kind: 'empty' };
        break;
      case 'cook':
        pickerContext = {
          kind: 'recipe',
          recipe_id: info.row.recipe_id ?? '',
          servings: info.row.servings_override ?? info.row.recipe_servings ?? 2,
        };
        currentRowId = info.row.id;
        break;
      case 'no_cook':
        pickerContext = { kind: 'no_cook' };
        currentRowId = info.row.id;
        break;
      case 'leftover':
        pickerContext = {
          kind: 'leftover',
          sourceDate: info.source.date,
          sourceTitle: info.source.recipe_title ?? t('deletedRecipe'),
        };
        source = { id: info.source.id, meals_count: info.source.meals_count };
        break;
    }

    setSession({ date, meal_type, pickerContext, currentRowId, source });
    setPickerOpen(true);
  };

  /** Empty-slot quick-add: the chip below an empty meal type fires this. */
  const openPickerEmpty = (date: string, meal_type: MealType) => {
    openPickerForSlot(date, meal_type, { kind: 'empty' });
  };

  // Inbound deep-link from "create new recipe → return to plan". The new
  // recipe lands at the originating (date, meal_type) slot.
  useEffect(() => {
    if (incoming.recipeId && incoming.date && incoming.mealType) {
      setWeekStart(startOfWeek(new Date(incoming.date)));
      setExpanded(incoming.date);
      setSession({
        date: incoming.date,
        meal_type: incoming.mealType,
        pickerContext: {
          kind: 'recipe',
          recipe_id: incoming.recipeId,
          servings: 2,
        },
        currentRowId: null,
        source: null,
      });
      setPickerOpen(true);
      router.setParams({ recipeId: '', date: '', mealType: '' } as any);
    }
  }, [incoming.recipeId, incoming.date, incoming.mealType, router]);

  const thisWeekStart = startOfWeek(today);
  const isCurrentWeek = isSameDay(weekStart, thisWeekStart);

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-white">
      <View className="px-6 pb-4 pt-3">
        <View className="flex-row items-center justify-between">
          <Text className="font-serif-bold text-3xl">
            {weekRangeLabel(weekStart, dateLabels.month)}
          </Text>
          <View className="flex-row items-center gap-5">
            <Pressable onPress={() => handleShift(-1)} hitSlop={10}>
              <Text className="text-2xl text-gray-700">‹</Text>
            </Pressable>
            <Pressable onPress={() => handleShift(1)} hitSlop={10}>
              <Text className="text-2xl text-gray-700">›</Text>
            </Pressable>
          </View>
        </View>
        <View className="mt-1 flex-row items-center justify-between">
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('eyebrow')}
          </Text>
          <View className="flex-row items-center gap-4">
            <Pressable
              onPress={handleCopyWeek}
              disabled={copyWeek.isPending}
              hitSlop={6}
            >
              <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                {copyWeek.isPending ? t('header.copying') : t('header.copyLastWeek')}
              </Text>
            </Pressable>
            {!isCurrentWeek && (
              <Pressable onPress={jumpToToday} hitSlop={6}>
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-900">
                  {t('header.today')}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-red-600">{(error as Error).message}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>
          {Array.from({ length: 7 }).map((_, i) => {
            const date = addDays(weekStart, i);
            const iso = toISODate(date);
            const isToday = isSameDay(date, today);
            const isExpanded = expanded === iso;
            const mealTypes = mealTypesFor(iso, snackVisibleDates);
            const count = visibleCount(iso, slotMap, mealTypes);

            return (
              <View key={iso}>
                <Pressable
                  onPress={() => toggleDay(iso)}
                  className="flex-row items-baseline px-6 py-5"
                >
                  <Text className="w-14 text-[11px] uppercase tracking-[2px] text-gray-500">
                    {weekdayShort(date, dateLabels.weekday)}
                  </Text>
                  <Text className="font-serif-medium text-2xl">{date.getDate()}</Text>
                  <View className="flex-1 flex-row items-center pl-4">
                    {count === 0 ? (
                      <Text className="text-xl text-gray-300">—</Text>
                    ) : (
                      <Text
                        className="text-2xl tracking-[6px] text-gray-900"
                        style={{ lineHeight: 20 }}
                      >
                        {'·'.repeat(count)}
                      </Text>
                    )}
                  </View>
                  {isToday && (
                    <Text className="text-[11px] uppercase tracking-[2px] text-gray-900">
                      {t('header.todayBadge')}
                    </Text>
                  )}
                </Pressable>

                {isExpanded && (
                  <View className="bg-gray-50 px-6 pb-5 pt-1">
                    <Text className="mb-3 text-[11px] uppercase tracking-[2px] text-gray-500">
                      {monthDay(date, dateLabels.month)}
                    </Text>

                    {mealTypes.map((mt) => {
                      const info = slotMap.get(slotKey(iso, mt)) ?? { kind: 'empty' as const };
                      const isPast = isPastDate(iso);
                      return (
                        <MealSlot
                          key={mt}
                          meal_type={mt}
                          info={info}
                          isPast={isPast}
                          onPress={() => openPickerForSlot(iso, mt, info)}
                          onAnnotationPress={
                            // Past cook slots don't open the batch sheet —
                            // batch count is fixed once the cook is logged
                            // (or missed). Annotation becomes a read-only
                            // "✓ COOKED · N MEALS" line in CookCell.
                            info.kind === 'cook' && !isPast
                              ? () => openBatchSheet(info.row)
                              : undefined
                          }
                        />
                      );
                    })}

                    {!snackVisibleDates.has(iso) && (
                      <Pressable
                        onPress={() => revealSnack(iso)}
                        hitSlop={6}
                        className="mt-1 self-start py-1.5"
                      >
                        <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
                          {t('snackReveal')}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                )}

                <View className="h-px bg-gray-100" />
              </View>
            );
          })}

          {(data ?? []).length === 0 && (
            <View className="mt-12 items-center px-8">
              <Text className="font-serif text-2xl italic text-gray-400">
                {t('empty.headline')}
              </Text>
              <Text className="mt-2 max-w-[36ch] text-center text-sm text-gray-500">
                {t('empty.body')}
              </Text>
              <Pressable
                onPress={handleCopyWeek}
                disabled={copyWeek.isPending}
                className={`mt-6 rounded-full px-5 py-2.5 ${
                  copyWeek.isPending ? 'bg-gray-300' : 'bg-black'
                }`}
              >
                <Text className="text-[11px] uppercase tracking-[2px] text-white">
                  {copyWeek.isPending ? t('empty.ctaPending') : t('empty.ctaIdle')}
                </Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      )}

      <RecipePicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        initialMealType={session?.meal_type}
        context={session?.pickerContext}
        onCreateNew={() => {
          if (!session) return;
          const ctx = session;
          setPickerOpen(false);
          router.push({
            pathname: '/recipe/new',
            params: { returnTo: 'plan', date: ctx.date, mealType: ctx.meal_type },
          } as any);
        }}
        onSubmit={async (input) => {
          if (!session) return;
          const sel = input.selection;
          try {
            // ─── Leftover replacement: shrink source meals_count first ────
            // Per the locked Q5 decision: tapping a leftover and picking
            // anything = invisible shrink-by-1 on the source cook + insert
            // a new explicit row for the tapped date. The source's
            // rendering algorithm then projects one fewer leftover.
            if (session.source) {
              const newCount = Math.max(1, session.source.meals_count - 1);
              await update.mutateAsync({
                id: session.source.id,
                meals_count: newCount,
              });
            }

            // ─── Delete-then-insert for replacement on an occupied slot ───
            // The (user, date, meal_type) unique index forbids two rows in
            // the same slot. Replacement = delete the existing row, then
            // insert the new one. Brief race window between delete and
            // insert; acceptable for a single-user single-device flow.
            if (sel.kind === 'remove') {
              if (session.currentRowId) await del.mutateAsync(session.currentRowId);
              return;
            }
            if (session.currentRowId) {
              await del.mutateAsync(session.currentRowId);
            }

            if (sel.kind === 'recipe') {
              await assign.mutateAsync({
                date: session.date,
                meal_type: input.meal_type,
                recipe_id: sel.recipe_id,
                servings_override: sel.servings,
              });
            } else {
              await assign.mutateAsync({
                date: session.date,
                meal_type: input.meal_type,
                kind: 'no_cook',
                recipe_id: null,
              });
            }
          } catch (e: any) {
            Alert.alert(t('alerts.updateFailedTitle'), e?.message ?? t('alerts.unknownError'));
          }
        }}
      />

      {batchSession ? (
        <BatchCountSheet
          visible
          onClose={() => setBatchSession(null)}
          recipeTitle={batchSession.row.recipe_title ?? t('cookCell.deletedTitle')}
          initial={{
            servings: batchSession.servings,
            meals_count: batchSession.meals_count,
          }}
          onSubmit={async (input) => {
            try {
              await update.mutateAsync({
                id: batchSession.row.id,
                servings_override: input.servings,
                meals_count: input.meals_count,
              });
            } catch (e: any) {
              Alert.alert(
                t('alerts.batchSaveFailedTitle'),
                e?.message ?? t('alerts.unknownError'),
              );
            }
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** Single meal slot in the expanded-day view. Branches on SlotInfo.kind
 *  for the editorial treatment: bold cook, italic leftover with provenance
 *  arrow, italic no_cook tag, or hairline empty-state chip.
 *
 *  Two tap targets exist on a cook row:
 *    · Title/servings area → onPress (open picker for replacement)
 *    · "Cooks N meals · ›" annotation → onAnnotationPress (open batch
 *      stepper). Nested Pressable captures the tap before the outer
 *      Pressable's onPress fires.
 */
function MealSlot({
  meal_type,
  info,
  isPast,
  onPress,
  onAnnotationPress,
}: {
  meal_type: MealType;
  info: SlotInfo;
  /** True when this slot's date is strictly before today. Drives the
   *  cook-history rendering branches per Q2 (cooked annotation,
   *  muted not-cooked title, leftover stays unchanged) and the tap
   *  semantic per Q3 (past → recipe detail). */
  isPast: boolean;
  onPress: () => void;
  onAnnotationPress?: () => void;
}) {
  const mealLabel = useMealLabel();
  return (
    <Pressable
      onPress={onPress}
      className="mb-2 flex-row items-baseline rounded-md py-1.5"
    >
      <Text className="w-24 text-[10px] uppercase tracking-[2px] text-gray-500">
        {mealLabel(meal_type)}
      </Text>
      {info.kind === 'cook' ? (
        <CookCell
          row={info.row}
          isPast={isPast}
          onAnnotationPress={onAnnotationPress}
        />
      ) : info.kind === 'leftover' ? (
        <LeftoverCell source={info.source} />
      ) : info.kind === 'no_cook' ? (
        <NoCookCell />
      ) : (
        <EmptyCell label={mealLabel(meal_type)} />
      )}
    </Pressable>
  );
}

function CookCell({
  row,
  isPast,
  onAnnotationPress,
}: {
  row: MealPlanRow;
  isPast: boolean;
  onAnnotationPress?: () => void;
}) {
  const { t } = useTranslation('plan');
  // Cook day annotation branches on whether the date is in the past
  // and whether the cook actually happened:
  //
  //   · Future (or today, not-yet-cooked): "Cooks N meals · ›" with
  //     the chevron, tappable to open the batch-count stepper.
  //     Q9 of the model-coherence grill.
  //   · Past + cooked: "✓ Cooked · N meals" — read-only, no chevron,
  //     no Pressable. Positive annotation per Q2 of cook-history grill.
  //   · Past + not cooked: title rendered in gray-500 (muted) with NO
  //     annotation. Q2 lock — quiet not-cooked, no judgmental "NOT
  //     COOKED" label. The user sees the slot is muted and infers.
  const servings = row.servings_override ?? row.recipe_servings ?? 1;
  const mealsCount = row.meals_count;

  // Past + not cooked: muted title, no annotation. Earliest return so
  // the rest of the branches assume either future or past-cooked.
  if (isPast && !row.cooked) {
    return (
      <View className="flex-1 flex-row items-baseline">
        <View className="flex-1">
          <Text className="font-serif text-base text-gray-500" numberOfLines={1}>
            {row.recipe_title ?? t('cookCell.deletedTitle')}
          </Text>
        </View>
        <Text className="ml-2 text-xs text-gray-400">
          {t('cookCell.servings', { count: servings })}
        </Text>
      </View>
    );
  }

  // Past + cooked OR future-with-or-without cook. The annotation differs:
  // past-cooked is a read-only "✓ Cooked · N meals"; future is the
  // existing tappable "Cooks N meals · ›". Explicit single/multi keys
  // since Chinese CLDR doesn't emit _one — keeping the branch in JS
  // is simpler than fighting i18next plural rules.
  const annotation =
    isPast && row.cooked
      ? mealsCount === 1
        ? t('cookCell.cookedSingleMeal')
        : t('cookCell.cookedMultiMeal', { count: mealsCount })
      : mealsCount === 1
        ? t('cookCell.cooksSingleMeal')
        : t('cookCell.cooksMultiMeal', { count: mealsCount });
  const annotationColor =
    isPast && row.cooked ? 'text-terracotta-600' : 'text-gray-500';

  return (
    <View className="flex-1 flex-row items-baseline">
      <View className="flex-1">
        <Text className="font-serif text-base" numberOfLines={1}>
          {row.recipe_title ?? t('cookCell.deletedTitle')}
        </Text>
        {isPast && row.cooked ? (
          // Read-only annotation — no Pressable, no tap target. The cook
          // happened; nothing to edit retroactively in v1.
          <Text
            className={`mt-0.5 text-[10px] uppercase tracking-[2px] ${annotationColor}`}
          >
            {annotation}
          </Text>
        ) : (
          // Future cook slot — annotation is tappable (opens batch sheet).
          <Pressable
            onPress={onAnnotationPress}
            hitSlop={6}
            className="mt-0.5 self-start"
          >
            <Text
              className={`text-[10px] uppercase tracking-[2px] ${annotationColor}`}
            >
              {annotation}
            </Text>
          </Pressable>
        )}
      </View>
      <Text className="ml-2 text-xs text-gray-500">
        {t('cookCell.servings', { count: servings })}
      </Text>
    </View>
  );
}

function LeftoverCell({ source }: { source: MealPlanRow }) {
  const { t } = useTranslation('plan');
  const dateLabels = useDateLabels();
  // Leftover day: italic-serif title (editorial reference) + small-caps
  // provenance annotation pointing at the cook day. The italic + arrow
  // typographically signals "this is a reference, not a fresh action."
  const sourceDay = useMemo(() => {
    const d = new Date(source.date);
    return weekdayShort(d, dateLabels.weekday).toUpperCase();
  }, [source.date, dateLabels.weekday]);
  return (
    <View className="flex-1">
      <Text className="font-serif text-base italic text-gray-700" numberOfLines={1}>
        {source.recipe_title ?? t('leftover.deletedTitle')}
      </Text>
      <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-500">
        {t('leftover.from', { day: sourceDay })}
      </Text>
    </View>
  );
}

function NoCookCell() {
  const { t } = useTranslation('plan');
  return (
    <View className="flex-1">
      <Text className="font-serif text-base italic text-gray-500">
        {t('noCook')}
      </Text>
    </View>
  );
}

function EmptyCell({ label }: { label: string }) {
  const { t } = useTranslation('plan');
  // Empty cells render as a quiet "+ Label" affordance. Tap on the
  // whole row opens the picker — the chip itself isn't a separate
  // Pressable so the entire row width is the touch target.
  return (
    <View className="flex-1 flex-row items-center">
      <View className="rounded-full border border-gray-300 px-3 py-1">
        <Text className="text-[11px] uppercase tracking-[1.5px] text-gray-700">
          {t('emptyCellPrefix', { label })}
        </Text>
      </View>
    </View>
  );
}

