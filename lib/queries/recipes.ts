import { FunctionsHttpError } from '@supabase/supabase-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RecipeCategory } from '@/lib/recipe-categories';
import {
  detectRecipeLanguage,
  type RecipeLanguage,
} from '@/lib/recipe-language';
import { supabase } from '@/lib/supabase';

export type RecipeIngredientLite = {
  ingredient_id: string;
  qty: number;
  unit: string;
  density_g_per_ml: number | null;
};

export type RecipeListRow = {
  id: string;
  title: string;
  description: string | null;
  servings: number;
  prep_min: number | null;
  cook_min: number | null;
  updated_at: string;
  photo_url: string | null;
  category: RecipeCategory | null;
  tags: string[];
  /** Null for user-created recipes; UUID of the source for Discover clones.
   *  Used by the free-tier recipe-cap gate to count creations only. */
  saved_from_id: string | null;
  /** App-side enforced (one of `RECIPE_LANGUAGES`); null for legacy rows
   *  where detection couldn't decide. Drives the Discover language chip
   *  filter and the recipe-form override chip. */
  language: RecipeLanguage | null;
  ingredients: RecipeIngredientLite[];
};

export type RecipeIngredientInput = {
  ingredient_id: string;
  qty: number;
  unit: string;
  notes?: string | null;
  sort_order: number;
};

export type ModerationStatus = 'pending' | 'approved' | 'rejected';

export type RecipeDetail = Omit<RecipeListRow, 'ingredients'> & {
  instructions: string[];
  diet_tags: string[];
  visibility: 'private' | 'public';
  user_id: string;
  source_url: string | null;
  photo_url: string | null;
  saved_from_id: string | null;
  saved_from_author_name: string | null;
  moderation_status: ModerationStatus;
  moderation_categories: string[] | null;
  ingredients: (RecipeIngredientInput & {
    ingredient_name: string;
    density_g_per_ml: number | null;
  })[];
};

export type RecipeInput = {
  title: string;
  description?: string | null;
  servings: number;
  prep_min?: number | null;
  cook_min?: number | null;
  instructions?: string[];
  source_url?: string | null;
  photo_url?: string | null;
  visibility?: 'private' | 'public';
  category?: RecipeCategory | null;
  tags?: string[];
  /** Explicit language override. If omitted, the create/update mutation
   *  auto-detects via `detectRecipeLanguage(title, description)`. */
  language?: RecipeLanguage | null;
  ingredients: RecipeIngredientInput[];
};

export const recipesKeys = {
  all: ['recipes'] as const,
  list: () => [...recipesKeys.all, 'list'] as const,
  detail: (id: string) => [...recipesKeys.all, 'detail', id] as const,
};

export function useRecipesList() {
  return useQuery({
    queryKey: recipesKeys.list(),
    queryFn: async (): Promise<RecipeListRow[]> => {
      const { data, error } = await supabase
        .from('recipes')
        .select(
          `id, title, description, servings, prep_min, cook_min, updated_at, photo_url,
           category, tags, saved_from_id, language,
           recipe_ingredients(ingredient_id, qty, unit, ingredients(density_g_per_ml))`,
        )
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        servings: r.servings,
        prep_min: r.prep_min,
        cook_min: r.cook_min,
        updated_at: r.updated_at,
        photo_url: r.photo_url ?? null,
        category: (r.category as RecipeCategory | null) ?? null,
        tags: Array.isArray(r.tags) ? r.tags : [],
        saved_from_id: r.saved_from_id ?? null,
        language: (r.language as RecipeLanguage | null) ?? null,
        ingredients: (r.recipe_ingredients ?? []).map((ri: any) => ({
          ingredient_id: ri.ingredient_id,
          qty: Number(ri.qty),
          unit: ri.unit,
          density_g_per_ml: ri.ingredients?.density_g_per_ml ?? null,
        })),
      }));
    },
  });
}

export function useRecipe(id: string | undefined) {
  return useQuery({
    queryKey: id ? recipesKeys.detail(id) : ['recipes', 'detail', 'none'],
    enabled: !!id,
    queryFn: async (): Promise<RecipeDetail> => {
      const { data: recipe, error } = await supabase
        .from('recipes')
        .select(
          'id, user_id, title, description, servings, prep_min, cook_min, instructions, category, language, tags, diet_tags, visibility, updated_at, source_url, photo_url, saved_from_id, saved_from_author_name, moderation_status, moderation_categories',
        )
        .eq('id', id!)
        .single();
      if (error) throw error;

      const { data: ings, error: ingsErr } = await supabase
        .from('recipe_ingredients')
        .select(
          'ingredient_id, qty, unit, notes, sort_order, ingredients(name, density_g_per_ml)',
        )
        .eq('recipe_id', id!)
        .order('sort_order', { ascending: true });
      if (ingsErr) throw ingsErr;

      return {
        ...recipe,
        ingredients: (ings ?? []).map((r: any) => ({
          ingredient_id: r.ingredient_id,
          qty: Number(r.qty),
          unit: r.unit,
          notes: r.notes,
          sort_order: r.sort_order,
          ingredient_name: r.ingredients?.name ?? '',
          density_g_per_ml: r.ingredients?.density_g_per_ml ?? null,
        })),
      };
    },
  });
}

