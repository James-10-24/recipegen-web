-- Filter orphaned non-canonical ingredients out of search_ingredients.
--
-- Background: ingredients.user_id is ON DELETE SET NULL (migration 0011),
-- so when a user deletes their account their custom ingredients orphan
-- (user_id IS NULL but is_canonical = false). The RLS ingredients_read
-- policy intentionally still permits reading orphans — that's how
-- existing recipe clones, pantry rows, and shopping list calculations
-- keep resolving the ingredient name/density after the original author
-- is gone. Removing the orphans would silently break references on
-- other users' recipes.
--
-- But search_ingredients (powering the ingredient picker) wasn't
-- filtering them out. The picker would surface canonical "Tomato"
-- alongside zero-to-many orphaned "Tomato"s — each potentially carrying
-- the deleted author's quirky density value — letting users
-- accidentally bind a new recipe to a stale orphan instead of the
-- real canonical row.
--
-- Fix: search shows only canonical rows + the caller's own custom rows.
-- Orphans remain readable via direct id lookup (existing references keep
-- working) but become invisible to the picker, so no new bindings.
--
-- No data migration — purely a query filter change.

create or replace function search_ingredients(q text, lim int default 10)
returns table (
  id uuid,
  name text,
  category text,
  default_unit text,
  shelf_life_days int,
  density_g_per_ml numeric,
  user_id uuid,
  similarity real
)
language sql stable security invoker set search_path = public as $$
  select i.id, i.name, i.category, i.default_unit,
         i.shelf_life_days, i.density_g_per_ml, i.user_id,
         greatest(
           similarity(i.name, q),
           coalesce((select max(similarity(a, q)) from unnest(i.aliases) a), 0)
         ) as similarity
  from ingredients i
  where (
    -- Canonical shared shelf — everyone sees these.
    (i.user_id is null and i.is_canonical = true)
    -- Caller's own custom ingredients.
    or i.user_id = auth.uid()
  )
    and (
      i.name ilike q || '%'
      or i.name % q
      or exists (select 1 from unnest(i.aliases) a where a ilike q || '%' or a % q)
    )
  order by similarity desc, i.name asc
  limit lim;
$$;
