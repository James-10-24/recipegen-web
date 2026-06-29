import {
  FunctionsHttpError,
} from '@supabase/supabase-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { invalidateAiUsage } from '@/lib/queries/ai-usage';
import { supabase } from '@/lib/supabase';

export type PantryLocation = 'fridge' | 'freezer' | 'pantry' | 'other';

export const PANTRY_LOCATIONS: PantryLocation[] = ['fridge', 'pantry', 'freezer', 'other'];

export const PANTRY_LOCATION_LABEL: Record<PantryLocation, string> = {
  fridge: 'Fridge',
  freezer: 'Freezer',
  pantry: 'Pantry',
  other: 'Other',
};

export type PantryItem = {
  id: string;
  ingredient_id: string;
  ingredient_name: string;
  ingredient_shelf_life_days: number | null;
  ingredient_density_g_per_ml: number | null;
  qty: number;
  unit: string;
  location: PantryLocation;
  location_detail: string | null;
  purchased_at: string | null; // YYYY-MM-DD
  expires_at: string | null; // YYYY-MM-DD
  notes: string | null;
};

export type PantryItemInput = {
  ingredient_id: string;
  qty: number;
  unit: string;
  location: PantryLocation;
  location_detail?: string | null;
  purchased_at?: string | null;
  expires_at?: string | null;
  notes?: string | null;
};

export const pantryKeys = {
  all: ['pantry'] as const,
  list: () => [...pantryKeys.all, 'list'] as const,
  detail: (id: string) => [...pantryKeys.all, 'detail', id] as const,
};

export function usePantryList() {
  return useQuery({
    queryKey: pantryKeys.list(),
    queryFn: async (): Promise<PantryItem[]> => {
      const { data, error } = await supabase
        .from('pantry_items')
        .select(
          'id, ingredient_id, qty, unit, location, location_detail, purchased_at, expires_at, notes, ingredients(name, shelf_life_days, density_g_per_ml)',
        )
        .order('expires_at', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        ingredient_id: r.ingredient_id,
        ingredient_name: r.ingredients?.name ?? '(unknown)',
        ingredient_shelf_life_days: r.ingredients?.shelf_life_days ?? null,
        ingredient_density_g_per_ml: r.ingredients?.density_g_per_ml ?? null,
        qty: Number(r.qty),
        unit: r.unit,
        location: r.location,
        location_detail: r.location_detail,
        purchased_at: r.purchased_at,
        expires_at: r.expires_at,
        notes: r.notes,
      }));
    },
  });
}

export function usePantryItem(id: string | undefined) {
  return useQuery({
    queryKey: id ? pantryKeys.detail(id) : ['pantry', 'detail', 'none'],
    enabled: !!id,
    queryFn: async (): Promise<PantryItem> => {
      const { data, error } = await supabase
        .from('pantry_items')
        .select(
          'id, ingredient_id, qty, unit, location, location_detail, purchased_at, expires_at, notes, ingredients(name, shelf_life_days, density_g_per_ml)',
        )
        .eq('id', id!)
        .single();
      if (error) throw error;
      return {
        id: data.id,
        ingredient_id: data.ingredient_id,
        ingredient_name: (data as any).ingredients?.name ?? '(unknown)',
        ingredient_shelf_life_days: (data as any).ingredients?.shelf_life_days ?? null,
        ingredient_density_g_per_ml: (data as any).ingredients?.density_g_per_ml ?? null,
        qty: Number(data.qty),
        unit: data.unit,
        location: data.location,
        location_detail: (data as any).location_detail ?? null,
        purchased_at: data.purchased_at,
        expires_at: data.expires_at,
        notes: data.notes,
      };
    },
  });
}

export function useAddPantryItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PantryItemInput): Promise<string> => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');
      const { data, error } = await supabase
        .from('pantry_items')
        .insert({
          user_id: user.user.id,
          ingredient_id: input.ingredient_id,
          qty: input.qty,
          unit: input.unit,
          location: input.location,
          location_detail: input.location === 'other' ? input.location_detail ?? null : null,
          purchased_at: input.purchased_at ?? null,
          expires_at: input.expires_at ?? null,
          notes: input.notes ?? null,
        })
        .select('id')
        .single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pantryKeys.all }),
  });
}

export function useUpdatePantryItem(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PantryItemInput) => {
      const { error } = await supabase
        .from('pantry_items')
        .update({
          ingredient_id: input.ingredient_id,
          qty: input.qty,
          unit: input.unit,
          location: input.location,
          location_detail: input.location === 'other' ? input.location_detail ?? null : null,
          purchased_at: input.purchased_at ?? null,
          expires_at: input.expires_at ?? null,
          notes: input.notes ?? null,
        })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pantryKeys.all }),
  });
}

