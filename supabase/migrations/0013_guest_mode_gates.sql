-- Guest-mode gates — server-side enforcement for the four guest restrictions
-- and the audit ship-blockers. Client-side gates exist in the app, but
-- everything below is what actually protects the system from a determined
-- caller with the anon JWT.
--
-- Restrictions enforced here (in order):
--   1. Guests cannot SELECT public recipes from the community library
--      (search_public_recipes RPC throws).
--   2. Guests cannot INSERT or UPDATE a recipe with visibility='public'
--      (recipes_insert / recipes_update policies).
--   3. Guests cannot save (clone) public recipes (save_recipe RPC throws).
--   4. Guests cannot have more than 10 recipes total (recipes_insert
--      counts existing rows for guests and rejects the 11th).
--   5. Guests cannot file reports (reports_self_insert policy).
--
-- Anonymous detection uses auth.jwt() ->> 'is_anonymous'. Supabase sets
-- this claim on the JWT for sessions started via signInAnonymously().

-- ============================================================================
-- Helper — read once, used everywhere. Stable + parallel-safe.
-- ============================================================================
create or replace function public._is_anonymous()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false);
$$;

-- ============================================================================
-- recipes — gate visibility + per-guest cap of 10 rows
-- ============================================================================
drop policy if exists recipes_insert on recipes;
create policy recipes_insert on recipes for insert
with check (
  user_id = auth.uid()
  -- Guests can never insert a public recipe.
  and (visibility = 'private' or not public._is_anonymous())
  -- Guests are capped at 10 recipes total. Counts the caller's existing
  -- rows. Negligible perf cost since the cap is small.
  and (
    not public._is_anonymous()
    or (select count(*) from recipes r where r.user_id = auth.uid()) < 10
  )
);

drop policy if exists recipes_update on recipes;
create policy recipes_update on recipes for update
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  -- Block private→public flips for guests too. Without this they could
  -- create as private then update to public, sidestepping the insert gate.
  and (visibility = 'private' or not public._is_anonymous())
);

-- ============================================================================
-- reports — gate inserts behind a real account
-- ============================================================================
drop policy if exists reports_self_insert on reports;
create policy reports_self_insert on reports for insert
with check (
  reporter_id = auth.uid()
  and not public._is_anonymous()
);

-- ============================================================================
-- search_public_recipes — refuse anon callers
-- ============================================================================
create or replace function search_public_recipes(q text default '', lim int default 20)
returns table (
  id uuid,
  user_id uuid,
  title text,
  description text,
  photo_url text,
  servings int,
  prep_min int,
  cook_min int,
  similarity real,
  created_at timestamptz,
  author_name text
)
language plpgsql stable security definer set search_path = public as $$
declare
  q_clean text := left(coalesce(q, ''), 100);
  caller uuid := auth.uid();
begin
  if public._is_anonymous() then
    raise exception 'Guests cannot browse the community library' using errcode = '42501';
  end if;

  return query
  select r.id, r.user_id, r.title, r.description, r.photo_url,
         r.servings, r.prep_min, r.cook_min,
         coalesce(case when q_clean = '' then 0 else similarity(r.title, q_clean) end, 0)::real,
         r.created_at,
         p.display_name
  from recipes r
  left join profiles p on p.id = r.user_id
  where r.visibility = 'public'
    and not exists (
      select 1 from blocks b
      where b.blocker_id = caller and b.blocked_id = r.user_id
    )
    and (
      q_clean = ''
      or r.title ilike q_clean || '%'
      or r.title % q_clean
    )
  order by
    case when q_clean = '' then 0 else similarity(r.title, q_clean) end desc nulls last,
    r.created_at desc
  limit greatest(1, least(lim, 50));
end;
$$;
revoke all on function search_public_recipes(text, int) from public;
grant execute on function search_public_recipes(text, int) to authenticated;

-- ============================================================================
-- save_recipe — defense-in-depth, gate guests
-- (the Discover tab is gated UI-side, so this is a backstop)
-- ============================================================================
create or replace function save_recipe(p_recipe_id uuid)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_source recipes%rowtype;
  v_new_id uuid;
  v_target_ing_id uuid;
  v_existing uuid;
  v_row record;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;
  if public._is_anonymous() then
    raise exception 'Guests cannot save community recipes' using errcode = '42501';
  end if;

  select * into v_source from recipes where id = p_recipe_id;
  if v_source.id is null then
    raise exception 'Recipe not found';
  end if;
  if v_source.user_id = v_user then
    raise exception 'You already own this recipe';
  end if;
  if v_source.visibility <> 'public' then
    raise exception 'Recipe is not public';
  end if;
  if exists (
    select 1 from blocks
    where blocker_id = v_user and blocked_id = v_source.user_id
  ) then
    raise exception 'Cannot save from a blocked user';
  end if;

  select id into v_existing
  from recipes
  where user_id = v_user and saved_from_id = p_recipe_id;
  if v_existing is not null then
    return v_existing;
  end if;

  begin
    insert into recipes (
      user_id, title, description, photo_url, servings, prep_min, cook_min,
      instructions, source_url, visibility, tags, diet_tags, saved_from_id
    ) values (
      v_user,
      v_source.title,
      v_source.description,
      v_source.photo_url,
      v_source.servings,
      v_source.prep_min,
      v_source.cook_min,
      v_source.instructions,
      v_source.source_url,
      'private',
      v_source.tags,
      v_source.diet_tags,
      p_recipe_id
    )
    returning id into v_new_id;
  exception when unique_violation then
    select id into v_new_id
    from recipes
    where user_id = v_user and saved_from_id = p_recipe_id;
    if v_new_id is null then
      raise exception 'Concurrent save: winner row missing';
    end if;
    return v_new_id;
  end;

  for v_row in
    select ri.qty, ri.unit, ri.notes, ri.sort_order,
           i.id          as ing_id,
           i.user_id     as ing_user_id,
           i.name        as ing_name,
           i.aliases     as ing_aliases,
           i.category    as ing_category,
           i.default_unit as ing_default_unit,
           i.shelf_life_days as ing_shelf_life_days,
           i.package_size as ing_package_size,
           i.package_unit as ing_package_unit,
           i.density_g_per_ml as ing_density_g_per_ml
    from recipe_ingredients ri
    join ingredients i on i.id = ri.ingredient_id
    where ri.recipe_id = p_recipe_id
    order by ri.sort_order
  loop
    if v_row.ing_user_id is null or v_row.ing_user_id = v_user then
      v_target_ing_id := v_row.ing_id;
    else
      select id into v_target_ing_id
      from ingredients
      where user_id = v_user
        and lower(name) = lower(v_row.ing_name)
        and default_unit is not distinct from v_row.ing_default_unit
        and density_g_per_ml is not distinct from v_row.ing_density_g_per_ml
      limit 1;

      if v_target_ing_id is null then
        insert into ingredients (
          name, aliases, category, default_unit, shelf_life_days,
          package_size, package_unit, density_g_per_ml,
          user_id, is_canonical
        ) values (
          v_row.ing_name, v_row.ing_aliases, v_row.ing_category,
          v_row.ing_default_unit, v_row.ing_shelf_life_days,
          v_row.ing_package_size, v_row.ing_package_unit,
          v_row.ing_density_g_per_ml,
          v_user, false
        )
        returning id into v_target_ing_id;
      end if;
    end if;

    insert into recipe_ingredients (recipe_id, ingredient_id, qty, unit, notes, sort_order)
    values (v_new_id, v_target_ing_id, v_row.qty, v_row.unit, v_row.notes, v_row.sort_order);
  end loop;

  return v_new_id;
end;
$$;
