// Pure grocery-list generator. Takes planned meals and pantry snapshot,
// produces the rows to write into grocery_list_items.
//
// Math per PLAN.md §5.3:
//   needed = Σ(recipe_qty × servings_factor), in canonical default_unit
//   pantry = Σ(pantry.qty)              , converted to default_unit
//   qty_to_buy = ceil(max(0, needed - pantry) / package_size) × package_size
//   waste_risk = high when package-rounding forces >50% excess on a
//                short-shelf-life item; low otherwise.

import type { PantryItem } from '@/lib/queries/pantry';
import { convert } from '@/lib/units';

export type GenerateRecipe = {
  id: string;
  servings: number;
  ingredients: {
    ingredient_id: string;
    qty: number;
    unit: string;
    ingredient: {
      name: string;
      category: string | null;
      default_unit: string;
      package_size: number | null;
      package_unit: string | null;
      shelf_life_days: number | null;
      density_g_per_ml: number | null;
    };
  }[];
};

export type GenerateMealPlan = {
  date: string; // YYYY-MM-DD
  servings_override: number | null;
  /** How many meals this single cook covers. 1 = single-meal cook (the
   *  default). >1 = batch cook where this row represents the cook event
   *  and subsequent (date+1, date+2, ...) slots are leftover-derived
   *  consume events. Shopping list multiplies recipe qty by meals_count
   *  so the cook batch is sized correctly. */
  meals_count: number;
  recipe: GenerateRecipe;
};

export type GeneratedItem = {
  ingredient_id: string;
  ingredient_name: string;
  category: string | null;
  unit: string; // default_unit we aggregated in
  needed_qty: number;
  pantry_qty: number;
  qty_to_buy: number;
  waste_risk: 'low' | 'medium' | 'high';
  /** Count of recipe contributions that couldn't be unit-converted and were
   *  dropped from needed_qty. UI surfaces this so the user knows the number
   *  isn't the whole story. */
  unconvertible_count: number;
};

type Aggregate = {
  ingredient_id: string;
  ingredient_name: string;
  category: string | null;
  default_unit: string;
  package_size: number | null;
  package_unit: string | null;
  shelf_life_days: number | null;
  density_g_per_ml: number | null;
  needed: number;
  couldNotConvertCount: number;
};

