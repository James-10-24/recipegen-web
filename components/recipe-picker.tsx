import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { MEAL_TYPES, MealType } from '@/lib/queries/meal-plans';
import { useProfile } from '@/lib/queries/profile';
import { useRecipesList } from '@/lib/queries/recipes';

type PickableRecipe = {
  id: string;
  title: string;
  servings: number;
};

/**
 * What the picker is editing — drives which pinned rows show and how the
 * commit button reads.
 *
 *  · empty    — tapping a fresh meal slot. Picker shows recipes + the
 *               "Eating out / skip" pinned row.
 *  · recipe   — slot already has a recipe assigned. Picker shows the
 *               current pick highlighted in the list + pinned rows for
 *               "Eating out / skip" and "Remove from plan." Submitting
 *               replaces the existing assignment.
 *  · no_cook  — slot already has a no_cook flag. Picker shows recipes
 *               (to switch back to cooking) + a pinned "Remove from
 *               plan" exit. No "Eating out / skip" row — that's the
 *               current state.
 *  · leftover — slot is a derived leftover from a batch cook earlier in
 *               the week. Picker behaves like empty for selection (any
 *               choice replaces this day) but surfaces source context
 *               in the header so the user knows what they're overriding.
 *               Caller handles the meals_count shrink invisibly.
 */
export type RecipePickerContext =
  | { kind: 'empty' }
  | { kind: 'recipe'; recipe_id: string; servings: number }
  | { kind: 'no_cook' }
  | {
      kind: 'leftover';
      sourceDate: string; // YYYY-MM-DD of the cook day this leftover came from
      sourceTitle: string; // recipe name on the source cook day
    };

/** What the user committed to. Caller maps to assign / replace / delete. */
export type RecipePickerSelection =
  | { kind: 'recipe'; recipe_id: string; servings: number }
  | { kind: 'no_cook' }
  | { kind: 'remove' };

type Props = {
  visible: boolean;
  onClose: () => void;
  initialMealType?: MealType;
  /** Slot context — defaults to empty if omitted. */
  context?: RecipePickerContext;
  onSubmit: (input: {
    meal_type: MealType;
    selection: RecipePickerSelection;
  }) => Promise<void> | void;
  onCreateNew?: () => void;
};

/** Internal pinned-row identity — matches the RecipePickerSelection kinds
 *  that aren't recipes. */
type PinnedKind = 'no_cook' | 'remove';

function pinnedRowsFor(context: RecipePickerContext): PinnedKind[] {
  switch (context.kind) {
    case 'empty':
      return ['no_cook'];
    case 'recipe':
      return ['no_cook', 'remove'];
    case 'no_cook':
      // Already no_cook — surfacing "Eating out / skip" again would be
      // redundant. Only show the explicit Remove exit.
      return ['remove'];
    case 'leftover':
      return ['no_cook'];
  }
}

