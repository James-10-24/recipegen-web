import type { PantryItem } from '@/lib/queries/pantry';
import { convert } from '@/lib/units';

export type CoverageState = 'covered' | 'short' | 'missing' | 'unit-mismatch';

export type Coverage = {
  state: CoverageState;
  have: number; // in recipe unit
  short?: number; // in recipe unit
};

export function coverageFor(
  ingredient_id: string,
  required_qty: number,
  recipe_unit: string,
  density_g_per_ml: number | null,
  pantry: PantryItem[],
): Coverage {
  const matches = pantry.filter((p) => p.ingredient_id === ingredient_id);
  if (matches.length === 0) return { state: 'missing', have: 0 };

  let have = 0;
  let unconvertible = 0;
  for (const p of matches) {
    const d = density_g_per_ml ?? p.ingredient_density_g_per_ml;
    const c = convert(p.qty, p.unit, recipe_unit, d);
    if (c === null) {
      unconvertible++;
    } else {
      have += c;
    }
  }

  if (have + 1e-6 >= required_qty) return { state: 'covered', have };
  if (unconvertible > 0) return { state: 'unit-mismatch', have };
  return { state: 'short', have, short: required_qty - have };
}

export type RecipeCoverage = {
  covered: number;
  total: number;
};

export function recipeCoverage(
  ingredients: {
    ingredient_id: string;
    qty: number;
    unit: string;
    density_g_per_ml: number | null;
  }[],
  pantry: PantryItem[],
): RecipeCoverage {
  let covered = 0;
  for (const ri of ingredients) {
    const c = coverageFor(
      ri.ingredient_id,
      ri.qty,
      ri.unit,
      ri.density_g_per_ml,
      pantry,
    );
    if (c.state === 'covered') covered++;
  }
  return { covered, total: ingredients.length };
}
