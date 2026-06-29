import { FunctionsHttpError } from '@supabase/supabase-js';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

async function readFunctionError(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      if (body?.error) return String(body.error);
    } catch {
      // fall through
    }
  }
  return (error as Error)?.message ?? fallback;
}

/**
 * Persist the user's household size (1-8). Seeded from the onboarding
 * activation slide for new installs; user can adjust later via Settings →
 * Profile → Household.
 *
 * No edge function needed — household_size is a single integer with no
 * moderation surface, so a direct supabase update is fine. Clamps server-
 * inputs at 1-8 defensively so a misuse can't write 0 or negative values.
 *
 * Invalidates the 'profile' cache so any surface reading
 * profile.household_size (RecipePicker default servings, etc.) reflects
 * the change without a refetch round-trip.
 */
export function useUpdateHouseholdSize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (size: number): Promise<number> => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) throw new Error('Not signed in');
      const clamped = Math.max(1, Math.min(8, Math.round(size)));
      const { error } = await supabase
        .from('profiles')
        .update({ household_size: clamped })
        .eq('id', u.user.id);
      if (error) throw error;
      return clamped;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useUpdateDisplayName() {
  const qc = useQueryClient();
  return useMutation({
    // Routed through update-display-name edge function so OpenAI's
    // moderation API can screen the input before it lands in the DB.
    mutationFn: async (display_name: string): Promise<string | null> => {
      const trimmed = display_name.trim().slice(0, 60);
      const { data, error } = await supabase.functions.invoke(
        'update-display-name',
        { body: { display_name: trimmed } },
      );
      if (error) {
        throw new Error(await readFunctionError(error, 'Update failed'));
      }
      return ((data as { display_name?: string | null })?.display_name) ?? null;
    },
    onSuccess: () => {
      // The user's name surfaces in three places that other users see:
      //   · author byline on public recipe detail (useAuthorName)
      //   · "Saved from <author>" attribution (useSavedFromAttribution)
      //   · their own profile screen (useProfile)
      // Invalidate all three so stale names don't linger.
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['author-name'] });
      qc.invalidateQueries({ queryKey: ['saved-from'] });
    },
  });
}

/** Permanent account deletion — wipes the auth.users row via the
 *  delete-account edge function. FK cascades clean up everything else. */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.functions.invoke('delete-account', {
        body: {},
      });
      if (error) throw error;
      // Auth session is invalid now; trigger sign-out so the AuthProvider
      // navigates to the sign-in screen.
      await supabase.auth.signOut();
    },
  });
}
