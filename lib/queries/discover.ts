import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { recipesKeys } from '@/lib/queries/recipes';
import type { RecipeCategory } from '@/lib/recipe-categories';
import type { RecipeLanguage } from '@/lib/recipe-language';

export type DiscoverRow = {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  photo_url: string | null;
  servings: number;
  prep_min: number | null;
  cook_min: number | null;
  category: RecipeCategory | null;
  language: RecipeLanguage | null;
  similarity: number;
  created_at: string;
  author_name: string | null;
};

export const discoverKeys = {
  all: ['discover'] as const,
  search: (
    q: string,
    category: RecipeCategory | null,
    language: RecipeLanguage | null,
  ) =>
    [...discoverKeys.all, 'search', q, category ?? '', language ?? ''] as const,
};

export function useDiscoverRecipes(
  query: string,
  opts: {
    enabled?: boolean;
    category?: RecipeCategory | null;
    /** Filter the feed by recipe language. Rows with NULL language are
     *  always included (legacy / unknown — see migration 0032 for why).
     *  Null here means "no language filter — show every language." */
    language?: RecipeLanguage | null;
  } = {},
) {
  // Cap at 100 chars (server caps too — keeps payload small).
  const trimmed = query.trim().slice(0, 100);
  const category = opts.category ?? null;
  const language = opts.language ?? null;
  return useQuery({
    queryKey: discoverKeys.search(trimmed, category, language),
    staleTime: 15_000,
    enabled: opts.enabled ?? true,
    queryFn: async (): Promise<DiscoverRow[]> => {
      const { data, error } = await supabase.rpc('search_public_recipes', {
        q: trimmed,
        lim: 30,
        p_category: category,
        p_language: language,
      });
      if (error) throw error;
      // RPC now returns author_name in the same row — no second round-trip.
      return (data ?? []) as DiscoverRow[];
    },
  });
}

/** Resolve "Saved from <author>" attribution for a cloned recipe.
 *  Returns null if the source went private, was deleted, or didn't exist. */
export function useSavedFromAttribution(savedFromId: string | null | undefined) {
  return useQuery({
    queryKey: ['saved-from', savedFromId ?? ''],
    enabled: !!savedFromId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ title: string; author_name: string | null } | null> => {
      if (!savedFromId) return null;
      // RLS filters this select to public-or-own. If the source has gone
      // private (and isn't owned by the caller), .single() returns no rows.
      const { data: src, error } = await supabase
        .from('recipes')
        .select('title, user_id')
        .eq('id', savedFromId)
        .maybeSingle();
      if (error || !src) return null;
      const { data: names } = await supabase.rpc('display_names_for', {
        p_user_ids: [src.user_id],
      });
      const row = (names as { user_id: string; display_name: string | null }[] | null)?.[0];
      return { title: src.title, author_name: row?.display_name ?? null };
    },
  });
}

/** Look up the display name for a single user (used on public recipe detail). */
export function useAuthorName(userId: string | undefined) {
  return useQuery({
    queryKey: ['author-name', userId ?? ''],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<string | null> => {
      if (!userId) return null;
      const { data, error } = await supabase.rpc('display_names_for', {
        p_user_ids: [userId],
      });
      if (error) return null;
      const row = (data as { user_id: string; display_name: string | null }[] | null)?.[0];
      return row?.display_name ?? null;
    },
  });
}

/**
 * Resolve which of these source recipe IDs the caller has already cloned.
 * Returns Map<source_id, clone_id>. Used to:
 *   · badge already-saved rows in Discover
 *   · swap "Save to my recipes" → "Open my saved copy" on public detail
 *
 * Cheap RPC — single index hit on (user_id, saved_from_id). We pass the
 * entire visible source-id list and let Postgres do the lookup in one
 * round-trip rather than firing one query per visible row.
 */
export function useSavedSet(sourceIds: string[]) {
  // Stable key — order-independent so paging/refetch with the same set
  // doesn't re-fetch.
  const sortedKey = [...sourceIds].sort().join(',');
  return useQuery({
    queryKey: ['saved-set', sortedKey],
    enabled: sourceIds.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const { data, error } = await supabase.rpc('saved_set_for_caller', {
        p_source_ids: sourceIds,
      });
      if (error) throw error;
      const map = new Map<string, string>();
      for (const row of (data ?? []) as { source_id: string; clone_id: string }[]) {
        map.set(row.source_id, row.clone_id);
      }
      return map;
    },
  });
}

/** Atomically clone a public recipe + ingredients into the caller's library.
 *  Server dedupes — calling twice returns the same clone id, no duplicate. */
export function useSaveRecipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (recipeId: string): Promise<string> => {
      const { data, error } = await supabase.rpc('save_recipe', {
        p_recipe_id: recipeId,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: recipesKeys.all });
      // Refresh "saved" badging on the Discover list after a clone lands.
      qc.invalidateQueries({ queryKey: ['saved-set'] });
    },
  });
}
