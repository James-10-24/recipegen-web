// Recipe-form draft persistence to AsyncStorage. Survives backgrounding,
// process kills, accidental back-taps. Device-local only (does not sync
// across devices) — that's a v1.1 feature gated on a `drafts` table.
//
// Public API:
//   saveRecipeDraft(key, snapshot) — call after every form-state change
//     (the recipe form debounces 500ms before calling this)
//   loadRecipeDraft(key)            — call on form mount
//   clearRecipeDraft(key)           — call on successful submit, or when
//     the user explicitly taps "Discard draft"
//
// Key convention:
//   'new'              → the new-recipe screen
//   'edit:<recipeId>'  → editing an existing recipe

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { RecipeCategory } from '@/lib/recipe-categories';

const PREFIX = 'recipe-form-draft:';

/** The form's serialized state. Keep this in lockstep with the
 *  RecipeForm component's local state vars — adding a new field there
 *  without updating this shape silently drops it from drafts. */
export type RecipeDraftSnapshot = {
  /** Epoch ms when the draft was last written. Surfaced in the "Restored
   *  unsaved changes from <relative time>" banner so the user can decide
   *  if it's worth keeping. */
  savedAt: number;
  title: string;
  description: string;
  servings: string;
  prepMin: string;
  cookMin: string;
  instructions: string[];
  visibility: 'private' | 'public';
  category: RecipeCategory | null;
  tags: string[];
  /** IngredientRow[] from recipe-form.tsx. Typed loosely here so this
   *  helper doesn't pull a dependency on the form's internal types. */
  rows: unknown[];
};

export async function saveRecipeDraft(
  key: string,
  snapshot: Omit<RecipeDraftSnapshot, 'savedAt'>,
): Promise<void> {
  try {
    const payload: RecipeDraftSnapshot = { ...snapshot, savedAt: Date.now() };
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify(payload));
  } catch (e) {
    // Storage write failed (full disk, corrupted store). Don't crash the
    // form — autosave is best-effort.
    if (__DEV__) console.warn('saveRecipeDraft failed', e);
  }
}

export async function loadRecipeDraft(
  key: string,
): Promise<RecipeDraftSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RecipeDraftSnapshot;
    // Sanity check: if the payload was written by an older app version
    // and is missing required fields, treat it as no-draft rather than
    // restoring half a form. Pre-Q3 drafts stored `instructions` as a
    // single string; reject those rather than half-restoring with the
    // wrong shape — the user loses the in-progress draft but the form
    // stays consistent. (The new-recipe form-empty check would otherwise
    // produce a phantom restored banner with an empty step list.)
    if (typeof parsed.title !== 'string' || !Array.isArray(parsed.rows)) {
      return null;
    }
    if (!Array.isArray(parsed.instructions)) {
      return null;
    }
    return parsed;
  } catch (e) {
    if (__DEV__) console.warn('loadRecipeDraft failed', e);
    return null;
  }
}

export async function clearRecipeDraft(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(PREFIX + key);
  } catch (e) {
    if (__DEV__) console.warn('clearRecipeDraft failed', e);
  }
}

/** Render-helper for the "Restored from N minutes ago" banner. Returns
 *  a coarse human-readable string; an exact timestamp would feel out of
 *  proportion to the precision we actually have. */
export function formatDraftAge(savedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
