import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type IngredientSearchResult = {
  id: string;
  name: string;
  category: string | null;
  default_unit: string;
  shelf_life_days: number | null;
  density_g_per_ml: number | null;
  user_id: string | null;
  similarity: number;
};

export function useIngredientSearch(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['ingredients', 'search', trimmed],
    enabled: trimmed.length >= 1,
    staleTime: 30_000,
    queryFn: async (): Promise<IngredientSearchResult[]> => {
      const { data, error } = await supabase.rpc('search_ingredients', {
        q: trimmed,
        lim: 10,
      });
      if (error) throw error;
      return (data ?? []) as IngredientSearchResult[];
    },
  });
}

export function useCreateIngredient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      default_unit: string;
      category?: string | null;
      aliases?: string[];
      shelf_life_days?: number | null;
      density_g_per_ml?: number | null;
    }): Promise<IngredientSearchResult> => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');

      const { data, error } = await supabase
        .from('ingredients')
        .insert({
          name: input.name.trim(),
          default_unit: input.default_unit,
          category: input.category ?? null,
          aliases: input.aliases ?? [],
          shelf_life_days: input.shelf_life_days ?? null,
          density_g_per_ml: input.density_g_per_ml ?? null,
          user_id: user.user.id,
          is_canonical: false,
        })
        .select('id, name, category, default_unit, shelf_life_days, density_g_per_ml, user_id')
        .single();
      if (error) throw error;
      return { ...data, similarity: 1 } as IngredientSearchResult;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ingredients', 'search'] }),
  });
}
