// Supabase Edge Function: moderate-recipe
//
// App Store UGC compliance gate for the public library. Direct INSERT/UPDATE
// to recipes with visibility='public' is blocked by RLS (migration 0016) —
// only this function, running with the service role, can flip a recipe's
// moderation_status to 'approved' and publish it.
//
// Flow:
//   1. Client saves the recipe as private (or updates an existing private
//      recipe) using the standard recipes mutation.
//   2. Client calls this function with { recipe_id }.
//   3. We re-fetch the recipe under the user's RLS context to confirm
//      ownership and read its content.
//   4. We run OpenAI's omni-moderation on (title + description + instructions)
//      and on the photo_url image (if present).
//   5. Pass → service-role update sets moderation_status='approved',
//      moderated_at=now(), visibility='public'. Recipe appears in Discover.
//   6. Fail → moderation_status='rejected', visibility stays 'private',
//      and we surface the flagged categories to the caller so they can
//      explain to the user why publishing was refused.
//
// Auth required. Guests are refused (consistent with the rest of the public
// library — they can't publish anyway, but we fail fast here too).
//
// Deploy:
//   supabase functions deploy moderate-recipe

// deno-lint-ignore-file no-explicit-any
import { jsonResponse, preflightResponse } from '../_shared/cors.ts';
import { authenticate } from '../_shared/auth.ts';
import { moderate } from '../_shared/moderation.ts';

const IMAGE_MODERATION_TIMEOUT_MS = 12_000;

type ImageModerationResult = {
  flagged: boolean;
  categories: string[];
};

/**
 * Run OpenAI's omni-moderation on a remote image URL. Mirrors the text
 * moderate() helper's fail-open posture — if the moderation API itself
 * is down, we don't block the publish on infra noise. The text-channel
 * moderation still runs alongside, so a textual policy violation won't
 * sneak through.
 */
async function moderateImage(url: string): Promise<ImageModerationResult> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) return { flagged: false, categories: [] };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    IMAGE_MODERATION_TIMEOUT_MS,
  );
  try {
    const resp = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url } }],
      }),
    });
    if (!resp.ok) {
      console.warn(
        `image moderation unavailable (HTTP ${resp.status}); failing open`,
      );
      return { flagged: false, categories: [] };
    }
    const data = await resp.json();
    const result = data?.results?.[0];
    if (!result?.flagged) return { flagged: false, categories: [] };
    const cats = Object.entries(result.categories ?? {})
      .filter(([_, v]) => v === true)
      .map(([k]) => k);
    return { flagged: true, categories: cats };
  } catch (err) {
    console.warn(
      'image moderation request failed; failing open:',
      (err as Error).message,
    );
    return { flagged: false, categories: [] };
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflightResponse();
  if (req.method !== 'POST')
    return jsonResponse({ error: 'Method not allowed' }, 405);

  const auth = await authenticate(req);
  if (!auth) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (auth.is_anonymous) {
    return jsonResponse(
      { error: 'Save your account to publish recipes.' },
      403,
    );
  }

  let body: { recipe_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }
  const recipeId = body.recipe_id;
  if (!recipeId || typeof recipeId !== 'string') {
    return jsonResponse({ error: 'recipe_id is required' }, 400);
  }

  // Fetch under the user's RLS context — anyone can call this function with
  // any recipe_id, but RLS gives us back only their own rows. If we can't
  // see it, the user doesn't own it (or it doesn't exist).
  const { data: recipe, error: fetchErr } = await auth.client
    .from('recipes')
    .select(
      'id, user_id, title, description, instructions, photo_url, visibility, moderation_status',
    )
    .eq('id', recipeId)
    .maybeSingle();
  if (fetchErr) {
    return jsonResponse({ error: fetchErr.message }, 500);
  }
  if (!recipe) {
    return jsonResponse({ error: 'Recipe not found' }, 404);
  }
  if (recipe.user_id !== auth.user_id) {
    // Belt-and-suspenders — RLS should have already filtered this.
    return jsonResponse({ error: 'Not your recipe' }, 403);
  }

  // Concatenate the moderated text fields. Lots of recipes have empty
  // descriptions or instructions; that's fine — the moderation API tolerates
  // short input. Cap at 8KB so we don't blow the OpenAI token limit on a
  // pathological 50K-instruction recipe.
  //
  // Q3: instructions is now text[] (one entry per step). Flatten to one
  // prose blob for the moderation pass — the moderator sees the same words
  // as before, just joined with newlines.
  const instructionsBlob = Array.isArray(recipe.instructions)
    ? recipe.instructions.filter(Boolean).join('\n\n')
    : '';
  const textParts = [recipe.title, recipe.description, instructionsBlob]
    .filter(Boolean)
    .join('\n\n');
  const textInput = textParts.slice(0, 8_000);

  const [textResult, imageResult] = await Promise.all([
    textInput ? moderate(textInput) : Promise.resolve({ flagged: false, categories: [] as string[] }),
    recipe.photo_url
      ? moderateImage(recipe.photo_url)
      : Promise.resolve({ flagged: false, categories: [] as string[] }),
  ]);

  const flaggedCategories = Array.from(
    new Set([...textResult.categories, ...imageResult.categories]),
  );

  if (textResult.flagged || imageResult.flagged) {
    // Stamp the row as rejected (service role bypasses RLS so this write
    // always lands; the BEFORE UPDATE trigger detects service-role role
    // claim and skips the moderation reset).
    const { error: rejectErr } = await auth.admin
      .from('recipes')
      .update({
        moderation_status: 'rejected',
        moderated_at: new Date().toISOString(),
        moderation_categories: flaggedCategories,
        // Force back to private — the row may have been public+approved
        // before this call (re-publishing after edits).
        visibility: 'private',
      })
      .eq('id', recipeId);
    if (rejectErr) {
      return jsonResponse({ error: rejectErr.message }, 500);
    }
    return jsonResponse(
      {
        ok: false,
        rejected: true,
        categories: flaggedCategories,
        message:
          "Your recipe didn't pass our community guidelines. Edit it and try again, or reach out via Settings → Terms of use.",
      },
      // 200, not 4xx — the moderation gate succeeded; the user just got a
      // "no" answer. The client surfaces the message; an HTTP error would
      // imply infra failure.
      200,
    );
  }

  // Approve + publish.
  const { error: approveErr } = await auth.admin
    .from('recipes')
    .update({
      moderation_status: 'approved',
      moderated_at: new Date().toISOString(),
      moderation_categories: null,
      visibility: 'public',
    })
    .eq('id', recipeId);
  if (approveErr) {
    return jsonResponse({ error: approveErr.message }, 500);
  }

  return jsonResponse({ ok: true, approved: true });
});
