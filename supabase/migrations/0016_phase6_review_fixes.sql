-- Phase 6 review fixes — closes the punch list from the post-Phase-6 audit.
--
-- Adds:
--   · recipes.moderation_status / moderated_at / moderation_categories
--     and gates public visibility behind moderation_status='approved' in
--     RLS + search_public_recipes
--   · recipes.saved_from_author_name — denormalized snapshot at clone time
--     so attribution survives the source going private or its author being
--     deleted (supersedes the RLS-gated lookup that silently nulled out)
--   · reports rate limiting (per-reporter daily cap + per-target cap)
--   · reports.notes is required when reason='other' (CHECK)
--   · reports.reviewed_at / reviewed_by — moderator triage columns
--   · save_recipe: requires source approved; requires source still has a
--     defined author for attribution; snapshots author name; treats
--     orphaned (user_id IS NULL but is_canonical=false) ingredients as
--     user-scoped (snapshot, not pass-through canonical)

-- ============================================================================
-- Recipes: moderation pipeline
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'moderation_status') then
    create type moderation_status as enum ('pending', 'approved', 'rejected');
  end if;
end
$$;

alter table recipes
  add column if not exists moderation_status moderation_status not null default 'pending',
  add column if not exists moderated_at timestamptz,
  add column if not exists moderation_categories text[],
  add column if not exists saved_from_author_name text;

-- Backfill existing public recipes as approved so they don't disappear from
-- Discover the moment this migration lands. New publishes will go through
-- the moderate-recipe edge function.
update recipes set moderation_status = 'approved', moderated_at = coalesce(moderated_at, updated_at)
where visibility = 'public' and moderation_status = 'pending';

-- ============================================================================
-- recipes_read: hide unmoderated public recipes from non-owners
-- ============================================================================
drop policy if exists recipes_read on recipes;
create policy recipes_read on recipes for select using (
  user_id = auth.uid()
  or (
    visibility = 'public'
    and moderation_status = 'approved'
    and not exists (
      select 1 from blocks b
      where b.blocker_id = auth.uid() and b.blocked_id = recipes.user_id
    )
  )
);

-- ============================================================================
-- recipes_insert / recipes_update: gate public visibility behind moderation
--
-- Clients can write visibility='private' freely. They cannot publish
-- (visibility='public') unless moderation_status='approved' — which only
-- the moderate-recipe edge function (service role) can set. This forces
-- all publishes through the moderation gate.
--
-- Guests are still capped at 10 recipes and blocked from public visibility
-- entirely (defense-in-depth from 0013).
-- ============================================================================
drop policy if exists recipes_insert on recipes;
create policy recipes_insert on recipes for insert
with check (
  user_id = auth.uid()
  and (visibility = 'private' or moderation_status = 'approved')
  and (visibility = 'private' or not public._is_anonymous())
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
  and (visibility = 'private' or moderation_status = 'approved')
  and (visibility = 'private' or not public._is_anonymous())
);

-- A trigger resets moderation_status to 'pending' whenever a non-service-role
-- client edits a recipe's moderated content fields. This stops a malicious
-- client from approving a recipe via the edge function then mutating its
-- title/description/instructions/photo to objectionable content while keeping
-- the approved flag.
create or replace function public._reset_moderation_on_edit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Service role bypasses RLS but triggers still run. Detect by JWT role.
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    return new;
  end if;
  if (
    new.title is distinct from old.title
    or new.description is distinct from old.description
    or new.instructions is distinct from old.instructions
    or new.photo_url is distinct from old.photo_url
  ) then
    new.moderation_status := 'pending';
    new.moderated_at := null;
    new.moderation_categories := null;
    -- If the recipe was public, force it back to private until the client
    -- re-publishes through moderate-recipe. Otherwise the row would be
    -- pending+public, which RLS refuses on update anyway — making the row
    -- private explicitly is the friendlier failure mode.
    if new.visibility = 'public' then
      new.visibility := 'private';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists recipes_reset_moderation_on_edit on recipes;
create trigger recipes_reset_moderation_on_edit
before update on recipes
for each row
execute function public._reset_moderation_on_edit();

