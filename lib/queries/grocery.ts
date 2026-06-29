import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert } from 'react-native';

import { generateGroceryList, type GenerateMealPlan } from '@/lib/grocery';
import { pantryKeys } from '@/lib/queries/pantry';
import { supabase } from '@/lib/supabase';

export type WasteRisk = 'low' | 'medium' | 'high';

export type GroceryListItem = {
  id: string;
  ingredient_id: string;
  ingredient_name: string;
  category: string | null;
  needed_qty: number;
  qty_to_buy: number;
  pantry_qty: number;
  unit: string;
  waste_risk: WasteRisk;
  unconvertible_count: number;
  /** Days of shelf life on the ingredient, sourced via the join to
   *  ingredients. Enables the shop tab's shelf-aware waste copy
   *  ("bulk pack on a 5-day shelf") in addition to the generic ratio
   *  copy. Null when the ingredient has no shelf data (canonical or
   *  custom — both can omit it). */
  shelf_life_days: number | null;
  notes: string | null;
  checked_at: string | null;
  /** True when the user tapped the qty number on the list and changed
   *  it. Preserved through regenerate (the user-set value wins). */
  qty_overridden_by_user: boolean;
};

export type CompletedList = {
  id: string;
  range_start: string;
  range_end: string;
  status: 'completed' | 'archived';
  item_count: number;
  completed_at: string;
};

export type ActiveList = {
  id: string;
  range_start: string;
  range_end: string;
  status: 'draft' | 'active' | 'completed' | 'archived';
  created_at: string;
  items: GroceryListItem[];
};

export const groceryKeys = {
  all: ['grocery'] as const,
  active: () => [...groceryKeys.all, 'active'] as const,
  history: () => [...groceryKeys.all, 'history'] as const,
};

async function fetchMealPlansForGeneration(
  rangeStart: string,
  rangeEnd: string,
): Promise<GenerateMealPlan[]> {
  const { data, error } = await supabase
    .from('meal_plans')
    .select(
      `date, servings_override, meals_count, kind,
       recipes (
         id, servings,
         recipe_ingredients (
           ingredient_id, qty, unit,
           ingredients (
             name, category, default_unit,
             package_size, package_unit,
             shelf_life_days, density_g_per_ml
           )
         )
       )`,
    )
    .eq('kind', 'recipe')
    .gte('date', rangeStart)
    .lte('date', rangeEnd);
  if (error) throw error;
  return (data ?? [])
    .filter((r: any) => r.recipes)
    .map((r: any) => ({
      date: r.date,
      servings_override: r.servings_override,
      meals_count: r.meals_count ?? 1,
      recipe: {
        id: r.recipes.id,
        servings: r.recipes.servings,
        ingredients: (r.recipes.recipe_ingredients ?? []).map((ri: any) => ({
          ingredient_id: ri.ingredient_id,
          qty: Number(ri.qty),
          unit: ri.unit,
          ingredient: {
            name: ri.ingredients?.name ?? '',
            category: ri.ingredients?.category ?? null,
            default_unit: ri.ingredients?.default_unit ?? ri.unit,
            package_size: ri.ingredients?.package_size ?? null,
            package_unit: ri.ingredients?.package_unit ?? null,
            shelf_life_days: ri.ingredients?.shelf_life_days ?? null,
            density_g_per_ml: ri.ingredients?.density_g_per_ml ?? null,
          },
        })),
      },
    }));
}

export function useActiveList() {
  return useQuery({
    queryKey: groceryKeys.active(),
    queryFn: async (): Promise<ActiveList | null> => {
      const { data: lists, error } = await supabase
        .from('grocery_lists')
        .select('id, range_start, range_end, status, created_at')
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const list = lists?.[0];
      if (!list) return null;

      const { data: items, error: itemsErr } = await supabase
        .from('grocery_list_items')
        .select(
          `id, ingredient_id, needed_qty, qty_to_buy, pantry_qty, unit,
           waste_risk, unconvertible_count, notes, checked_at,
           qty_overridden_by_user,
           ingredients (name, category, shelf_life_days)`,
        )
        .eq('list_id', list.id);
      if (itemsErr) throw itemsErr;

      return {
        ...list,
        status: list.status as ActiveList['status'],
        items: (items ?? []).map((r: any) => ({
          id: r.id,
          ingredient_id: r.ingredient_id,
          ingredient_name: r.ingredients?.name ?? '(unknown)',
          category: r.ingredients?.category ?? null,
          needed_qty: Number(r.needed_qty),
          qty_to_buy: Number(r.qty_to_buy),
          pantry_qty: Number(r.pantry_qty),
          unit: r.unit,
          waste_risk: r.waste_risk as WasteRisk,
          unconvertible_count: r.unconvertible_count ?? 0,
          shelf_life_days: r.ingredients?.shelf_life_days ?? null,
          notes: r.notes,
          checked_at: r.checked_at,
          qty_overridden_by_user: !!r.qty_overridden_by_user,
        })),
      };
    },
  });
}

