-- ============================================================================
-- 0032_recipe_language.sql
--
-- Localization foundation (see docs/V1_SCOPE_DECISIONS.md).
--
-- 1. Schema: nullable text column on `recipes`. App-side enforced via
--    lib/recipe-language.ts (one of: 'en' | 'zh-Hans'); the column is
--    text so the list can evolve without a migration. NULL means
--    "language not detected" — legacy rows pre-launch + any rows where
--    auto-detection couldn't decide. Discover filter UX treats NULL as
--    "shows in any language tab" so old recipes don't disappear.
--    Partial index keeps the Discover language-chip filter cheap.
-- 2. search_public_recipes: add an optional p_language filter and return
--    the language column so the client can badge feed cards.
-- 3. save_recipe: snapshot the source language alongside title / tags /
--    category so cloned recipes inherit the same classification.
-- ============================================================================

alter table recipes add column if not exists language text;
create index if not exists recipes_language
  on recipes(language) where language is not null;

-- ---------------------------------------------------------------------------
-- search_public_recipes — extend signature with optional language filter.
-- Drop-and-recreate (Postgres doesn't allow signature changes via REPLACE).
-- All existing filtering (visibility / moderation / suspended authors /
-- blocks / category) is preserved verbatim from the 0028 version.
--
-- Language filter semantics: when p_language is given, return rows
-- matching that language OR rows with NULL language (legacy pre-launch
-- rows shouldn't vanish from any language tab — they're "language
-- unknown," not "language other"). Once detection is universal,
-- backfilling can tighten this.
-- ---------------------------------------------------------------------------
drop function if exists search_public_recipes(text, int, text);
create or replace function search_public_recipes(
  q text default '',
  lim int default 20,
  p_category text default null,
  p_language text default null
)
returns table (
  id uuid,
  user_id uuid,
  title text,
  description text,
  photo_url text,
  servings int,
  prep_min int,
  cook_min int,
  category text,
  language text,
  similarity real,
  created_at timestamptz,
  author_name text
)
language plpgsql stable security definer set search_path = public as $$
declare
  q_clean text := left(coalesce(q, ''), 100);
  cat_clean text := nullif(trim(coalesce(p_category, '')), '');
  lang_clean text := nullif(trim(coalesce(p_language, '')), '');
  caller uuid := auth.uid();
begin
  if public._is_anonymous() then
    raise exception 'Guests cannot browse the community library' using errcode = '42501';
  end if;

  return query
  select r.id, r.user_id, r.title, r.description, r.photo_url,
         r.servings, r.prep_min, r.cook_min,
         r.category,
         r.language,
         coalesce(case when q_clean = '' then 0 else similarity(r.title, q_clean) end, 0)::real,
         r.created_at,
         p.display_name
  from recipes r
  left join profiles p on p.id = r.user_id
  where r.visibility = 'public'
    and r.moderation_status = 'approved'
    and coalesce(p.account_status, 'active'::account_status) = 'active'
    and not exists (
      select 1 from blocks b
      where b.blocker_id = caller and b.blocked_id = r.user_id
    )
    and (cat_clean is null or r.category = cat_clean)
    and (lang_clean is null or r.language = lang_clean or r.language is null)
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
revoke all on function search_public_recipes(text, int, text, text) from public;
grant execute on function search_public_recipes(text, int, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- save_recipe — copy language onto the clone so the saved recipe inherits
-- the source's classification. Body is otherwise identical to the 0031
-- version; just threading `language` through the insert column list +
-- values list alongside `category`.
-- ---------------------------------------------------------------------------
create or replace function save_recipe(p_recipe_id uuid)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_source recipes%rowtype;
  v_source_author text;
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
  if v_source.moderation_status <> 'approved' then
    raise exception 'Recipe is not approved for the public library';
  end if;
  if exists (
    select 1 from blocks
    where blocker_id = v_user and blocked_id = v_source.user_id
  ) then
    raise exception 'Cannot save from a blocked user';
  end if;

  select display_name into v_source_author from profiles where id = v_source.user_id;

  select id into v_existing
  from recipes
  where user_id = v_user and saved_from_id = p_recipe_id;
  if v_existing is not null then
    return v_existing;
  end if;

  begin
    insert into recipes (
      user_id, title, description, photo_url, servings, prep_min, cook_min,
      instructions, source_url, visibility, category, language, tags, diet_tags,
      saved_from_id, saved_from_author_name,
      moderation_status, moderated_at
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
      v_source.category,
      v_source.language,
      v_source.tags,
      v_source.diet_tags,
      p_recipe_id,
      v_source_author,
      'approved',
      now()
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
           i.is_canonical as ing_is_canonical,
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
    if (v_row.ing_user_id is null and v_row.ing_is_canonical = true)
       or v_row.ing_user_id = v_user then
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

    insert into recipe_ingredients (
      recipe_id, ingredient_id, qty, unit, notes, sort_order
    ) values (
      v_new_id, v_target_ing_id, v_row.qty, v_row.unit, v_row.notes, v_row.sort_order
    );
  end loop;

  return v_new_id;
end;
$$;
