import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useCookRecipe, type PantryDeduction } from '@/lib/queries/cook';
import { PantryItem, usePantryList } from '@/lib/queries/pantry';
import { RecipeDetail } from '@/lib/queries/recipes';
import { convert } from '@/lib/units';

type Props = {
  visible: boolean;
  onClose: () => void;
  recipe: RecipeDetail;
  servings: number;
  mealPlanId?: string | null;
  /**
   * Number of meals this single cook covers, sourced from the linked
   * meal plan row's meals_count when invoked from a plan slot. When > 1,
   * the cook-sheet surfaces "FROM YOUR PLAN · N MEALS" so the user
   * understands why the servings input is pre-filled with the batch
   * total. Ad-hoc cooks (no plan link) default to 1.
   */
  mealsCount?: number;
  /**
   * Fired on successful cook commit with the new cook_log row id. The
   * parent screen uses this to render the 10-second undo toast per Q11.
   * Receiving the id is also what lets useUndoCookRecipe(id) be wired —
   * no separate fetch needed.
   */
  onCommit?: (cookLogId: string) => void;
};

type PantryMatch = {
  item: PantryItem;
  qtyInRecipeUnit: number | null; // null = can't convert to recipe unit
};

type IngredientRow = {
  ingredient_id: string;
  ingredient_name: string;
  unit: string;
  required: number;
  pantryTotal: number; // sum of convertible matches, in recipe unit
  unconvertibleCount: number;
  matches: PantryMatch[];
  use: string;
};

