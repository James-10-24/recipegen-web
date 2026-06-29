import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { discoverKeys } from '@/lib/queries/discover';
import { recipesKeys } from '@/lib/queries/recipes';
import { supabase } from '@/lib/supabase';

const blockedKey = ['blocks'] as const;
const reportsKey = ['reports'] as const;

// ---------- Reports ----------

export type ReportReason = 'inappropriate' | 'spam' | 'incorrect' | 'other';
export type ReportSubject = 'recipe' | 'user';

export type UserReport = {
  id: string;
  subject_kind: ReportSubject;
  recipe_id: string | null;
  reported_user_id: string | null;
  reason: ReportReason;
  notes: string | null;
  status: 'pending' | 'reviewed' | 'dismissed' | 'actioned';
  created_at: string;
  recipe_title: string | null;
};

export function useMyReports() {
  return useQuery({
    queryKey: reportsKey,
    staleTime: 30_000,
    queryFn: async (): Promise<UserReport[]> => {
      const { data, error } = await supabase
        .from('reports')
        .select(
          'id, subject_kind, recipe_id, reported_user_id, reason, notes, status, created_at, recipes(title)',
        )
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        subject_kind: r.subject_kind,
        recipe_id: r.recipe_id,
        reported_user_id: r.reported_user_id,
        reason: r.reason,
        notes: r.notes,
        status: r.status,
        created_at: r.created_at,
        recipe_title: r.recipes?.title ?? null,
      }));
    },
  });
}

/** Withdraw a previously filed report. RLS gates on reporter_id = auth.uid(). */
export function useWithdrawReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('reports').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: reportsKey }),
  });
}

export function useSubmitReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      subject_kind: ReportSubject;
      recipe_id?: string;
      reported_user_id?: string;
      reason: ReportReason;
      notes?: string | null;
    }) => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');
      const { error } = await supabase.from('reports').insert({
        reporter_id: user.user.id,
        subject_kind: input.subject_kind,
        recipe_id: input.recipe_id ?? null,
        reported_user_id: input.reported_user_id ?? null,
        reason: input.reason,
        notes: input.notes?.slice(0, 1000) ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: reportsKey }),
  });
}

// ---------- Blocks ----------

export type BlockedUser = {
  blocked_id: string;
  display_name: string | null;
  blocked_at: string;
};

export function useBlockedUsers() {
  return useQuery({
    queryKey: blockedKey,
    staleTime: 30_000,
    queryFn: async (): Promise<BlockedUser[]> => {
      const { data, error } = await supabase
        .from('blocks')
        .select('blocked_id, created_at')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as { blocked_id: string; created_at: string }[];
      if (rows.length === 0) return [];
      const ids = Array.from(new Set(rows.map((r) => r.blocked_id)));
      const { data: namesData } = await supabase.rpc('display_names_for', {
        p_user_ids: ids,
      });
      const nameMap = new Map<string, string | null>();
      for (const n of (namesData ?? []) as { user_id: string; display_name: string | null }[]) {
        nameMap.set(n.user_id, n.display_name);
      }
      return rows.map((r) => ({
        blocked_id: r.blocked_id,
        display_name: nameMap.get(r.blocked_id) ?? null,
        blocked_at: r.created_at,
      }));
    },
  });
}

export function useBlockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (blocked_id: string) => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');
      if (user.user.id === blocked_id) {
        throw new Error("You can't block yourself");
      }
      const { error } = await supabase.from('blocks').insert({
        blocker_id: user.user.id,
        blocked_id,
      });
      // Unique-violation = already blocked, treat as success.
      if (error && !/duplicate key/i.test(error.message)) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: discoverKeys.all });
      qc.invalidateQueries({ queryKey: recipesKeys.all });
      qc.invalidateQueries({ queryKey: blockedKey });
    },
  });
}

export function useUnblockUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (blocked_id: string) => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) throw new Error('Not signed in');
      const { error } = await supabase
        .from('blocks')
        .delete()
        .eq('blocker_id', user.user.id)
        .eq('blocked_id', blocked_id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: discoverKeys.all });
      qc.invalidateQueries({ queryKey: recipesKeys.all });
    },
  });
}
