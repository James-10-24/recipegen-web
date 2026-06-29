// Curated list of recipe categories used by:
//   · the recipe-form dropdown
//   · the recipe-detail badge
//   · the library + Discover filter chips
//   · the AI extraction prompts (generate-recipe / import-recipe)
//
// App-side enforced — see migration 0028_recipe_category.sql for why
// there's no DB check constraint. To add a new category, add it here
// and the four call sites pick it up automatically.

export const RECIPE_CATEGORIES = [
  'Breakfast',
  'Lunch',
  'Dinner',
  'Snack',
  'Dessert',
  'Drink',
] as const;

export type RecipeCategory = (typeof RECIPE_CATEGORIES)[number];

export function isRecipeCategory(s: unknown): s is RecipeCategory {
  return typeof s === 'string' && (RECIPE_CATEGORIES as readonly string[]).includes(s);
}
