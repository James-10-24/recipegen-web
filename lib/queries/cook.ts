import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { mealPlanKeys } from '@/lib/queries/meal-plans';
import { pantryKeys } from '@/lib/queries/pantry';

export type PantryDeduction = {
  pantry_item_id: string;
  new_qty: number;
};

export function useCookRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      recipe_id: string;
      servings: number;
      meal_plan_id?: string | null;
      deductions: PantryDeduction[];
    }): Promise<string> => {
      const { data, error } = await supabase.rpc('cook_recipe', {
        p_recipe_id: input.recipe_id,
        p_servings: input.servings,
        p_meal_plan_id: input.meal_plan_id ?? null,
        p_pantry_deductions: input.deductions,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: pantryKeys.all });
      // Bump the cook stats so the recipe-detail badge updates without
      // a page revisit.
      qc.invalidateQueries({
        queryKey: cookKeys.stats(variables.recipe_id),
      });
      // Invalidate meal-plans so the plan tab's cook-history rendering
      // (cooked annotation + muted-not-cooked branching) refreshes once
      // a new cook_log row lands. Without this the slot would stay in
      // its prior visual state until manual refetch.
      qc.invalidateQueries({ queryKey: mealPlanKeys.all });
    },
  });
}

export const cookKeys = {
  all: ['cook'] as const,
  stats: (recipeId: string) =>
    [...cookKeys.all, 'stats', recipeId] as const,
};

export type CookStats = {
  /** Total cook events ever logged for this recipe by the caller. */
  cookedCount: number;
  /** ISO timestamp of the most recent cook, or null if never. */
  lastCookedAt: string | null;
};

/** Per-recipe cook history aggregated from cook_log. Drives the
 *  "Cooked 7 times · last 4 days ago" line on recipe detail.
 *  Skipped when recipeId is undefined (recipe still loading). */
export function useCookStats(recipeId: string | undefined) {
  return useQuery({
    queryKey: recipeId ? cookKeys.stats(recipeId) : ['cook', 'stats', 'none'],
    enabled: !!recipeId,
    staleTime: 60_000,
    queryFn: async (): Promise<CookStats> => {
      const { data, error } = await supabase
        .from('cook_log')
        .select('cooked_at')
        .eq('recipe_id', recipeId!)
        .order('cooked_at', { ascending: false });
      if (error) throw error;
      const rows = data ?? [];
      return {
        cookedCount: rows.length,
        lastCookedAt: rows[0]?.cooked_at ?? null,
      };
    },
  });
}

/** Undo a recent cook within the toast window. Reverses the pantry
 *  deductions stored on the cook_log row and deletes the row. Atomic
 *  server-side; the client just calls this and lets the cache catch up. */
export function useUndoCookRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cookLogId: string): Promise<void> => {
      const { error } = await supabase.rpc('undo_cook_recipe', {
        p_cook_log_id: cookLogId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pantryKeys.all });
      // Broadcast cook-stats invalidation — we don't know which recipe
      // the cook was for at this point in the call site, so refresh
      // any per-recipe badge that's currently mounted.
      qc.invalidateQueries({ queryKey: cookKeys.all });
      // Same reasoning as useCookRecipe: plan tab needs to flip the
      // cooked annotation back off after undo so the slot returns to
      // its pre-cook visual state.
      qc.invalidateQueries({ queryKey: mealPlanKeys.all });
    },
  });
}

/** Human-friendly relative time for the "last cooked" label. */
export function relativeCookedAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) === 1 ? '' : 's'} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${Math.floor(days / 30) === 1 ? '' : 's'} ago`;
  return `${Math.floor(days / 365)} year${Math.floor(days / 365) === 1 ? '' : 's'} ago`;
}