-- ============================================================================
-- search_public_recipes: filter on moderation_status='approved' (defense-in-
-- depth — recipes_read already gates this for non-owner SELECTs, but explicit
-- in the RPC makes the contract obvious)
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
    and r.moderation_status = 'approved'
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
-- saved_set_for_caller: which source recipe IDs has the caller already cloned?
-- Used by the Discover tab to badge already-saved rows.
-- ============================================================================
create or replace function saved_set_for_caller(p_source_ids uuid[])
returns table (source_id uuid, clone_id uuid)
language sql security invoker set search_path = public stable as $$
  select saved_from_id, id
  from recipes
  where user_id = auth.uid()
    and saved_from_id = any(p_source_ids);
$$;
revoke all on function saved_set_for_caller(uuid[]) from public;
grant execute on function saved_set_for_caller(uuid[]) to authenticated;

-- ============================================================================
-- save_recipe: snapshot author name + require source approved + treat
-- orphaned non-canonical ingredients as user-scoped (don't pass through)
-- ============================================================================
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

  -- Snapshot the source author's display name at clone time so attribution
  -- survives the source going private or the author deleting their account.
  select display_name into v_source_author from profiles where id = v_source.user_id;

  -- Already saved this source? Return the existing clone instead of creating
  -- a duplicate.
  select id into v_existing
  from recipes
  where user_id = v_user and saved_from_id = p_recipe_id;
  if v_existing is not null then
    return v_existing;
  end if;

  begin
    insert into recipes (
      user_id, title, description, photo_url, servings, prep_min, cook_min,
      instructions, source_url, visibility, tags, diet_tags, saved_from_id,
      saved_from_author_name,
      -- Clones are private + already approved (they were approved at the
      -- source). The clone owner can edit freely; edits will reset
      -- moderation_status if they ever flip back to public.
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
    -- Pass through canonical ingredients (everyone shares them) and the
    -- caller's own custom ingredients. Snapshot everything else — including
    -- ORPHANED non-canonical rows (user_id IS NULL but is_canonical=false,
    -- left behind by a deleted author) so they don't masquerade as canonical
    -- and contaminate other cloners' coverage math.
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

    insert into recipe_ingredients (recipe_id, ingredient_id, qty, unit, notes, sort_order)
    values (v_new_id, v_target_ing_id, v_row.qty, v_row.unit, v_row.notes, v_row.sort_order);
  end loop;

  return v_new_id;
end;
$$;

-- ============================================================================
-- Reports: rate limit + "other" requires notes + reviewer columns
-- ============================================================================

-- Drop existing CHECK if a previous migration variant added it under a
-- different name. Then add the strict notes-required-for-other constraint.
alter table reports drop constraint if exists reports_other_requires_notes;
alter table reports add constraint reports_other_requires_notes
  check (reason <> 'other' or (notes is not null and length(trim(notes)) > 0));

-- Moderator triage columns. Service-role-only writes; clients can read their
-- own reports' status (via existing reports_self_read) but reviewer details
-- aren't exposed back to the reporter.
alter table reports
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewer_notes text;

-- Per-reporter daily cap (20 reports/24h) + per-target dedupe (max 3 against
-- the same target/24h). Spam-reporting now fails loudly instead of drowning
-- the queue.
create or replace function public._enforce_report_rate_limit()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total int;
  v_per_target int;
begin
  -- Service role inserts (e.g. backfills) skip the limit.
  if coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
    return new;
  end if;

  select count(*) into v_total
  from reports
  where reporter_id = new.reporter_id
    and created_at > now() - interval '24 hours';
  if v_total >= 20 then
    raise exception 'Report rate limit exceeded — try again tomorrow'
      using errcode = '42901';
  end if;

  if new.subject_kind = 'recipe' then
    select count(*) into v_per_target
    from reports
    where reporter_id = new.reporter_id
      and recipe_id = new.recipe_id
      and created_at > now() - interval '24 hours';
  else
    select count(*) into v_per_target
    from reports
    where reporter_id = new.reporter_id
      and reported_user_id = new.reported_user_id
      and created_at > now() - interval '24 hours';
  end if;
  if v_per_target >= 3 then
    raise exception 'You''ve already reported this — moderators are reviewing'
      using errcode = '42902';
  end if;

  return new;
end;
$$;

drop trigger if exists reports_rate_limit on reports;
create trigger reports_rate_limit
before insert on reports
for each row
execute function public._enforce_report_rate_limit();
