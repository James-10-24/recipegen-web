// Supabase Edge Function: generate-recipe
//
// Given a freeform user description, ask OpenAI for a structured recipe
// candidate. Same response shape as import-recipe so the client can reuse
// the post-import flow.
//
// Auth required. Each call atomically claims an AI budget slot before
// hitting OpenAI; if the user is over their daily cap, the function
// returns 429 without billing. Freeform prompts are run through the
// moderation API first.
//
// Deploy:
//   supabase functions deploy generate-recipe
// Set the API key once:
//   supabase secrets set OPENAI_API_KEY=sk-...

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

// Kept in lockstep with lib/recipe-categories.ts on the client. Deno
// edge functions can't import from the React Native bundle, so the list
// is duplicated here — six items, low maintenance cost.
const CATEGORIES = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Dessert', 'Drink'];

const RECIPE_SCHEMA = {
  type: 'object',
  required: [
    'title',
    'description',
    'servings',
    'prep_min',
    'cook_min',
    'instructions',
    'raw_ingredients',
    'category',
    'tags',
  ],
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    servings: { type: 'integer', minimum: 1 },
    prep_min: { type: ['integer', 'null'] },
    cook_min: { type: ['integer', 'null'] },
    instructions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ordered list of recipe steps. Each item is one step as a clear sentence — no numbering or "Step N:" prefix.',
    },
    raw_ingredients: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Each item is one ingredient line (qty + unit + name), e.g. "200 g flour", "2 cloves garlic, minced", "1 tbsp olive oil".',
    },
    category: {
      type: ['string', 'null'],
      enum: [...CATEGORIES, null],
      description: 'Best-fit meal category for the recipe. Null if none fit.',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description:
        '0-6 short free-form lowercase tags (e.g. "vegan", "weeknight", "one-pot"). No spaces — use hyphens. Skip if nothing meaningful.',
    },
  },
};

const SYSTEM_PROMPT = `You generate complete, realistic home recipes from short user descriptions.

LANGUAGE: Detect the language of the user's description. If it appears to be Simplified Chinese (Hanzi characters), output EVERY string field — title, description, ingredient lines, step text — in Simplified Chinese. Use 简体中文 cooking conventions (units like 克 / 毫升 / 个; ingredient names in Chinese; step instructions natural for a Chinese cook). Otherwise output everything in English. Do NOT mix languages within a recipe. The schema KEYS stay English regardless; only the VALUES adapt.

Output rules:
- title: 3-8 words, clear and inviting.
- ingredients: 5-15 lines. Each line is "<qty> <unit> <ingredient name>[, prep notes]". For English: metric (g, ml) for mass/volume; "pcs" or count words ("cloves", "slices") for whole items. For Chinese: 克 / 毫升 / 个 / 颗 / 块 / 片 as natural; ingredient names in Chinese. No fractions of grams.
- instructions: 3-8 ordered steps as an array of strings. Each item is one self-contained sentence. No numbering prefix.
- servings: integer; default to user's request, otherwise 4.
- prep_min / cook_min: realistic minutes. Null only if genuinely n/a.
- description: one short sentence, optional.
- category: pick exactly one of Breakfast, Lunch, Dinner, Snack, Dessert, Drink — whichever best fits the dish. Null only when none fit. (Category enum stays English even when the rest of the output is Chinese — it maps to a fixed app-side bucket.)
- tags: 0-6 short lowercase hyphenated tags. Use them to surface intent (vegan, gluten-free, one-pot, weeknight, kid-friendly, …). For Chinese recipes, English tags are still preferred (vegan, sichuan, one-pot) so cross-language Discover filters work. Skip generic words like "easy" or "tasty".
- Stay sensible: no impossible quantities, no contradictions.`;

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

  let body: { description?: string; servings?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const description = body.description?.trim();
  if (!description || description.length < 5) {
    return jsonResponse(
      { error: 'Provide a description of at least 5 characters.' },
      400,
    );
  }
  if (description.length > 600) {
    return jsonResponse({ error: 'Description is too long (max 600 chars).' }, 400);
  }

  // Moderation gate (free, fail-open on infra issues).
  const mod = await moderate(description);
  if (mod.flagged) {
    return jsonResponse(
      {
        error:
          "Sorry, that prompt isn't something I can generate a recipe for.",
      },
      400,
    );
  }

  // Atomic tier-aware claim (defends against concurrent cap evasion +
  // routes to the right bucket: free quota, credits, or pro fair-use).
  const claim = await claimOp(
    auth.user_id,
    'recipe_generate',
    ESTIMATED_COST_CENTS,
    auth.admin,
  );
  if (!claim.ok) {
    return jsonResponse(
      { error: aiCapExceededMessage(claim), ...claim },
      429,
    );
  }

  const userPrompt =
    body.servings && body.servings > 0
      ? `${description}\n\nMake it for ${body.servings} servings.`
      : description;

  let chat;
  try {
    chat = await openaiChat({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'recipe', strict: true, schema: RECIPE_SCHEMA },
      },
      max_tokens: 1500,
      temperature: 0.6,
    });
  } catch (err) {
    await releaseOp(claim.claim_id, auth.admin);
    if (err instanceof OpenAiError) {
      return jsonResponse({ error: err.message }, err.status >= 400 ? err.status : 502);
    }
    return jsonResponse({ error: `Generation failed: ${(err as Error).message}` }, 502);
  }

  await finalizeUsage(
    claim.claim_id,
    chat.tokens_in,
    chat.tokens_out,
    costCents(chat.model, chat.tokens_in, chat.tokens_out),
    auth.admin,
  );

  let recipe: any;
  try {
    recipe = JSON.parse(chat.content);
  } catch {
    return jsonResponse({ error: 'AI returned malformed JSON' }, 502);
  }

  const category =
    typeof recipe.category === 'string' && CATEGORIES.includes(recipe.category)
      ? recipe.category
      : null;
  const tags = Array.isArray(recipe.tags)
    ? recipe.tags
        .map((t: unknown) => String(t).toLowerCase().replace(/\s+/g, '-').slice(0, 24))
        .filter((t: string) => t.length > 0)
        .slice(0, 6)
    : [];

  return jsonResponse({
    title: String(recipe.title ?? 'Untitled recipe').slice(0, 200),
    description:
      recipe.description != null
        ? String(recipe.description).slice(0, 500)
        : null,
    servings: typeof recipe.servings === 'number' ? recipe.servings : null,
    prep_min: typeof recipe.prep_min === 'number' ? recipe.prep_min : null,
    cook_min: typeof recipe.cook_min === 'number' ? recipe.cook_min : null,
    instructions: Array.isArray(recipe.instructions)
      ? recipe.instructions
          .map((s: unknown) => String(s).slice(0, 1000))
          .filter((s: string) => s.trim().length > 0)
          .slice(0, 30)
      : [],
    photo_url: null,
    source_url: null,
    source_kind: 'ai_generate',
    category,
    tags,
    raw_ingredients: Array.isArray(recipe.raw_ingredients)
      ? recipe.raw_ingredients.map((s: unknown) => String(s).slice(0, 200))
      : [],
  });
});