/**
 * Detect whether the active grocery list is stale relative to its
 * inputs — meal_plans (in the list's date range) or pantry_items.
 *
 * Closes the second half of Q14's locked decision (inputs-changed
 * banner on shop tab). Past-range is handled by the shop tab itself
 * (range_end < today comparison, no query needed).
 *
 * Implementation: two cheap targeted queries with LIMIT 1, each asking
 * "any row updated after the list was generated?" Short-circuits on the
 * first hit — for the common case (no changes), both queries return
 * empty fast. staleTime = 30s so we don't hammer the DB on every focus
 * refresh; the cost of a slightly-out-of-date staleness signal is low
 * (the user can manually regenerate any time anyway).
 *
 * Returns false (not stale) when:
 *   · list is null/undefined (no list → nothing to be stale about)
 *   · no plan rows in range have updated since list generation
 *   · AND no pantry rows have updated since list generation
 *
 * Relies on:
 *   · grocery_lists.created_at  (existing, treated as generated_at)
 *   · meal_plans.updated_at     (added in migration 0027)
 *   · pantry_items.updated_at   (existing since 0001)
 */
export function useIsListStale(list: ActiveList | null | undefined) {
  return useQuery({
    queryKey: [...groceryKeys.active(), 'stale', list?.id ?? '', list?.created_at ?? ''],
    enabled: !!list,
    staleTime: 30_000,
    queryFn: async (): Promise<boolean> => {
      if (!list) return false;
      const since = list.created_at;

      const { data: plans, error: plansErr } = await supabase
        .from('meal_plans')
        .select('id')
        .gte('date', list.range_start)
        .lte('date', list.range_end)
        .gt('updated_at', since)
        .limit(1);
      if (plansErr) return false; // fail safe: don't show banner on query error
      if (plans && plans.length > 0) return true;

      const { data: pantry, error: pantryErr } = await supabase
        .from('pantry_items')
        .select('id')
        .gt('updated_at', since)
        .limit(1);
      if (pantryErr) return false;
      return !!(pantry && pantry.length > 0);
    },
  });
}

/** Remove a single item from the active grocery list. Used by the
 *  swipe-left "I don't need this" gesture. No pantry side effect — the
 *  whole point is that the user isn't going to buy it. Regenerate will
 *  re-add the item if the underlying plan still needs it. */
export function useRemoveListItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: string): Promise<void> => {
      const { error } = await supabase
        .from('grocery_list_items')
        .delete()
        .eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groceryKeys.active() }),
  });
}

/** Re-insert a previously-removed grocery list item with its prior
 *  state. Used by the Undo toast after swipe-remove. Server-side: the
 *  row was hard-deleted, so we insert a new row with the saved snapshot. */
export function useUndoRemoveListItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (snap: {
      list_id: string;
      ingredient_id: string;
      needed_qty: number;
      qty_to_buy: number;
      pantry_qty: number;
      unit: string;
      waste_risk: WasteRisk;
      unconvertible_count: number;
      notes: string | null;
      checked_at: string | null;
      qty_overridden_by_user: boolean;
    }): Promise<void> => {
      const { error } = await supabase.from('grocery_list_items').insert(snap);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groceryKeys.active() }),
  });
}

/** Edit the qty_to_buy on a list item. Sets qty_overridden_by_user so
 *  subsequent regenerates preserve the user's choice. */
export function useEditListItemQty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      itemId: string;
      qtyToBuy: number;
    }): Promise<void> => {
      const { error } = await supabase
        .from('grocery_list_items')
        .update({
          qty_to_buy: input.qtyToBuy,
          qty_overridden_by_user: true,
        })
        .eq('id', input.itemId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groceryKeys.active() }),
  });
}

