// Supabase Edge Function: normalize-ingredient
//
// Suggests a canonical name, common aliases, default unit, category,
// shelf life, and density for a user-typed ingredient. The client uses
// this to pre-fill the "Add new ingredient" form so user-created rows
// are richer (and likelier to fuzzy-match recipe lines later, and to
// participate in unit conversion via density).
//
// Auth required. Charged against the daily AI cap (cheapest of our calls
// in practice — typically < 0.5 cents).
//
// Deploy:
//   supabase functions deploy normalize-ingredient

// deno-lint-ignore-file no-explicit-any

import { jsonResponse, preflightResponse } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import {
  aiCapExceededMessage,
  claimOp,
  costCents,
  finalizeUsage,
  releaseOp,
} from '../_shared/usage.ts';
import { MODELS, OpenAiError, openaiChat } from '../_shared/openai.ts';
import { moderate } from '../_shared/moderation.ts';

const MODEL = MODELS.MINI;
const ESTIMATED_COST_CENTS = 1;

const SUGGESTION_SCHEMA = {
  type: 'object',
  required: [
    'canonical_name',
    'aliases',
    'category',
    'default_unit',
    'shelf_life_days',
    'density_g_per_ml',
  ],
  additionalProperties: false,
  properties: {
    canonical_name: {
      type: 'string',
      description:
        'The most generic widely-used name for this ingredient, in Title Case.',
    },
    aliases: {
      type: 'array',
      items: { type: 'string' },
      description: '0-4 common alternative spellings or names, lowercase.',
    },
    category: {
      type: 'string',
      enum: ['produce', 'meat', 'seafood', 'dairy', 'grain', 'pantry', 'other'],
    },
    default_unit: {
      type: 'string',
      enum: ['g', 'ml', 'pcs'],
      description:
        'Unit ingredients of this kind are most often bought in. g for solids by mass, ml for liquids, pcs for whole-item count.',
    },
    shelf_life_days: {
      type: ['integer', 'null'],
      description: 'Rough fridge/pantry shelf life. Null when too variable.',
    },
    density_g_per_ml: {
      type: ['number', 'null'],
      description:
        'Approximate density (grams per millilitre) — only when the ingredient could be measured in either mass or volume (e.g. flour 0.53, olive oil 0.92, milk 1.03). Null for purely-mass items (meat) and purely-count items (eggs).',
    },
  },
};

const SYSTEM_PROMPT = `You normalize informal ingredient names into a canonical catalog form for a home-cooking app.

Be conservative:
- Prefer the most generic widely-used name. "extra-virgin olive oil" → "Olive oil". "san marzano canned tomatoes" → "Canned tomatoes". "scallions" → "Spring onion".
- aliases: practical alternatives users might type, not synonyms in other languages. ["evoo"], ["green onions"].
- category: produce/meat/seafood/dairy/grain/pantry/other. Spices and oils → pantry. Eggs → dairy.
- default_unit: g for solids, ml for liquids, pcs for whole items (eggs, lemons, garlic cloves).
- shelf_life_days: short for fresh items (3-7), long for shelf-stable (180+), null when truly variable.
- density_g_per_ml: only set for ingredients commonly measured in BOTH mass and volume (flour, sugar, oils, dairy liquids, honey). Leave null for whole items (eggs, lemons, cloves), most meats and produce, and items only bought by mass.`;

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

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const name = body.name?.trim();
  if (!name || name.length < 2) {
    return jsonResponse({ error: 'Provide an ingredient name' }, 400);
  }
  if (name.length > 80) {
    return jsonResponse({ error: 'Name is too long (max 80 chars)' }, 400);
  }

  const mod = await moderate(name);
  if (mod.flagged) {
    return jsonResponse({ error: "Sorry, that's not an ingredient I can normalize." }, 400);
  }

  const claim = await claimOp(
    auth.user_id,
    'ingredient_normalize',
    ESTIMATED_COST_CENTS,
    auth.admin,
  );
  if (!claim.ok) {
    return jsonResponse(
      { error: aiCapExceededMessage(claim), ...claim },
      429,
    );
  }

  let chat;
  try {
    chat = await openaiChat({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: name },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ingredient', strict: true, schema: SUGGESTION_SCHEMA },
      },
      max_tokens: 300,
      temperature: 0.2,
    });
  } catch (err) {
    await releaseOp(claim.claim_id, auth.admin);
    if (err instanceof OpenAiError) {
      return jsonResponse({ error: err.message }, err.status >= 400 ? err.status : 502);
    }
    return jsonResponse({ error: `Normalization failed: ${(err as Error).message}` }, 502);
  }

  await finalizeUsage(
    claim.claim_id,
    chat.tokens_in,
    chat.tokens_out,
    costCents(chat.model, chat.tokens_in, chat.tokens_out),
    auth.admin,
  );

  let parsed: any;
  try {
    parsed = JSON.parse(chat.content);
  } catch {
    return jsonResponse({ error: 'AI returned malformed JSON' }, 502);
  }

  return jsonResponse({
    canonical_name: String(parsed.canonical_name ?? name).slice(0, 80),
    aliases: Array.isArray(parsed.aliases)
      ? parsed.aliases.map((s: unknown) => String(s).slice(0, 60))
      : [],
    category: String(parsed.category ?? 'other'),
    default_unit: String(parsed.default_unit ?? 'g'),
    shelf_life_days:
      typeof parsed.shelf_life_days === 'number' ? parsed.shelf_life_days : null,
    density_g_per_ml:
      typeof parsed.density_g_per_ml === 'number' &&
      parsed.density_g_per_ml > 0 &&
      parsed.density_g_per_ml < 5
        ? parsed.density_g_per_ml
        : null,
  });
});
