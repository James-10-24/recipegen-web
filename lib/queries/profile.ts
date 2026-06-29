import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type Profile = {
  id: string;
  display_name: string | null;
  household_size: number;
  units: 'metric' | 'imperial';
  diet_tags: string[];
};

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Profile> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, household_size, units, diet_tags')
        .single();
      if (error) throw error;
      return data as Profile;
    },
  });
}