export function useGenerateList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      rangeStart: string;
      rangeEnd: string;
    }): Promise<string> => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');

      // Pull planning inputs.
      const [mealPlans, pantryRes] = await Promise.all([
        fetchMealPlansForGeneration(input.rangeStart, input.rangeEnd),
        supabase
          .from('pantry_items')
          .select(
            'id, ingredient_id, qty, unit, ingredients(density_g_per_ml)',
          ),
      ]);
      if (pantryRes.error) throw pantryRes.error;
      const pantry = (pantryRes.data ?? []).map((r: any) => ({
        id: r.id,
        ingredient_id: r.ingredient_id,
        ingredient_name: '',
        ingredient_shelf_life_days: null,
        ingredient_density_g_per_ml: r.ingredients?.density_g_per_ml ?? null,
        qty: Number(r.qty),
        unit: r.unit,
        location: 'pantry' as const,
        location_detail: null,
        purchased_at: null,
        expires_at: null,
        notes: null,
      }));

      const generated = generateGroceryList({
        mealPlans,
        pantry,
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
      });

      // Look up an existing active list to preserve user state across
      // regen — checked items (with their pantry_item_id linkage), AND
      // user-overridden qty values. Without this, bought pantry rows
      // would be orphaned on every regen, and manual qty edits would
      // silently revert.
      const { data: existing } = await supabase
        .from('grocery_lists')
        .select(
          `id, grocery_list_items(
             id, ingredient_id, checked_at, pantry_item_id,
             qty_to_buy, qty_overridden_by_user
           )`,
        )
        .eq('status', 'active')
        .limit(1);
      const existingList = existing?.[0];
      type PreservedCheck = {
        checked_at: string;
        pantry_item_id: string | null;
      };
      type PreservedQty = {
        qty_to_buy: number;
      };
      const preservedChecks = new Map<string, PreservedCheck>();
      const preservedQty = new Map<string, PreservedQty>();
      if (existingList) {
        for (const item of (existingList.grocery_list_items as any[]) ?? []) {
          if (item.checked_at) {
            preservedChecks.set(item.ingredient_id, {
              checked_at: item.checked_at,
              pantry_item_id: item.pantry_item_id ?? null,
            });
          }
          if (item.qty_overridden_by_user) {
            preservedQty.set(item.ingredient_id, {
              qty_to_buy: Number(item.qty_to_buy),
            });
          }
        }
      }

      let listId: string;
      if (existingList) {
        // Clear existing items, update range, keep list row. We have to
        // delete items BEFORE re-inserting because the new rows re-claim
        // pantry_item_ids preserved above (unique index would collide).
        listId = existingList.id;
        await supabase.from('grocery_list_items').delete().eq('list_id', listId);
        await supabase
          .from('grocery_lists')
          .update({
            range_start: input.rangeStart,
            range_end: input.rangeEnd,
          })
          .eq('id', listId);
      } else {
        const { data: newList, error: insertErr } = await supabase
          .from('grocery_lists')
          .insert({
            user_id: user.user.id,
            range_start: input.rangeStart,
            range_end: input.rangeEnd,
            status: 'active',
          })
          .select('id')
          .single();
        if (insertErr) throw insertErr;
        listId = newList.id;
      }

      if (generated.length > 0) {
        const rows = generated.map((g) => {
          const preservedCheck = preservedChecks.get(g.ingredient_id);
          const preservedOverride = preservedQty.get(g.ingredient_id);
          return {
            list_id: listId,
            ingredient_id: g.ingredient_id,
            needed_qty: g.needed_qty,
            // User-overridden qty wins over the freshly-computed value.
            // Stored alongside the override flag so subsequent regens
            // continue to honor it.
            qty_to_buy: preservedOverride?.qty_to_buy ?? g.qty_to_buy,
            qty_overridden_by_user: !!preservedOverride,
            pantry_qty: g.pantry_qty,
            unit: g.unit,
            waste_risk: g.waste_risk,
            unconvertible_count: g.unconvertible_count,
            checked_at: preservedCheck?.checked_at ?? null,
            pantry_item_id: preservedCheck?.pantry_item_id ?? null,
          };
        });
        const { error: itemsErr } = await supabase
          .from('grocery_list_items')
          .insert(rows);
        if (itemsErr) throw itemsErr;
      }

      return listId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groceryKeys.all });
    },
  });
}

export function useToggleItemChecked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      itemId: string;
      checked: boolean;
    }): Promise<string> => {
      // Atomic: the RPC creates a pantry row on check and (conditionally)
      // deletes it on uncheck. If the user had edited the pantry row, the
      // RPC returns 'pantry_row_preserved' so we can tell them.
      const { data, error } = await supabase.rpc('check_grocery_item', {
        p_item_id: input.itemId,
        p_checked: input.checked,
      });
      if (error) throw error;
      return (data ?? '') as string;
    },
    onSuccess: (status) => {
      qc.invalidateQueries({ queryKey: groceryKeys.active() });
      qc.invalidateQueries({ queryKey: pantryKeys.all });
      if (status === 'pantry_row_preserved') {
        Alert.alert(
          'Pantry item kept',
          "You'd edited this pantry row since buying it, so we kept it. Adjust or remove it from the Pantry tab if you want.",
        );
      }
    },
  });
}

export function useCompleteList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (listId: string) => {
      const { error } = await supabase
        .from('grocery_lists')
        .update({ status: 'completed' })
        .eq('id', listId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: groceryKeys.all });
      qc.invalidateQueries({ queryKey: pantryKeys.all });
    },
  });
}

export function useCompletedLists() {
  return useQuery({
    queryKey: groceryKeys.history(),
    queryFn: async (): Promise<CompletedList[]> => {
      const { data, error } = await supabase
        .from('grocery_lists')
        .select(
          'id, range_start, range_end, status, created_at, grocery_list_items(id)',
        )
        .in('status', ['completed', 'archived'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        range_start: r.range_start,
        range_end: r.range_end,
        status: r.status,
        item_count: (r.grocery_list_items ?? []).length,
        completed_at: r.created_at,
      }));
    },
  });
}

export function useDeleteList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (listId: string) => {
      const { error } = await supabase
        .from('grocery_lists')
        .delete()
        .eq('id', listId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: groceryKeys.all }),
  });
}
