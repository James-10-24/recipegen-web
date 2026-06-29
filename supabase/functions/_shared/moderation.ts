// OpenAI Moderation API wrapper. Used to gate freeform user prompts before
// we bill against the daily cap.
//
// Failure mode: if the moderation call itself fails (network, rate limit,
// 5xx), we fail OPEN — i.e., we don't block the user on infra issues. The
// downstream completion call still has the strict JSON schema gate, so
// the worst case is "an offensive recipe got generated." That's a content
// problem, not a security problem.

const MODERATION_TIMEOUT_MS = 8_000;

export type ModerationResult = {
  flagged: boolean;
  /** Categories that triggered the flag (when flagged is true). */
  categories: string[];
};

// Track once-per-cold-start so we don't spam logs on every invocation.
let _warnedNoKey = false;

export async function moderate(input: string): Promise<ModerationResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    if (!_warnedNoKey) {
      _warnedNoKey = true;
      console.warn(
        'OPENAI_API_KEY not set; moderation is failing OPEN. ' +
          'Display-name and prompt screens are no-ops until the secret is configured.',
      );
    }
    return { flagged: false, categories: [] };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODERATION_TIMEOUT_MS);

  try {
    const resp = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'omni-moderation-latest', input }),
    });
    if (!resp.ok) {
      // Surface fail-open events in function logs so the team can spot
      // sustained moderation outages (during which malicious prompts
      // would pass unfiltered).
      console.warn(
        `moderation unavailable (HTTP ${resp.status}); failing open`,
      );
      return { flagged: false, categories: [] };
    }
    const data = await resp.json();
    const result = data?.results?.[0];
    if (!result) {
      console.warn('moderation returned no result; failing open');
      return { flagged: false, categories: [] };
    }
    if (!result.flagged) return { flagged: false, categories: [] };
    const cats = Object.entries(result.categories ?? {})
      .filter(([_, v]) => v === true)
      .map(([k]) => k);
    return { flagged: true, categories: cats };
  } catch (err) {
    // Network/timeout — fail open, but make it visible.
    console.warn(
      'moderation request failed; failing open:',
      (err as Error).message,
    );
    return { flagged: false, categories: [] };
  } finally {
    clearTimeout(timer);
  }
}