/**
 * Adjust a pantry item's qty by a delta (typically negative for the
 * inline minus stepper). Server-side check `qty >= 0` (migration 0001)
 * is the strict backstop; we also clamp client-side so a misclick on a
 * near-empty item doesn't surface an avoidable error.
 *
 * Race semantics: read-modify-write client-side. For single-user-single-
 * device usage (the overwhelming case for this audience), no race. The
 * worst-case multi-device race loses one step's worth of deduction and
 * self-corrects on the next pantry refetch.
 *
 * Caller manages optimistic UI by mutating the pantry list cache
 * directly (see app/(tabs)/pantry.tsx) — this mutation is invoked at
 * commit time, after the 4s coalescing window closes.
 */
export function useAdjustPantryQty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      delta,
    }: {
      id: string;
      delta: number;
    }): Promise<number> => {
      const { data: current, error: readErr } = await supabase
        .from('pantry_items')
        .select('qty')
        .eq('id', id)
        .single();
      if (readErr) throw readErr;
      const newQty = Math.max(0, Number(current.qty) + delta);
      const { error: writeErr } = await supabase
        .from('pantry_items')
        .update({ qty: newQty })
        .eq('id', id);
      if (writeErr) throw writeErr;
      return newQty;
    },
    onError: () => {
      // Server state diverged from our optimistic cache. Pull fresh so
      // the UI reflects what's actually there.
      qc.invalidateQueries({ queryKey: pantryKeys.list() });
    },
  });
}

export function useDeletePantryItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('pantry_items').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pantryKeys.all }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Snap-to-pantry: AI extraction + bulk add
// ─────────────────────────────────────────────────────────────────────────────

/** One item as the AI returns it (or as the user edits on review). */
export type SnapItem = {
  name: string;
  qty: number;
  unit: string;
  category: string;
  shelf_life_days: number;
};

export type ExtractMode = 'haul' | 'receipt';

/** Surface a structured edge-function error with a usable message. */
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
 * Send a base64 photo to extract-pantry-items and get back a list of
 * items the user can review on /pantry/snap/review.
 */
export function useExtractPantryItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      image_base64: string;
      mode: ExtractMode;
    }): Promise<{ items: SnapItem[]; mode: ExtractMode }> => {
      const { data, error } = await supabase.functions.invoke(
        'extract-pantry-items',
        { body: input },
      );
      if (error) {
        throw new Error(await readFunctionError(error, 'Extraction failed'));
      }
      // Both success and failure paths touch the AI cap; refresh the
      // displayed remaining-budget kicker.
      invalidateAiUsage(qc);
      return data as { items: SnapItem[]; mode: ExtractMode };
    },
    onError: () => {
      // Releases against the cap also fire on extraction failure server-
      // side; keep the client view in sync.
      invalidateAiUsage(qc);
    },
  });
}

/** Item shape passed to add_pantry_batch from the review screen. */
export type PantryBatchInput = {
  name: string;
  qty: number;
  unit: string;
  /** YYYY-MM-DD — pre-filled from purchased_at + shelf_life_days. */
  expires_at: string | null;
  /** YYYY-MM-DD — pulled from the "Purchased on" picker at top of
   *  the review screen. Null falls back to current_date server-side. */
  purchased_at: string | null;
  location: PantryLocation | null;
  category: string | null;
  shelf_life_days: number | null;
};

/** Result of add_pantry_batch — distinguishes new rows from merges into
 *  existing pantry items so the post-add toast can be specific
 *  ("Added 12 items · 3 merged"). */
export type PantryBatchResult = {
  added: number;
  merged: number;
  total: number;
};

export function useAddPantryBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (items: PantryBatchInput[]): Promise<PantryBatchResult> => {
      const { data, error } = await supabase.rpc('add_pantry_batch', {
        p_items: items.map((it) => ({
          name: it.name,
          qty: it.qty,
          unit: it.unit,
          expires_at: it.expires_at,
          purchased_at: it.purchased_at,
          location: it.location,
          category: it.category,
          shelf_life_days: it.shelf_life_days,
        })),
      });
      if (error) throw error;
      // RPC now returns jsonb { added, merged, total }. Backwards-compat
      // shim: if any field is missing, fall back to 0.
      const result = (data ?? {}) as Partial<PantryBatchResult>;
      return {
        added: Number(result.added ?? 0),
        merged: Number(result.merged ?? 0),
        total: Number(result.total ?? 0),
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: pantryKeys.all });
    },
  });
}
