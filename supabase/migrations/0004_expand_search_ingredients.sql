-- Phase 3 follow-up: surface shelf_life_days + density_g_per_ml through the
-- ingredient search RPC so the client can auto-fill expiry dates and perform
-- mass ↔ volume conversion for pantry matching.

drop function if exists search_ingredients(text, int);

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
  where (i.user_id is null or i.user_id = auth.uid())
    and (
      i.name ilike q || '%'
      or i.name % q
      or exists (select 1 from unnest(i.aliases) a where a ilike q || '%' or a % q)
    )
  order by similarity desc, i.name asc
  limit lim;
$$;
