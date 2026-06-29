import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { addDays, toISODate } from '@/lib/dates';

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export const MEAL_TYPE_ORDER: Record<MealType, number> = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
  snack: 3,
};

/** Plan kind — 'recipe' = cook a recipe, 'no_cook' = explicitly not
 *  cooking (eating out, takeaway, skipping meal). The shopping list
 *  filters by kind='recipe' so no_cook slots don't generate purchases. */
export type MealPlanKind = 'recipe' | 'no_cook';

export type MealPlanRow = {
  id: string;
  date: string; // YYYY-MM-DD
  meal_type: MealType;
  /** Null for no_cook rows (eating out / skip). */
  recipe_id: string | null;
  servings_override: number | null;
  /** Number of meals this single cook covers. Default 1; max 7. The
   *  row represents the COOK event; subsequent slots up to date +
   *  meals_count - 1 are leftover-derived (no DB rows for them). */
  meals_count: number;
  kind: MealPlanKind;
  /** Null for no_cook rows. Empty string for rows pointing at a
   *  deleted recipe — caller renders "(deleted)" or similar. */
  recipe_title: string | null;
  recipe_servings: number | null;
  /** True when at least one cook_log row references this meal_plan row
   *  via meal_plan_id. Drives the past-week cook-history rendering
   *  (cooked = positive annotation; not-cooked + past = muted title).
   *  Always false on future slots — cook hasn't happened yet. */
  cooked: boolean;
};

export const mealPlanKeys = {
  all: ['meal-plans'] as const,
  week: (weekStartISO: string) => [...mealPlanKeys.all, 'week', weekStartISO] as const,
  recentRecipes: ['recent-recipes'] as const,
};

export function useMealPlansForWeek(weekStart: Date) {
  const weekStartISO = toISODate(weekStart);
  const weekEndISO = toISODate(addDays(weekStart, 6));
  return useQuery({
    queryKey: mealPlanKeys.week(weekStartISO),
    queryFn: async (): Promise<MealPlanRow[]> => {
      const { data, error } = await supabase
        .from('meal_plans')
        .select(
          `id, date, meal_type, recipe_id, servings_override,
           meals_count, kind, recipes(title, servings)`,
        )
        .gte('date', weekStartISO)
        .lte('date', weekEndISO)
        .order('date', { ascending: true });
      if (error) throw error;
      const rows = data ?? [];

      // Second query: which of these plan rows have a cook_log entry
      // linked by meal_plan_id? Done as a separate IN(...) lookup rather
      // than a Supabase embedded select so we don't depend on FK naming.
      // Cheap — one round-trip with a single small IN clause; only the
      // ids that we already fetched. The cooked Set is consumed in the
      // map below to set MealPlanRow.cooked per row.
      const planIds = rows.map((r: any) => r.id as string);
      let cookedIds = new Set<string>();
      if (planIds.length > 0) {
        const { data: cookLogs, error: clErr } = await supabase
          .from('cook_log')
          .select('meal_plan_id')
          .in('meal_plan_id', planIds);
        if (clErr) throw clErr;
        cookedIds = new Set(
          (cookLogs ?? [])
            .map((cl: any) => cl.meal_plan_id as string | null)
            .filter((id): id is string => id != null),
        );
      }

      return rows.map((r: any) => ({
        id: r.id,
        date: r.date,
        meal_type: r.meal_type,
        recipe_id: r.recipe_id,
        servings_override: r.servings_override,
        meals_count: r.meals_count ?? 1,
        kind: (r.kind ?? 'recipe') as MealPlanKind,
        recipe_title: r.kind === 'no_cook' ? null : r.recipes?.title ?? '(deleted)',
        recipe_servings: r.kind === 'no_cook' ? null : (r.recipes?.servings ?? 1),
        cooked: cookedIds.has(r.id),
      }));
    },
  });
}

export function useRecentRecipes(limit = 6) {
  return useQuery({
    queryKey: [...mealPlanKeys.recentRecipes, limit],
    staleTime: 30_000,
    queryFn: async () => {
      // Most recently planned or updated recipes owned by user.
      const { data, error } = await supabase
        .from('recipes')
        .select('id, title, servings')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
  });
}

function invalidateWeekContaining(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: mealPlanKeys.all });
}

export function useAssignMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      date: string;
      meal_type: MealType;
      /** Required when kind = 'recipe'; null/omitted for no_cook. */
      recipe_id?: string | null;
      servings_override?: number | null;
      meals_count?: number;
      kind?: MealPlanKind;
    }) => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');
      const kind = input.kind ?? 'recipe';
      const { error } = await supabase.from('meal_plans').insert({
        user_id: user.user.id,
        date: input.date,
        meal_type: input.meal_type,
        recipe_id: kind === 'recipe' ? input.recipe_id : null,
        servings_override: input.servings_override ?? null,
        meals_count: kind === 'recipe' ? Math.max(1, input.meals_count ?? 1) : 1,
        kind,
      });
      if (error) throw error;
    },
    onSuccess: () => invalidateWeekContaining(qc),
  });
}

export function useUpdateMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      servings_override?: number | null;
      meals_count?: number;
    }) => {
      const patch: Record<string, unknown> = {};
      if (input.servings_override !== undefined) {
        patch.servings_override = input.servings_override;
      }
      if (input.meals_count !== undefined) {
        patch.meals_count = Math.max(1, input.meals_count);
      }
      const { error } = await supabase
        .from('meal_plans')
        .update(patch)
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => invalidateWeekContaining(qc),
  });
}

/** Copy a previous week's plan forward into this week. Skip any
 *  (date, meal_type) slots that are already occupied. Returns the
 *  number of rows inserted. */
export function useCopyWeek() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      sourceWeekStart: string; // YYYY-MM-DD
      targetWeekStart: string; // YYYY-MM-DD
    }): Promise<number> => {
      const { data, error } = await supabase.rpc('copy_meal_plan_week', {
        p_source_week_start: input.sourceWeekStart,
        p_target_week_start: input.targetWeekStart,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
    onSuccess: () => invalidateWeekContaining(qc),
  });
}

export function useDeleteMeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('meal_plans').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateWeekContaining(qc),
  });
}
