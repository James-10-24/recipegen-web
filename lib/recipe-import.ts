// Import helpers for Phase 5a — URL → structured recipe.
//
// `importRecipeFromUrl` calls the Supabase `import-recipe` edge function,
// then parses each raw ingredient line into qty/unit/name and tries to
// match the name against the canonical ingredients catalog via the
// `search_ingredients` RPC. Unmatched lines come back for the UI to
// surface to the user.

import { FunctionsHttpError } from '@supabase/supabase-js';

import { isRecipeCategory, type RecipeCategory } from '@/lib/recipe-categories';
import { detectRecipeLanguage } from '@/lib/recipe-language';
import { supabase } from '@/lib/supabase';

/** Thin alias of detectRecipeLanguage that takes a single string (an
 *  ingredient line, not a recipe title+description pair). Used by the
 *  pending-alias logger to tag rows by language for admin filtering. */
function detectRawLanguage(raw: string): string | null {
  return detectRecipeLanguage(raw, null);
}

// ---------- Types ----------

/** Where the recipe candidate came from. URL-based imports populate
 *  source_url; AI-generated and pasted-text recipes leave it null. */
export type RecipeSourceKind = 'url' | 'url_ai' | 'ai_generate' | 'paste';

export type RecipeCandidate = {
  title: string;
  description: string | null;
  servings: number | null;
  prep_min: number | null;
  cook_min: number | null;
  instructions: string[];
  photo_url: string | null;
  source_url: string | null;
  source_kind?: RecipeSourceKind;
  category?: string | null;
  tags?: string[];
  raw_ingredients: string[];
};

export type ParsedLine = {
  raw: string;
  qty: number | null;
  unit: string | null;
  name: string;
  notes: string | null;
};

export type ImportedIngredient = {
  parsed: ParsedLine;
  match: {
    ingredient_id: string;
    ingredient_name: string;
    default_unit: string;
  } | null;
};

export type ImportResult = {
  title: string;
  description: string | null;
  servings: number;
  prep_min: number | null;
  cook_min: number | null;
  instructions: string[];
  photo_url: string | null;
  source_url: string | null;
  source_kind: RecipeSourceKind;
  category: RecipeCategory | null;
  tags: string[];
  ingredients: ImportedIngredient[];
};

// ---------- Ingredient-line parser ----------

const COMMON_UNITS = new Set([
  'g', 'gram', 'grams',
  'kg', 'kilogram', 'kilograms', 'kilo', 'kilos',
  'mg', 'milligram', 'milligrams',
  'oz', 'ounce', 'ounces',
  'lb', 'lbs', 'pound', 'pounds',
  'ml', 'milliliter', 'milliliters',
  'l', 'liter', 'liters', 'litre', 'litres',
  'tsp', 'teaspoon', 'teaspoons',
  'tbsp', 'tablespoon', 'tablespoons',
  'cup', 'cups',
  'pint', 'pt',
  'quart', 'qt',
  'gallon', 'gal',
  'pcs', 'piece', 'pieces',
  'clove', 'cloves',
  'slice', 'slices',
  'pinch', 'dash', 'handful',
  // Simplified Chinese units — see docs/V1_SCOPE_DECISIONS.md (Q7f).
  // Most map to canonical units via UNIT_CANONICAL below. 斤 (500g) and
  // 两 (50g) are kept as their own units for now — converting to grams
  // at parse time would lose user intent ("2 jin pork" reads as "2 jin
  // pork," not "1000g pork"). Future unit-converter work can normalize
  // them for cross-recipe aggregation.
  '克', '千克', '斤', '两',           // mass
  '毫升', '升',                       // volume
  '大勺', '小勺',                     // spoon-based volume
  '个', '颗', '块', '片', '把',       // counts
]);

// Adjectives (not units) that commonly lead an ingredient line after the qty.
// We skip them when deciding on a unit, and strip them when building the
// catalog-search query.
const SIZE_ADJECTIVES = new Set([
  'whole', 'large', 'medium', 'small', 'tiny', 'big',
  'extra', 'fresh', 'dried', 'new', 'baby',
]);

// Prep verbs that commonly trail (or lead) an ingredient name. We strip them
// from the search query so "new potatoes halved or quartered" resolves to
// "potatoes" for catalog matching.
const PREP_VERBS = new Set([
  'chopped', 'diced', 'sliced', 'halved', 'quartered',
  'trimmed', 'zested', 'juiced', 'crushed', 'minced',
  'grated', 'shredded', 'peeled', 'cored', 'drained',
  'rinsed', 'soaked', 'cooked', 'steamed', 'roasted',
  'finely', 'thinly', 'coarsely', 'roughly', 'thickly',
]);