function round(n: number, dp = 2): number {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

export function generateGroceryList(input: {
  mealPlans: GenerateMealPlan[];
  pantry: PantryItem[];
  rangeStart: string;
  rangeEnd: string;
}): GeneratedItem[] {
  const { mealPlans, pantry } = input;
  // rangeStart/rangeEnd retained on the input shape for caller clarity
  // but no longer used here — the post-grill waste thresholds are
  // shelf-absolute rather than range-relative.

  const agg = new Map<string, Aggregate>();

  // 1) Aggregate required ingredients across planned meals. Scale per
  //    row by:
  //      (servings_override ?? recipe.servings)   ← per-meal qty
  //      × meals_count                            ← number of meals
  //                                                 this single cook
  //                                                 covers (leftovers)
  //      / recipe.servings                        ← per-serving ratio
  //
  //    Per-meal × meals_count = total servings cooked from this row.
  //    Multiplying recipe ingredient qty by (total_cooked / recipe.servings)
  //    gives the actual purchase need.
  for (const mp of mealPlans) {
    const perMeal = mp.servings_override ?? mp.recipe.servings;
    const totalServings = perMeal * Math.max(1, mp.meals_count);
    const ratio = totalServings / Math.max(1, mp.recipe.servings);

    for (const ri of mp.recipe.ingredients) {
      const ing = ri.ingredient;
      const targetUnit = ing.default_unit;
      const converted = convert(ri.qty, ri.unit, targetUnit, ing.density_g_per_ml);

      let a = agg.get(ri.ingredient_id);
      if (!a) {
        a = {
          ingredient_id: ri.ingredient_id,
          ingredient_name: ing.name,
          category: ing.category,
          default_unit: targetUnit,
          package_size: ing.package_size,
          package_unit: ing.package_unit,
          shelf_life_days: ing.shelf_life_days,
          density_g_per_ml: ing.density_g_per_ml,
          needed: 0,
          couldNotConvertCount: 0,
        };
        agg.set(ri.ingredient_id, a);
      }

      if (converted === null) {
        a.couldNotConvertCount++;
        continue;
      }
      a.needed += converted * ratio;
    }
  }

  // 2) Subtract pantry coverage in the same default_unit.
  const results: GeneratedItem[] = [];
  for (const a of agg.values()) {
    if (a.needed <= 0) continue;

    const matches = pantry.filter((p) => p.ingredient_id === a.ingredient_id);
    let pantryQty = 0;
    for (const p of matches) {
      const d = a.density_g_per_ml ?? p.ingredient_density_g_per_ml;
      const c = convert(p.qty, p.unit, a.default_unit, d);
      if (c !== null) pantryQty += c;
    }

    const shortfall = Math.max(0, a.needed - pantryQty);
    if (shortfall <= 0) continue;

    // 3) Round up to package size.
    let qtyToBuy = shortfall;
    if (a.package_size && a.package_size > 0) {
      // Package unit should match the default_unit for this to be meaningful;
      // otherwise skip rounding.
      if ((a.package_unit ?? a.default_unit) === a.default_unit) {
        qtyToBuy = Math.ceil(shortfall / a.package_size) * a.package_size;
      }
    }

    // 3b) Unconvertible buffer: when some recipe contributions couldn't
    //     be unit-converted, the convertible-only sum under-estimates.
    //     Bump qty_to_buy by one package size (or +50% if no package) so
    //     the user doesn't short-buy. Then re-apply package rounding to
    //     land on a real boundary.
    if (a.couldNotConvertCount > 0) {
      const buffer =
        a.package_size && a.package_size > 0 ? a.package_size : qtyToBuy * 0.5;
      qtyToBuy = qtyToBuy + buffer;
      if (
        a.package_size &&
        a.package_size > 0 &&
        (a.package_unit ?? a.default_unit) === a.default_unit
      ) {
        qtyToBuy = Math.ceil(qtyToBuy / a.package_size) * a.package_size;
      }
    }

    // 4) Waste flag: tightened thresholds (post-grill, May 2026).
    //    HIGH only when shelf is short (≤5 days) AND excess is
    //    substantial (>1.8×). MEDIUM is the warning belt for genuinely
    //    perishable bulk. The previous thresholds (7d/1.5×, 1.25×)
    //    over-fired on every modest package round and trained users to
    //    ignore the flag.
    let wasteRisk: 'low' | 'medium' | 'high' = 'low';
    const excessRatio = shortfall > 0 ? qtyToBuy / shortfall : 1;
    const shelf = a.shelf_life_days;
    if (shelf != null && shelf <= 5 && excessRatio > 1.8) {
      wasteRisk = 'high';
    } else if (
      (shelf != null && shelf <= 14 && excessRatio > 1.4) ||
      (shelf == null && excessRatio > 1.8)
    ) {
      wasteRisk = 'medium';
    }

    results.push({
      ingredient_id: a.ingredient_id,
      ingredient_name: a.ingredient_name,
      category: a.category,
      unit: a.default_unit,
      needed_qty: round(a.needed, 2),
      pantry_qty: round(pantryQty, 2),
      qty_to_buy: round(qtyToBuy, 2),
      waste_risk: wasteRisk,
      unconvertible_count: a.couldNotConvertCount,
    });
  }

  // 5) Stable sort: category, then name.
  results.sort((x, y) => {
    const cx = x.category ?? 'zzz';
    const cy = y.category ?? 'zzz';
    if (cx !== cy) return cx.localeCompare(cy);
    return x.ingredient_name.localeCompare(y.ingredient_name);
  });

  return results;
}
