// Supabase Edge Function: extract-pantry-items
//
// Vision-driven pantry input. Takes a user-snapped photo (haul shot or
// receipt) and returns a structured list of items the client can review
// and bulk-add to the pantry.
//
// Auth required, anonymous blocked. Each call atomically claims an AI
// budget slot and finalizes/releases on success/failure — same pattern
// as generate-recipe and import-recipe.
//
// Deploy:
//   supabase functions deploy extract-pantry-items
// Set the API key once:
//   supabase secrets set OPENAI_API_KEY=sk-...

// deno-lint-ignore-file no-explicit-any

import { jsonResponse, preflightResponse } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { moderate } from '../_shared/moderation.ts';
import {
  aiCapExceededMessage,
  claimOp,
  costCents,
  finalizeUsage,
  releaseOp,
} from '../_shared/usage.ts';
import { MODELS, OpenAiError, openaiChat } from '../_shared/openai.ts';

const MODEL = MODELS.MINI;
// Vision calls cost ~3x text — bump the placeholder so claims that race
// against an empty cap don't slip through. finalizeUsage corrects to
// the real cost from token counts after the call.
const ESTIMATED_COST_CENTS = 2;

// Cap inbound payload at ~3 MB (compressed JPEG at 1024 px is typically
// 100–250 KB; base64 inflation pushes a 2 MB original to ~2.7 MB). Anything
// bigger is almost certainly the client forgetting to compress.
const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024;

const PANTRY_SCHEMA = {
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        required: ['name', 'qty', 'unit', 'category', 'shelf_life_days'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description:
              'Plain ingredient name, lowercased, no brand. Examples: "tomato", "whole milk", "cheddar cheese".',
          },
          qty: {
            type: 'number',
            description:
              'Best-effort count or measurement. Default 1 if uncertain.',
            minimum: 0,
          },
          unit: {
            type: 'string',
            description:
              'Measurement unit. Use "pcs" for countable items; "g"/"kg" for solids by weight; "ml"/"l" for liquids.',
          },
          category: {
            type: 'string',
            enum: ['produce', 'dairy', 'meat', 'seafood', 'grain', 'pantry', 'other'],
          },
          shelf_life_days: {
            type: 'integer',
            minimum: 1,
            maximum: 3650,
            description:
              'Typical fridge or pantry shelf life. Used to pre-fill the expiry date on the review screen.',
          },
        },
      },
    },
  },
} as const;

const HAUL_PROMPT = `You identify grocery items in a single user-snapped photo for a meal-planning pantry app.

Output rules:
- Only include items that look like fresh groceries someone would store: produce, meat, seafood, dairy, grains, pantry staples, beverages, condiments. Skip cooked meals, plates, utensils, packaging trash.
- Each item is one row: name + qty + unit + category + shelf_life_days.
- name: ingredient-style ("tomato", "ground beef", "whole milk"), not a brand or product name. If a packaged item has a clear ingredient ("Greek yogurt", "rice noodles"), use that.
- qty / unit: best-effort. Five tomatoes → qty 5, unit "pcs". A bag of flour → qty 1, unit "kg" (rough estimate). A bottle → qty 1, unit "l" or "ml".
- category: choose the closest of produce | dairy | meat | seafood | grain | pantry | other.
- shelf_life_days: realistic fridge/pantry life. Fresh produce 5–14, meat 2–3, dairy 7–28, dry goods 180–730.
- Return at most 30 items. If something is ambiguous, leave it out rather than guess wildly.`;

const RECEIPT_PROMPT = `You parse grocery receipts into a structured list for a pantry app.

Output rules:
- Read each line item. EXPAND abbreviations to full ingredient names: "WHL MLK GAL" → "whole milk", "TOM ROMA" → "roma tomato", "GRND BF 80/20" → "ground beef".
- Skip non-grocery lines: subtotals, taxes, discounts, store loyalty fees, bag charges, tips. If you're unsure whether a line is grocery or not, skip it.
- qty: count from the receipt (e.g., "BANANAS 3 @ $0.59"). If only price + unit shown, default qty 1.
- unit: if the receipt shows weight ("LB", "KG"), convert to "g" or "kg". Otherwise use "pcs".
- category: closest match — produce | dairy | meat | seafood | grain | pantry | other.
- shelf_life_days: typical fridge/pantry life for that ingredient.
- Return at most 30 items.`;