const UNIT_CANONICAL: Record<string, string> = {
  gram: 'g', grams: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  milligram: 'mg', milligrams: 'mg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', milliliters: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp',
  cups: 'cup',
  piece: 'pcs', pieces: 'pcs',
  // Clove/cloves/slice/slices are count-like; map to 'pcs' so the pantry
  // matcher and unit converter treat them consistently with canonical
  // piece-counted ingredients.
  clove: 'pcs', cloves: 'pcs',
  slice: 'pcs', slices: 'pcs',
  // Simplified Chinese aliases — same canonical-unit logic. 斤 / 两
  // intentionally NOT mapped: they're distinct mass units that need
  // their own conversion (1 斤 = 500g, 1 两 = 50g) for cross-recipe
  // pantry math, not a string rename. v1.x unit-converter work picks
  // those up. Today they parse through as `斤` / `两` literal units.
  '克': 'g',
  '千克': 'kg',
  '毫升': 'ml',
  '升': 'l',
  '大勺': 'tbsp', '小勺': 'tsp',
  // Count-words → pcs (same model as clove/slice above). 把 (handful)
  // is fuzzy quantity but ships as pcs so the line at least parses;
  // user can adjust qty in the form row.
  '个': 'pcs', '颗': 'pcs', '块': 'pcs', '片': 'pcs', '把': 'pcs',
};

function canonicalizeUnit(u: string): string {
  const lower = u.toLowerCase();
  return UNIT_CANONICAL[lower] ?? lower;
}