/**
 * Route a publish through the moderate-recipe edge function.
 *
 * RLS gates `visibility='public'` behind `moderation_status='approved'`,
 * which only the edge function (service role) can flip. The client always
 * inserts/updates as private and then calls this to publish — the function
 * runs OpenAI moderation on title/description/instructions/photo and either
 * approves+publishes the row or rejects it (and forces it private).
 *
 * Throws with a user-readable message on rejection or infra failure.
 * Caller catches and surfaces via Alert.alert.
 */
async function moderateAndPublish(recipeId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('moderate-recipe', {
    body: { recipe_id: recipeId },
  });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      try {
        const body = await error.context.json();
        throw new Error(body?.error ?? 'Could not publish recipe');
      } catch {
        throw new Error('Could not publish recipe');
      }
    }
    throw error;
  }
  const result = data as
    | { ok: true; approved: true }
    | { ok: false; rejected: true; categories: string[]; message: string };
  if ('rejected' in result && result.rejected) {
    throw new Error(result.message);
  }
}

async function replaceIngredients(recipeId: string, items: RecipeIngredientInput[]) {
  const { error: delErr } = await supabase
    .from('recipe_ingredients')
    .delete()
    .eq('recipe_id', recipeId);
  if (delErr) throw delErr;

  if (items.length === 0) return;
  const rows = items.map((i) => ({
    recipe_id: recipeId,
    ingredient_id: i.ingredient_id,
    qty: i.qty,
    unit: i.unit,
    notes: i.notes ?? null,
    sort_order: i.sort_order,
  }));
  const { error } = await supabase.from('recipe_ingredients').insert(rows);
  if (error) throw error;
}

export function useCreateRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecipeInput): Promise<string> => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');

      const wantsPublic = input.visibility === 'public';

      // Always insert as private. RLS refuses public+pending — only
      // moderate-recipe (service role) can flip a row to public+approved.
      // Language: respect explicit override, else auto-detect from title +
      // description via the CJK-ratio heuristic. Null result means "no
      // signal" (empty inputs); store as NULL so Discover treats the row
      // as language-unknown and surfaces it in any language tab.
      const detectedLanguage =
        input.language === undefined
          ? detectRecipeLanguage(input.title, input.description ?? null)
          : input.language;

      const { data, error } = await supabase
        .from('recipes')
        .insert({
          user_id: user.user.id,
          title: input.title,
          description: input.description ?? null,
          servings: input.servings,
          prep_min: input.prep_min ?? null,
          cook_min: input.cook_min ?? null,
          instructions: input.instructions ?? [],
          source_url: input.source_url ?? null,
          photo_url: input.photo_url ?? null,
          visibility: 'private',
          category: input.category ?? null,
          tags: input.tags ?? [],
          language: detectedLanguage,
        })
        .select('id')
        .single();
      if (error) throw error;

      await replaceIngredients(data.id, input.ingredients);

      if (wantsPublic) {
        // If moderation rejects, the row is already saved as private — the
        // user keeps their work and we surface why publishing was refused.
        await moderateAndPublish(data.id);
      }
      return data.id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: recipesKeys.all }),
  });
}

export function useUpdateRecipe(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecipeInput) => {
      const wantsPublic = input.visibility === 'public';

      // Same auto-detect behavior as useCreateRecipe — explicit override
      // wins, otherwise re-detect from the new title + description (so
      // editing a recipe to add Chinese characters flips the language
      // tag automatically without the user needing to touch the chip).
      const detectedLanguage =
        input.language === undefined
          ? detectRecipeLanguage(input.title, input.description ?? null)
          : input.language;

      const updates: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? null,
        servings: input.servings,
        prep_min: input.prep_min ?? null,
        cook_min: input.cook_min ?? null,
        instructions: input.instructions ?? [],
        source_url: input.source_url ?? null,
        photo_url: input.photo_url ?? null,
        category: input.category ?? null,
        tags: input.tags ?? [],
        language: detectedLanguage,
      };
      // The DB trigger resets moderation_status to 'pending' and forces
      // visibility back to private when title/description/instructions/photo
      // change. So writing visibility='public' here would fail the RLS
      // WITH CHECK. Always update as private; if the user wants public,
      // re-publish via the moderation edge function below.
      if (input.visibility !== undefined) {
        updates.visibility = 'private';
      }
      const { error } = await supabase
        .from('recipes')
        .update(updates)
        .eq('id', id);
      if (error) throw error;
      await replaceIngredients(id, input.ingredients);

      if (wantsPublic) {
        await moderateAndPublish(id);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: recipesKeys.all });
    },
  });
}

export function useDeleteRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('recipes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: recipesKeys.list() }),
  });
}