type Mode = 'haul' | 'receipt';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req);
  if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (auth.is_anonymous) {
    return jsonResponse(
      { error: 'Save your account to use AI features.' },
      403,
    );
  }

  // Reject payloads that exceed the inline-base64 budget. Without this the
  // function would happily forward a 10 MB image to OpenAI and burn budget
  // before returning.
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_PAYLOAD_BYTES) {
    return jsonResponse(
      { error: 'Image too large. Compress to under 3 MB before uploading.' },
      413,
    );
  }

  let body: { image_base64?: string; mode?: Mode };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const imageBase64 = body.image_base64?.trim();
  if (!imageBase64) {
    return jsonResponse({ error: 'image_base64 is required' }, 400);
  }
  if (imageBase64.length > MAX_PAYLOAD_BYTES) {
    return jsonResponse(
      { error: 'Image too large. Compress to under 3 MB before uploading.' },
      413,
    );
  }

  const mode: Mode = body.mode === 'receipt' ? 'receipt' : 'haul';

  const claim = await claimOp(
    auth.user_id,
    'pantry_extract',
    ESTIMATED_COST_CENTS,
    auth.admin,
  );
  if (!claim.ok) {
    return jsonResponse(
      { error: aiCapExceededMessage(claim), ...claim },
      429,
    );
  }

  // OpenAI accepts either a public URL or a data URL. Inline data keeps
  // the round-trip simple — no Supabase Storage upload needed for what
  // is genuinely transient input.
  const dataUrl = `data:image/jpeg;base64,${imageBase64}`;

  let chat;
  try {
    chat = await openaiChat({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: mode === 'receipt' ? RECEIPT_PROMPT : HAUL_PROMPT,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                mode === 'receipt'
                  ? "Here's the receipt. Extract every grocery line into a structured list."
                  : "Here's the haul. Identify each grocery item.",
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'auto' },
            },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'pantry_items', strict: true, schema: PANTRY_SCHEMA },
      },
      max_tokens: 1500,
      temperature: 0.2,
    });
  } catch (err) {
    await releaseOp(claim.claim_id, auth.admin);
    if (err instanceof OpenAiError) {
      return jsonResponse({ error: err.message }, err.status >= 400 ? err.status : 502);
    }
    return jsonResponse(
      { error: `Extraction failed: ${(err as Error).message}` },
      502,
    );
  }

  let parsed: { items: any[] };
  try {
    parsed = JSON.parse(chat.content);
  } catch {
    // Refund the op — we got a malformed response, the user shouldn't
    // pay for our parser bug or a wonky model output.
    await releaseOp(claim.claim_id, auth.admin);
    return jsonResponse({ error: 'AI returned malformed JSON' }, 502);
  }

  // Defensive normalization — strict-schema responses are usually fine
  // but bound the output anyway so a wonky model doesn't blow up the
  // client.
  const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 30) : [];
  const cleaned = items
    .map((it: any) => ({
      name: String(it.name ?? '').slice(0, 80).trim().toLowerCase(),
      qty: typeof it.qty === 'number' && it.qty > 0 ? it.qty : 1,
      unit: String(it.unit ?? 'pcs').slice(0, 16).trim() || 'pcs',
      category: ['produce', 'dairy', 'meat', 'seafood', 'grain', 'pantry', 'other']
        .includes(it.category)
        ? it.category
        : 'other',
      shelf_life_days:
        typeof it.shelf_life_days === 'number' && it.shelf_life_days >= 1
          ? Math.min(3650, Math.floor(it.shelf_life_days))
          : 7,
    }))
    .filter((it) => it.name.length > 0);

  // Zero items extracted — user got nothing actionable back. Refund the
  // op rather than counting it against their monthly quota. Matches the
  // pattern in import-recipe's quality-gate refund. The recovery screen
  // shows "Your AI quota wasn't charged — try again."
  if (cleaned.length === 0) {
    await releaseOp(claim.claim_id, auth.admin);
    return jsonResponse({ items: [], mode, refunded: true });
  }

  // Items were extracted — finalize the cost against the user's quota.
  await finalizeUsage(
    claim.claim_id,
    chat.tokens_in,
    chat.tokens_out,
    costCents(chat.model, chat.tokens_in, chat.tokens_out),
    auth.admin,
  );

  // Defense-in-depth: the vision model has its own content filter, but
  // run the joined extracted names through the text moderation API too
  // before they land in the user's ingredients catalog. moderate()
  // fails open on infra issues (logged in function logs).
  if (cleaned.length > 0) {
    const namesJoined = cleaned.map((it) => it.name).join('\n');
    const mod = await moderate(namesJoined);
    if (mod.flagged) {
      return jsonResponse(
        {
          error:
            "We couldn't add those items. The photo seems to contain something outside grocery scope.",
        },
        400,
      );
    }
  }

  return jsonResponse({ items: cleaned, mode });
});