function parseQty(raw: string): number | null {
  const s = raw.trim();
  // Unicode fractions that show up in copy: ½ ¼ ¾ ⅓ ⅔ etc.
  const UNI_FRAC: Record<string, number> = {
    '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
    '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
    '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
  };
  if (s in UNI_FRAC) return UNI_FRAC[s];
  const intUniFrac = /^(\d+)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/.exec(s);
  if (intUniFrac) return parseInt(intUniFrac[1], 10) + UNI_FRAC[intUniFrac[2]];

  // "1/2"
  if (/^\d+\/\d+$/.test(s)) {
    const [a, b] = s.split('/').map(Number);
    return b === 0 ? null : a / b;
  }
  // "1 1/2"
  const m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m) {
    const b = Number(m[3]);
    if (b === 0) return null;
    return Number(m[1]) + Number(m[2]) / b;
  }
  // "1-2" or "1 to 2" → upper bound (better to over-buy than fall short).
  const range = /^(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (range) return Number(range[2]);

  // Plain number.
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function splitNameAndNotes(name: string): { name: string; notes: string | null } {
  const commaIdx = name.indexOf(',');
  if (commaIdx < 0) return { name: name.trim(), notes: null };
  return {
    name: name.slice(0, commaIdx).trim(),
    notes: name.slice(commaIdx + 1).trim() || null,
  };
}

export function parseIngredientLine(raw: string): ParsedLine {
  const text = raw.replace(/\s+/g, ' ').trim();

  // Leading qty: digits, unicode fractions, plain fractions, ranges, decimals.
  const qtyMatch = /^([\d\.\/\-\s½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]+)\s+(.+)$/u.exec(text);
  if (!qtyMatch) {
    const split = splitNameAndNotes(text);
    return { raw, qty: null, unit: null, ...split };
  }

  const qty = parseQty(qtyMatch[1]);
  const rest = qtyMatch[2].trim();

  if (qty === null) {
    const split = splitNameAndNotes(text);
    return { raw, qty: null, unit: null, ...split };
  }

  // Walk past leading size adjectives ("small", "large", etc.) — they're
  // descriptors, not units. Check subsequent tokens for a real unit.
  let tokens = rest.split(' ');
  let leadingAdjectives: string[] = [];
  while (tokens.length > 0 && SIZE_ADJECTIVES.has(tokens[0].toLowerCase())) {
    leadingAdjectives.push(tokens[0]);
    tokens = tokens.slice(1);
  }

  const first = tokens[0]?.toLowerCase() ?? '';
  const second = tokens[1]?.toLowerCase() ?? '';

  // Reconstruct the full "name" portion preserving adjectives so the user
  // sees the original phrasing on the form row; the cleaned version is only
  // used for catalog search.
  const nameWithAdjectives = (extraPrefix: string[] = []) =>
    [...leadingAdjectives, ...extraPrefix, ...tokens].join(' ').trim();

  if (first === 'fl' && second === 'oz') {
    const remainder = tokens.slice(2).join(' ');
    const split = splitNameAndNotes(remainder || nameWithAdjectives());
    return { raw, qty, unit: 'fl oz', ...split };
  }

  if (COMMON_UNITS.has(first)) {
    const remainder = tokens.slice(1).join(' ');
    // Adjectives drop here — they were between qty and unit, but the unit
    // clarifies the name enough that the adjective usually isn't needed.
    const split = splitNameAndNotes(remainder || tokens.join(' '));
    return { raw, qty, unit: canonicalizeUnit(first), ...split };
  }

  // No explicit unit found; keep adjectives in the displayed name.
  const split = splitNameAndNotes(nameWithAdjectives());
  return { raw, qty, unit: null, ...split };
}

/**
 * Reduce an ingredient name down to its likely catalog form.
 * "new potatoes halved or quartered" → "potatoes"
 * "finely chopped fresh parsley" → "parsley"
 * "extra-virgin olive oil" → "olive oil" (first 3 tokens after stripping)
 */
export function cleanNameForSearch(name: string): string {
  let tokens = name
    .toLowerCase()
    .replace(/[(),]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // Strip leading noise (size/prep) and joining words.
  const leadingNoise = new Set([
    ...SIZE_ADJECTIVES,
    ...PREP_VERBS,
    'of', 'a', 'an', 'the',
  ]);
  while (tokens.length > 0 && leadingNoise.has(tokens[0])) tokens.shift();

  // Strip trailing prep verbs and glue words ("halved or quartered").
  const trailingNoise = new Set([...PREP_VERBS, 'and', 'or', 'to', 'with']);
  while (tokens.length > 0 && trailingNoise.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  // Cap at 3 tokens — canonical ingredient names are rarely longer.
  return tokens.slice(0, 3).join(' ');
}

// ---------- Orchestration ----------

const MATCH_SIMILARITY_THRESHOLD = 0.4;

async function findCatalogMatch(
  name: string,
): Promise<ImportedIngredient['match']> {
  const q = cleanNameForSearch(name);
  if (!q) return null;
  const { data, error } = await supabase.rpc('search_ingredients', {
    q,
    lim: 1,
  });
  if (error) return null;
  const top = data?.[0];
  if (!top || top.similarity < MATCH_SIMILARITY_THRESHOLD) {
    // Log the miss so the admin can see which terms users want but
    // can't match. Fire-and-forget — never block the import flow on
    // the log call, and never surface errors (it's a server-side
    // SECURITY DEFINER no-op for guests / admins / empty terms).
    void (async () => {
      try {
        await supabase.rpc('log_pending_alias', {
          p_raw_name: name,
          p_language: detectRawLanguage(name),
        });
      } catch {
        // intentional swallow
      }
    })();
    return null;
  }
  return {
    ingredient_id: top.id,
    ingredient_name: top.name,
    default_unit: top.default_unit,
  };
}

async function invokeAndUnwrap<T>(
  fnName: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fnName, {
    body: payload,
  });

  if (error) {
    // FunctionsHttpError stores the actual Response in `context`; its body
    // carries the edge function's JSON `{ error: "..." }` payload. Surface
    // that so the user knows *why* the call failed.
    if (error instanceof FunctionsHttpError) {
      try {
        const body = await error.context.json();
        if (body?.error) throw new Error(String(body.error));
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message) throw parseErr;
      }
    }
    throw new Error(error.message || `${fnName} failed`);
  }
  return data as T;
}

async function candidateToResult(
  candidate: RecipeCandidate,
  fallbackKind: RecipeSourceKind,
): Promise<ImportResult> {
  const ingredients: ImportedIngredient[] = await Promise.all(
    candidate.raw_ingredients.map(async (raw) => {
      const parsed = parseIngredientLine(raw);
      const match = await findCatalogMatch(parsed.name);
      return { parsed, match };
    }),
  );

  return {
    title: candidate.title,
    description: candidate.description,
    servings: candidate.servings ?? 2,
    prep_min: candidate.prep_min,
    cook_min: candidate.cook_min,
    instructions: Array.isArray(candidate.instructions) ? candidate.instructions : [],
    photo_url: candidate.photo_url,
    source_url: candidate.source_url,
    source_kind: candidate.source_kind ?? fallbackKind,
    category: isRecipeCategory(candidate.category) ? candidate.category : null,
    tags: Array.isArray(candidate.tags) ? candidate.tags : [],
    ingredients,
  };
}

export async function importRecipeFromUrl(url: string): Promise<ImportResult> {
  const candidate = await invokeAndUnwrap<RecipeCandidate>('import-recipe', {
    url,
  });
  if (!candidate || !candidate.title) {
    throw new Error('Nothing importable on that page.');
  }
  return candidateToResult(candidate, 'url');
}

export async function generateRecipeFromPrompt(input: {
  description: string;
  servings?: number;
}): Promise<ImportResult> {
  const candidate = await invokeAndUnwrap<RecipeCandidate>('generate-recipe', {
    description: input.description,
    servings: input.servings,
  });
  if (!candidate || !candidate.title) {
    throw new Error('AI returned nothing usable.');
  }
  return candidateToResult(candidate, 'ai_generate');
}

/** Extract a recipe from freeform text (typically pasted from clipboard).
 *  Counts as one AI op against the same per-tier quota as URL parses. */
export async function extractRecipeFromText(text: string): Promise<ImportResult> {
  const candidate = await invokeAndUnwrap<RecipeCandidate>(
    'extract-recipe-from-text',
    { text },
  );
  if (!candidate || !candidate.title) {
    throw new Error('Nothing importable in that text.');
  }
  return candidateToResult(candidate, 'paste');
}

export type IngredientNormalization = {
  canonical_name: string;
  aliases: string[];
  category: string;
  default_unit: string;
  shelf_life_days: number | null;
  density_g_per_ml: number | null;
};

export async function normalizeIngredient(
  name: string,
): Promise<IngredientNormalization> {
  return invokeAndUnwrap<IngredientNormalization>('normalize-ingredient', {
    name,
  });
}
