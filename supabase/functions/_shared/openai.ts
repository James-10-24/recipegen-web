// Thin OpenAI Chat Completions wrapper. Avoids pulling in the full SDK so
// the function bundle stays small.
//
// Auto-retries up to twice on transient OpenAI errors (429 rate limit, 5xx)
// with exponential-ish backoff (600ms, 1500ms). Pinned model snapshots
// live as exported constants so generate-recipe / import-recipe /
// normalize-ingredient don't drift across deploys.

// deno-lint-ignore-file no-explicit-any

/** Pinned model snapshots. Bump deliberately when validating new behavior. */
export const MODELS = {
  MINI: 'gpt-4o-mini-2024-07-18',
  FULL: 'gpt-4o-2024-08-06',
} as const;

/** Content can be a plain string (text-only) or an ordered array of parts.
 *  Use the array form when sending images alongside text — pass each image
 *  as a `data:image/...;base64,…` URL via the `image_url` part. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
    };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
};

export type ChatOptions = {
  model: string;
  messages: ChatMessage[];
  /** OpenAI structured-output spec — pass `{ type: 'json_schema', json_schema: {...} }`. */
  response_format?: any;
  max_tokens?: number;
  temperature?: number;
};

export type ChatResult = {
  content: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
};

export class OpenAiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const OPENAI_TIMEOUT_MS = 30_000;
/** Backoff between attempts. Length of array = max retries. Exponential-ish
 *  spacing absorbs both transient blips and short rate-limit storms. */
const RETRY_BACKOFFS_MS = [600, 1500];

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function doChat(opts: ChatOptions): Promise<ChatResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    throw new OpenAiError(500, 'OPENAI_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        response_format: opts.response_format,
        max_tokens: opts.max_tokens ?? 1500,
        temperature: opts.temperature ?? 0.7,
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    const e = err as { name?: string };
    if (e.name === 'AbortError') {
      throw new OpenAiError(504, 'OpenAI took too long to respond');
    }
    throw new OpenAiError(502, `OpenAI request failed: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new OpenAiError(
      resp.status,
      `OpenAI ${resp.status}: ${body.slice(0, 240)}`,
    );
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new OpenAiError(502, 'OpenAI returned no content');
  }

  return {
    content,
    model: data?.model ?? opts.model,
    tokens_in: data?.usage?.prompt_tokens ?? 0,
    tokens_out: data?.usage?.completion_tokens ?? 0,
  };
}

export async function openaiChat(opts: ChatOptions): Promise<ChatResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
    try {
      return await doChat(opts);
    } catch (err) {
      lastErr = err;
      const more = attempt < RETRY_BACKOFFS_MS.length;
      const retryable = err instanceof OpenAiError && isRetryable(err.status);
      if (!more || !retryable) break;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFFS_MS[attempt]));
    }
  }
  throw lastErr;
}