function round(n: number, dp = 2): number {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

export function CookSheet({
  visible,
  onClose,
  recipe,
  servings,
  mealPlanId,
  mealsCount = 1,
  onCommit,
}: Props) {
  const pantry = usePantryList();
  const cook = useCookRecipe();
  const { t } = useTranslation('recipe-detail');
  const { t: tCommon } = useTranslation('common');

  const ratio = servings / Math.max(1, recipe.servings);

  const [rows, setRows] = useState<IngredientRow[]>([]);

  useEffect(() => {
    if (!visible) return;
    const pantryItems = pantry.data ?? [];
    const next: IngredientRow[] = recipe.ingredients.map((ri) => {
      const density = ri.density_g_per_ml;
      const candidates = pantryItems
        .filter((p) => p.ingredient_id === ri.ingredient_id)
        .sort((a, b) => {
          const ea = a.expires_at ?? '9999';
          const eb = b.expires_at ?? '9999';
          return ea < eb ? -1 : ea > eb ? 1 : 0;
        });

      const matches: PantryMatch[] = candidates.map((item) => {
        const d = density ?? item.ingredient_density_g_per_ml;
        const converted = convert(item.qty, item.unit, ri.unit, d);
        return { item, qtyInRecipeUnit: converted };
      });

      const pantryTotal = matches.reduce(
        (s, m) => s + (m.qtyInRecipeUnit ?? 0),
        0,
      );
      const unconvertibleCount = matches.filter((m) => m.qtyInRecipeUnit === null).length;
      const required = round(ri.qty * ratio, 2);
      const defaultUse = round(Math.min(required, pantryTotal), 2);

      return {
        ingredient_id: ri.ingredient_id,
        ingredient_name: ri.ingredient_name,
        unit: ri.unit,
        required,
        pantryTotal: round(pantryTotal, 2),
        unconvertibleCount,
        matches,
        use: String(defaultUse),
      };
    });
    setRows(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, pantry.data, recipe.id, servings]);

  const handleUseChange = (idx: number, text: string) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, use: text } : r)));
  };

  const handleConfirm = async () => {
    const deductions: PantryDeduction[] = [];
    for (const row of rows) {
      const used = parseFloat(row.use || '0');
      if (!(used > 0)) continue;
      if (used > row.pantryTotal + 1e-6) {
        Alert.alert(
          t('cookSheet.alerts.overDrawTitle'),
          t('cookSheet.alerts.overDrawBody', {
            used,
            unit: row.unit,
            name: row.ingredient_name,
            available: row.pantryTotal,
          }),
        );
        return;
      }
      // Allocate FIFO across convertible matches only.
      let remainingRecipeUnit = used;
      for (const m of row.matches) {
        if (remainingRecipeUnit <= 0) break;
        if (m.qtyInRecipeUnit === null || m.qtyInRecipeUnit <= 0) continue;
        const takeRecipe = Math.min(m.qtyInRecipeUnit, remainingRecipeUnit);
        // Back-convert recipe-unit amount to the pantry item's native unit.
        const takeNative = convert(
          takeRecipe,
          row.unit,
          m.item.unit,
          recipe.ingredients.find((ri) => ri.ingredient_id === row.ingredient_id)
            ?.density_g_per_ml ?? m.item.ingredient_density_g_per_ml,
        );
        if (takeNative === null) continue;
        const newQty = round(Math.max(0, m.item.qty - takeNative), 4);
        deductions.push({ pantry_item_id: m.item.id, new_qty: newQty });
        remainingRecipeUnit = round(remainingRecipeUnit - takeRecipe, 6);
      }
    }

    try {
      const cookLogId = await cook.mutateAsync({
        recipe_id: recipe.id,
        servings,
        meal_plan_id: mealPlanId ?? null,
        deductions,
      });
      // Hand off the log id so the parent can render the 10-second undo
      // toast on whatever screen invoked the sheet. The mutation's
      // onSuccess in cook.ts has already invalidated pantry + cookKeys.
      onCommit?.(cookLogId);
      onClose();
    } catch (e: any) {
      Alert.alert(t('cookSheet.alerts.logFailedTitle'), e.message ?? t('alerts.unknownError'));
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View className="flex-1 bg-white">
        <View className="flex-row items-center justify-between border-b border-gray-100 px-5 pb-3 pt-4">
          <View className="flex-1 pr-3">
            <Text className="font-serif-bold text-xl">{t('cookSheet.title')}</Text>
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('cookSheet.subtitle', { recipeTitle: recipe.title, servings })}
            </Text>
            {mealsCount > 1 ? (
              // Per Q10: surface the plan link so the user understands why
              // servings is pre-filled with the batch total (e.g. 9 = 3
              // servings × 3 meals). Editorial small-caps; doesn't compete
              // with the stepper.
              <Text className="mt-1 text-[10px] uppercase tracking-[2px] text-terracotta-600">
                {t('cookSheet.fromPlanMeals', { count: mealsCount })}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
              {tCommon('cancel')}
            </Text>
          </Pressable>
        </View>

        {pantry.isLoading ? (
          <View className="mt-10 items-center">
            <ActivityIndicator />
          </View>
        ) : rows.length === 0 ? (
          <View className="mt-10 px-6">
            <Text className="font-serif text-base italic text-gray-500">
              {t('cookSheet.emptyIngredients')}
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 120 }}>
            {rows.map((row, idx) => {
              const shortfall = row.required - row.pantryTotal;
              const hasShortfall = shortfall > 1e-6;
              return (
                <View
                  key={`${row.ingredient_id}-${idx}`}
                  className="mb-5 border-b border-gray-100 pb-4"
                >
                  <Text className="font-serif text-lg">{row.ingredient_name}</Text>
                  <Text className="mt-1 text-xs text-gray-500">
                    {t('cookSheet.needLine', {
                      required: row.required,
                      pantry: row.pantryTotal,
                      unit: row.unit,
                    })}
                    {hasShortfall
                      ? t('cookSheet.shortSuffix', {
                          short: round(shortfall, 2),
                          unit: row.unit,
                        })
                      : ''}
                  </Text>
                  {row.unconvertibleCount > 0 && (
                    <Text className="mt-1 text-[11px] uppercase tracking-[1.5px] text-amber-700">
                      {t('cookSheet.unconvertible', { count: row.unconvertibleCount })}
                    </Text>
                  )}
                  <View className="mt-3 flex-row items-center">
                    <Text className="mr-3 text-[11px] uppercase tracking-[2px] text-gray-500">
                      {t('cookSheet.useEyebrow')}
                    </Text>
                    <TextInput
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-base"
                      keyboardType="decimal-pad"
                      value={row.use}
                      onChangeText={(next) => handleUseChange(idx, next)}
                      editable={row.pantryTotal > 0}
                    />
                    <Text className="ml-2 w-12 text-sm text-gray-600">{row.unit}</Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}

        <View className="absolute inset-x-0 bottom-0 border-t border-gray-100 bg-white px-5 pb-8 pt-3">
          <Pressable
            onPress={handleConfirm}
            disabled={cook.isPending}
            className="items-center rounded-lg bg-black py-3"
          >
            {cook.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-base font-semibold text-white">
                {t('cookSheet.confirmCta')}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