export function RecipePicker({
  visible,
  onClose,
  initialMealType,
  context: rawContext,
  onSubmit,
  onCreateNew,
}: Props) {
  const context: RecipePickerContext = rawContext ?? { kind: 'empty' };
  const profile = useProfile();
  const recipes = useRecipesList();
  const { t } = useTranslation('plan');
  const { t: tCommon } = useTranslation('common');

  // Translated meal-type label via switch (typed-keys safety; same
  // pattern as plan.tsx's MealSlot). Used by the meal-type chip row.
  const mealLabel = (mt: MealType): string => {
    switch (mt) {
      case 'breakfast': return t('mealTypes.breakfast');
      case 'lunch': return t('mealTypes.lunch');
      case 'dinner': return t('mealTypes.dinner');
      case 'snack': return t('mealTypes.snack');
    }
  };
  const [mealType, setMealType] = useState<MealType>(initialMealType ?? 'dinner');
  // Default servings used as the seed when the user picks a recipe. If the
  // context is an existing recipe assignment, prefill with the current
  // servings so the user doesn't have to re-enter.
  const [defaultServings, setDefaultServings] = useState(2);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<RecipePickerSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed selection from context on open so the user can see what the slot
  // currently has and either tap the same row (no-op semantic) or pick
  // something different. Empty/leftover open with no selection.
  useEffect(() => {
    if (!visible) return;
    const seed = profile.data?.household_size ?? 2;
    setMealType(initialMealType ?? 'dinner');
    setQuery('');
    if (context.kind === 'recipe') {
      setDefaultServings(context.servings);
      setSelection({
        kind: 'recipe',
        recipe_id: context.recipe_id,
        servings: context.servings,
      });
    } else if (context.kind === 'no_cook') {
      setDefaultServings(seed);
      setSelection({ kind: 'no_cook' });
    } else {
      setDefaultServings(seed);
      setSelection(null);
    }
    // visible alone is the trigger — context/initialMealType changes while
    // closed shouldn't reset anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const selectRecipe = (id: string) => {
    setSelection((prev) => {
      // Tapping the currently-selected recipe is a no-op (preserves the
      // user-adjusted servings).
      if (prev?.kind === 'recipe' && prev.recipe_id === id) return prev;
      return { kind: 'recipe', recipe_id: id, servings: defaultServings };
    });
  };

  const selectPinned = (kind: PinnedKind) => {
    setSelection({ kind });
  };

  const bumpServings = (delta: number) => {
    setSelection((prev) => {
      if (prev?.kind !== 'recipe') return prev;
      return { ...prev, servings: Math.max(1, prev.servings + delta) };
    });
  };

  const filtered = useMemo<PickableRecipe[]>(() => {
    const list = (recipes.data ?? []) as PickableRecipe[];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => r.title.toLowerCase().includes(q));
  }, [recipes.data, query]);

  const recent = useMemo<PickableRecipe[]>(
    () => ((recipes.data ?? []) as PickableRecipe[]).slice(0, 6),
    [recipes.data],
  );

  const showingRecent = query.trim().length === 0;
  const pinned = pinnedRowsFor(context);

  // Resolve the recipe title for the commit button + leftover header so we
  // can read "Replace with Lasagne" not "Replace with the selected recipe."
  const selectedRecipeTitle = useMemo(() => {
    if (selection?.kind !== 'recipe') return null;
    const row = (recipes.data ?? []).find((r) => r.id === selection.recipe_id);
    return row?.title ?? null;
  }, [selection, recipes.data]);

  // Commit button is enabled when a selection differs from the current
  // context (or when context is empty/leftover and any selection is made).
  const isNoOp = useMemo(() => {
    if (!selection) return true;
    if (context.kind === 'recipe' && selection.kind === 'recipe') {
      return (
        selection.recipe_id === context.recipe_id &&
        selection.servings === context.servings
      );
    }
    if (context.kind === 'no_cook' && selection.kind === 'no_cook') return true;
    return false;
  }, [selection, context]);

  const commitLabel = (() => {
    if (!selection) return t('picker.commit.pickSomething');
    if (selection.kind === 'remove') return t('picker.commit.removeFromPlan');
    if (selection.kind === 'no_cook') return t('picker.commit.markNoCook');
    // recipe
    if (context.kind === 'recipe' || context.kind === 'no_cook') {
      return selectedRecipeTitle
        ? t('picker.commit.replaceWith', { title: selectedRecipeTitle })
        : t('picker.commit.replaceGeneric');
    }
    return selectedRecipeTitle
      ? t('picker.commit.addNamed', { title: selectedRecipeTitle })
      : t('picker.commit.addGeneric');
  })();

  const handleSubmit = async () => {
    if (!selection || isNoOp) return;
    setSubmitting(true);
    try {
      await onSubmit({ meal_type: mealType, selection });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  const titleByContext = (() => {
    switch (context.kind) {
      case 'empty':
        return t('picker.titleEmpty');
      case 'recipe':
        return t('picker.titleChange');
      case 'no_cook':
        return t('picker.titleChange');
      case 'leftover':
        return t('picker.titleLeftover');
    }
  })();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View className="flex-1 bg-white">
        <View className="flex-row items-center justify-between border-b border-gray-100 px-5 pb-3 pt-4">
          <View className="flex-1 pr-3">
            <Text className="font-serif-bold text-xl">{titleByContext}</Text>
            {context.kind === 'leftover' ? (
              <Text className="mt-0.5 text-[11px] uppercase tracking-[2px] text-gray-500">
                {t('picker.leftoverFromPrefix')}
                <Text className="text-terracotta-600">{context.sourceTitle}</Text>
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
              {tCommon('cancel')}
            </Text>
          </Pressable>
        </View>

        <View className="px-5 pt-5">
          <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('picker.mealTypeEyebrow')}
          </Text>
          <View className="mb-5 flex-row gap-2">
            {MEAL_TYPES.map((m) => {
              const active = mealType === m;
              return (
                <Pressable
                  key={m}
                  onPress={() => setMealType(m)}
                  className={`rounded-full border px-3 py-1.5 ${
                    active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                  }`}
                >
                  <Text
                    className={`text-xs font-medium ${
                      active ? 'text-white' : 'text-gray-700'
                    }`}
                  >
                    {mealLabel(m)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('picker.servingsEyebrow')}
          </Text>
          <View className="mb-5 flex-row items-center">
            <Pressable
              onPress={() => {
                setDefaultServings((s) => Math.max(1, s - 1));
                bumpServings(-1);
              }}
              className="h-10 w-10 items-center justify-center rounded-full border border-gray-300"
              hitSlop={4}
            >
              <Text className="text-lg">−</Text>
            </Pressable>
            <Text className="mx-5 min-w-[32px] text-center font-serif-medium text-2xl">
              {selection?.kind === 'recipe' ? selection.servings : defaultServings}
            </Text>
            <Pressable
              onPress={() => {
                setDefaultServings((s) => s + 1);
                bumpServings(1);
              }}
              className="h-10 w-10 items-center justify-center rounded-full border border-gray-300"
              hitSlop={4}
            >
              {/* Chrome glyph — pairs with the "−" above. eslint-plugin-i18next's
                  word extractor doesn't catch single ASCII operators the way it
                  does Unicode minus, so this one needs the inline ignore. */}
              {/* eslint-disable-next-line i18next/no-literal-string */}
              <Text className="text-lg">+</Text>
            </Pressable>
          </View>

          <TextInput
            className="mb-2 rounded-lg border border-gray-300 px-4 py-3 text-base"
            placeholder={t('picker.searchPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
          />

          {onCreateNew && (
            <Pressable onPress={onCreateNew} hitSlop={4} className="mb-1 py-2">
              <Text className="font-serif text-base text-gray-900 underline">
                {t('picker.createNew')}
              </Text>
            </Pressable>
          )}
        </View>

        {recipes.isLoading ? (
          <View className="mt-10 items-center">
            <ActivityIndicator />
          </View>
        ) : (
          <FlatList
            data={showingRecent ? recent : filtered}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 120 }}
            ItemSeparatorComponent={() => <View className="h-px bg-gray-100" />}
            ListHeaderComponent={
              <View>
                {/* Pinned rows: surfaced before the recipe list so the
                    no_cook / remove exits are equally discoverable as
                    picking a recipe. Tap = select; commit via bottom button. */}
                {pinned.map((kind) => {
                  const isSelected = selection?.kind === kind;
                  const label =
                    kind === 'no_cook'
                      ? t('picker.pinned.noCookLabel')
                      : t('picker.pinned.removeLabel');
                  const subtitle =
                    kind === 'no_cook'
                      ? t('picker.pinned.noCookSubtitle')
                      : t('picker.pinned.removeSubtitle');
                  return (
                    <Pressable
                      key={kind}
                      onPress={() => selectPinned(kind)}
                      className="border-b border-gray-100 py-3"
                    >
                      <View className="flex-row items-center justify-between">
                        <View className="flex-1 pr-3">
                          <Text
                            className={`font-serif text-base italic ${
                              kind === 'remove' ? 'text-red-600' : 'text-gray-900'
                            }`}
                          >
                            {label}
                          </Text>
                          <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-500">
                            {subtitle}
                          </Text>
                        </View>
                        <View
                          className={`h-5 w-5 items-center justify-center rounded-full border ${
                            isSelected ? 'border-black bg-black' : 'border-gray-400 bg-white'
                          }`}
                        >
                          {isSelected ? (
                            <View className="h-2 w-2 rounded-full bg-white" />
                          ) : null}
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
                <Text className="mb-2 mt-3 text-[11px] uppercase tracking-[2px] text-gray-500">
                  {showingRecent
                    ? t('picker.recentEyebrow')
                    : t('picker.resultsEyebrow', { count: filtered.length })}
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const isSelected =
                selection?.kind === 'recipe' && selection.recipe_id === item.id;
              const isCurrent =
                context.kind === 'recipe' && context.recipe_id === item.id;
              return (
                <View className="py-3">
                  <Pressable
                    onPress={() => selectRecipe(item.id)}
                    className="flex-row items-center justify-between"
                  >
                    <View className="flex-1 pr-3">
                      <Text className="font-serif text-base">{item.title}</Text>
                      {isCurrent ? (
                        <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-500">
                          {t('picker.currentPick')}
                        </Text>
                      ) : null}
                    </View>
                    <View
                      className={`h-5 w-5 items-center justify-center rounded-full border ${
                        isSelected ? 'border-black bg-black' : 'border-gray-400 bg-white'
                      }`}
                    >
                      {isSelected ? (
                        <View className="h-2 w-2 rounded-full bg-white" />
                      ) : null}
                    </View>
                  </Pressable>
                </View>
              );
            }}
            ListEmptyComponent={
              // Editorial empty states matching the established voice
              // elsewhere (italic Fraunces headline + small leading body).
              // Two cases — searched-and-found-nothing vs no-recipes-yet —
              // get distinct copy so the user knows whether to clear the
              // search or take a different action.
              query ? (
                <View className="items-center py-10">
                  <Text className="font-serif text-xl italic text-gray-400">
                    {t('picker.emptySearch.headline')}
                  </Text>
                  <Text className="mt-2 max-w-[32ch] text-center text-sm text-gray-500">
                    {t('picker.emptySearch.body')}
                  </Text>
                </View>
              ) : (
                <View className="items-center py-10">
                  <Text className="font-serif text-xl italic text-gray-400">
                    {t('picker.emptyLibrary.headline')}
                  </Text>
                  <Text className="mt-2 max-w-[32ch] text-center text-sm text-gray-500">
                    {t('picker.emptyLibrary.body')}
                  </Text>
                </View>
              )
            }
          />
        )}

        <View className="absolute inset-x-0 bottom-0 border-t border-gray-100 bg-white px-5 pb-8 pt-3">
          <Pressable
            onPress={handleSubmit}
            disabled={!selection || isNoOp || submitting}
            className={`items-center rounded-lg py-3 ${
              !selection || isNoOp
                ? 'bg-gray-300'
                : selection.kind === 'remove'
                  ? 'bg-red-600'
                  : 'bg-black'
            }`}
          >
            {submitting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text
                className={`text-base font-semibold ${
                  !selection || isNoOp ? 'text-gray-600' : 'text-white'
                }`}
              >
                {commitLabel}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
