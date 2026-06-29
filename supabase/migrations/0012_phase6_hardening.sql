-- Phase 6 hardening — close audit gaps from the post-Phase-6 review.
--
-- Includes:
--   · reports.reporter_id ON DELETE SET NULL (was CASCADE) — preserve
--     moderation history when reporters delete their account.
--   · recipes.saved_from_id + unique index — track lineage of cloned
--     public recipes so save_recipe can refuse duplicate clones.
--   · save_recipe rewritten to:
--       a) reject when caller has already saved this source (unique constraint)
--       b) snapshot user-scoped source ingredients into the cloner's
--          namespace so clones are independently editable
--       c) populate saved_from_id
--   · search_public_recipes returns author display_name (single round-trip),
--     caps q length to 100 chars to avoid trigram-DOS at scale, and runs as
--     SECURITY DEFINER so it can join profiles without forcing public-read
--     on the profiles table.

-- ============================================================================
-- Reports: keep filings around when the reporter deletes their account
-- ============================================================================
alter table reports drop constraint if exists reports_reporter_id_fkey;
alter table reports
  alter column reporter_id drop not null;
alter table reports add constraint reports_reporter_id_fkey
  foreign key (reporter_id) references auth.users(id) on delete set null;

-- Reporter can withdraw their own filed report.
drop policy if exists reports_self_delete on reports;
create policy reports_self_delete on reports for delete
  using (reporter_id = auth.uid());

-- ============================================================================
-- Recipes: track save lineage to prevent duplicate clones
-- ============================================================================
alter table recipes
  add column if not exists saved_from_id uuid references recipes(id) on delete set null;

create unique index if not exists recipes_unique_save_per_source
  on recipes (user_id, saved_from_id)
  where saved_from_id is not null;

-- ============================================================================
-- save_recipe: dedupe + snapshot user-scoped ingredients + record lineage
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

  -- Already saved this source? Return the existing clone instead of creating
  -- a duplicate. (The unique index also enforces this; giving the caller
  -- back the existing id is friendlier than a 500.)
  select id into v_existing
  from recipes
  where user_id = v_user and saved_from_id = p_recipe_id;
  if v_existing is not null then
    return v_existing;
  end if;

  -- Race-safe insert: two concurrent calls can both pass the SELECT above,
  -- so guard against the unique index winner-takes-all behavior. The loser
  -- re-fetches the winner's id and returns it.
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
    -- Belt-and-suspenders: by the time we hit this branch the winner has
    -- committed, so the row must exist. If somehow it doesn't (caller
    -- raced against a delete), fail loudly rather than return null.
    if v_new_id is null then
      raise exception 'Concurrent save: winner row missing';
    end if;
    return v_new_id;
  end;

  -- Walk ingredients. For each user-scoped row owned by someone else, snapshot
  -- it into the cloner's namespace (or reuse a prior snapshot by name) so the
  -- cloner can search/edit the row from the ingredient picker. Canonical
  -- ingredients (user_id IS NULL) are referenced as-is.
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
      -- Reuse a prior snapshot only when name AND default_unit AND density
      -- all match — otherwise insert a fresh snapshot so we don't silently
      -- re-bind to the cloner's "Salt" with a different density and corrupt
      -- coverage/conversion math on the cloned recipe.
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

-- ============================================================================
-- search_public_recipes: bake author display_name in, cap q length,
-- become SECURITY DEFINER so the profiles join works without exposing
-- profile rows broadly.
-- ============================================================================
drop function if exists search_public_recipes(text, int);
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
