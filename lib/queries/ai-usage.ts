import { useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export const DAILY_CAP_CENTS = 20;

export type AiUsageToday = {
  spent_cents: number;
  cap_cents: number;
  /** Next UTC midnight as ISO timestamp. */
  reset_at: string;
};

export const aiUsageKeys = {
  today: ['ai-usage', 'today'] as const,
};

function startOfTodayUtcIso(): string {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

export function useAiUsageToday() {
  return useQuery({
    queryKey: aiUsageKeys.today,
    staleTime: 5_000,
    queryFn: async (): Promise<AiUsageToday> => {
      const startIso = startOfTodayUtcIso();
      const { data, error } = await supabase
        .from('ai_usage')
        .select('cost_cents')
        .gte('created_at', startIso);
      if (error) throw error;
      const spent = (data ?? []).reduce(
        (s, r) => s + ((r as any).cost_cents ?? 0),
        0,
      );
      const reset = new Date(startIso);
      reset.setUTCDate(reset.getUTCDate() + 1);
      return {
        spent_cents: spent,
        cap_cents: DAILY_CAP_CENTS,
        reset_at: reset.toISOString(),
      };
    },
  });
}

/** Hours (rounded up) until UTC midnight reset. Useful for cap-exceeded copy. */
export function hoursUntilReset(reset_at: string): number {
  const ms = new Date(reset_at).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 3_600_000));
}

/** Call after any AI mutation to nudge the usage hook forward. */
export function invalidateAiUsage(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: aiUsageKeys.today });
}
