import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

/**
 * Sheet for adjusting a cook's batch size + servings — the affordance the
 * "Cooks N meals · ›" annotation on a plan slot opens (Q9 decision).
 *
 * Two intents in one sheet:
 *   · Servings — how many servings does ONE meal of this cook produce.
 *     Drives the shopping list math + the "X servings" line on the slot.
 *   · Meals count — how many days this single cook covers (cook day +
 *     leftovers). 1 = single-meal cook. >1 = leftover spans show up on
 *     subsequent days in the grid. Capped at 7 (a week-spanning batch is
 *     the practical ceiling for the audience).
 *
 * Bound to a specific cook row via the recipe_title display + initial
 * values seeded by the caller. Caller persists via useUpdateMeal.
 */

type Props = {
  visible: boolean;
  onClose: () => void;
  recipeTitle: string;
  initial: { servings: number; meals_count: number };
  onSubmit: (input: { servings: number; meals_count: number }) => Promise<void> | void;
};

const SERVINGS_MIN = 1;
const SERVINGS_MAX = 20;
const MEALS_MIN = 1;
const MEALS_MAX = 7;

export function BatchCountSheet({
  visible,
  onClose,
  recipeTitle,
  initial,
  onSubmit,
}: Props) {
  const [servings, setServings] = useState(initial.servings);
  const [mealsCount, setMealsCount] = useState(initial.meals_count);
  const [submitting, setSubmitting] = useState(false);
  const { t } = useTranslation('plan');
  const { t: tCommon } = useTranslation('common');

  // Seed from `initial` each time the sheet opens. Changes to `initial`
  // while closed shouldn't reset the in-flight edit.
  useEffect(() => {
    if (!visible) return;
    setServings(initial.servings);
    setMealsCount(initial.meals_count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const dirty =
    servings !== initial.servings || mealsCount !== initial.meals_count;

  const handleSubmit = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ servings, meals_count: mealsCount });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-white">
        <View className="flex-row items-center justify-between border-b border-gray-100 px-5 pb-3 pt-4">
          <View className="flex-1 pr-3">
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('batchSheet.eyebrow')}
            </Text>
            <Text className="font-serif-bold text-xl" numberOfLines={1}>
              {recipeTitle}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
              {tCommon('cancel')}
            </Text>
          </Pressable>
        </View>

        <View className="px-6 pt-8">
          {/* Servings — how big is ONE meal */}
          <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('batchSheet.servingsEyebrow')}
          </Text>
          <View className="mb-2 flex-row items-center">
            <Stepper
              value={servings}
              min={SERVINGS_MIN}
              max={SERVINGS_MAX}
              onChange={setServings}
            />
          </View>
          <Text className="mb-8 text-[10px] uppercase tracking-[2px] text-gray-400">
            {t('batchSheet.servingsHint')}
          </Text>

          {/* Meals count — how many days this cook covers */}
          <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('batchSheet.mealsEyebrow')}
          </Text>
          <View className="mb-2 flex-row items-center">
            <Stepper
              value={mealsCount}
              min={MEALS_MIN}
              max={MEALS_MAX}
              onChange={setMealsCount}
            />
            {mealsCount > 1 ? (
              <Text className="ml-4 font-serif text-base italic text-gray-600">
                {t('batchSheet.leftoversLine', { count: mealsCount - 1 })}
              </Text>
            ) : (
              <Text className="ml-4 font-serif text-base italic text-gray-500">
                {t('batchSheet.singleMealCook')}
              </Text>
            )}
          </View>
          <Text className="mb-8 text-[10px] uppercase tracking-[2px] text-gray-400">
            {t('batchSheet.mealsHint')}
          </Text>

          {/* Total servings preview — the math the user is committing to */}
          <View className="mb-8 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
              {t('batchSheet.totalEyebrow')}
            </Text>
            <Text className="mt-1 font-serif-bold text-2xl">
              {t('batchSheet.totalServings', { count: servings * mealsCount })}
            </Text>
            <Text className="mt-1 font-serif text-sm italic text-gray-600">
              {t('batchSheet.totalSubline')}
            </Text>
          </View>
        </View>

        <View className="absolute inset-x-0 bottom-0 border-t border-gray-100 bg-white px-5 pb-8 pt-3">
          <Pressable
            onPress={handleSubmit}
            disabled={submitting}
            className={`items-center rounded-lg py-3 ${
              dirty ? 'bg-black' : 'bg-gray-300'
            }`}
          >
            {submitting ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text
                className={`text-base font-semibold ${
                  dirty ? 'text-white' : 'text-gray-600'
                }`}
              >
                {dirty ? t('batchSheet.save') : t('batchSheet.noChanges')}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const canDec = value > min;
  const canInc = value < max;
  return (
    <View className="flex-row items-center">
      <Pressable
        onPress={() => canDec && onChange(value - 1)}
        disabled={!canDec}
        className={`h-11 w-11 items-center justify-center rounded-full border ${
          canDec ? 'border-gray-400' : 'border-gray-200'
        }`}
        hitSlop={4}
      >
        <Text className={`text-xl ${canDec ? 'text-gray-900' : 'text-gray-300'}`}>−</Text>
      </Pressable>
      <Text className="mx-5 min-w-[36px] text-center font-serif-medium text-3xl">
        {value}
      </Text>
      <Pressable
        onPress={() => canInc && onChange(value + 1)}
        disabled={!canInc}
        className={`h-11 w-11 items-center justify-center rounded-full border ${
          canInc ? 'border-gray-400' : 'border-gray-200'
        }`}
        hitSlop={4}
      >
        {/* Chrome glyph — same eslint-plugin-i18next false-positive as
            recipe-picker's stepper. The plugin's \w+ tokenizer doesn't
            catch the ASCII plus the way it does Unicode minus. */}
        {/* eslint-disable-next-line i18next/no-literal-string */}
        <Text className={`text-xl ${canInc ? 'text-gray-900' : 'text-gray-300'}`}>+</Text>
      </Pressable>
    </View>
  );
}
