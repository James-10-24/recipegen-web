-- Phase 6: public library + Apple UGC compliance.
--
-- Adds:
--   · reports table — flag a recipe or user for review
--   · blocks table — hide a user's recipes from your view
--   · recipes_read RLS update — public recipes are filtered by blocks
--   · save_recipe RPC — atomically clone a public recipe + ingredients
--     into the caller's library
--   · display_names_for RPC — narrow profile-name lookup so the public
--     library can attribute authors without exposing the rest of the
--     profiles table
--   · ingredients.user_id ON DELETE SET NULL — when a user deletes their
--     account, their custom ingredients orphan to canonical (preserving
--     other users' clones that may reference them) instead of failing
--     the cascade

-- ============================================================================
-- Ingredients: don't lose other users' clones when an author deletes account
-- ============================================================================
alter table ingredients drop constraint ingredients_user_id_fkey;
alter table ingredients add constraint ingredients_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- ============================================================================
-- Reports
-- ============================================================================
create type report_subject as enum ('recipe', 'user');
create type report_reason as enum ('inappropriate', 'spam', 'incorrect', 'other');
create type report_status as enum ('pending', 'reviewed', 'dismissed', 'actioned');

create table reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  subject_kind report_subject not null,
  recipe_id uuid references recipes(id) on delete set null,
  reported_user_id uuid references auth.users(id) on delete set null,
  reason report_reason not null,
  notes text check (notes is null or length(notes) <= 1000),
  status report_status not null default 'pending',
  created_at timestamptz not null default now(),
  check (
    (subject_kind = 'recipe' and recipe_id is not null)
    or (subject_kind = 'user' and reported_user_id is not null)
  )
);
create index reports_reporter on reports(reporter_id, created_at desc);
create index reports_recipe on reports(recipe_id) where recipe_id is not null;
create index reports_user on reports(reported_user_id) where reported_user_id is not null;

alter table reports enable row level security;
create policy reports_self_read on reports for select using (reporter_id = auth.uid());
create policy reports_self_insert on reports for insert with check (reporter_id = auth.uid());

-- ============================================================================
-- Blocks
-- ============================================================================
create table blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index blocks_blocker on blocks(blocker_id);

alter table blocks enable row level security;
create policy blocks_owner on blocks for all
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- ============================================================================
-- recipes_read: hide blocked users' recipes from public discovery
-- (owner can still see their own recipes regardless of who blocked whom).
-- ============================================================================
drop policy recipes_read on recipes;
create policy recipes_read on recipes for select using (
  user_id = auth.uid()
  or (
    visibility = 'public'
    and not exists (
      select 1 from blocks b
      where b.blocker_id = auth.uid() and b.blocked_id = recipes.user_id
    )
  )
);

-- ============================================================================
-- display_names_for: scoped profile lookup
-- ============================================================================
create or replace function display_names_for(p_user_ids uuid[])
returns table (user_id uuid, display_name text)
language sql security definer set search_path = public stable as $$
  select id, display_name from profiles where id = any(p_user_ids);
$$;
revoke all on function display_names_for(uuid[]) from public;
grant execute on function display_names_for(uuid[]) to authenticated;

-- ============================================================================
-- save_recipe: clone a public recipe (with ingredients) into caller's library
-- ============================================================================
create or replace function save_recipe(p_recipe_id uuid)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_source recipes%rowtype;
  v_new_id uuid;
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
  -- Honor blocks: don't let a blocker save from a blocked author either.
  if exists (
    select 1 from blocks
    where blocker_id = v_user and blocked_id = v_source.user_id
  ) then
    raise exception 'Cannot save from a blocked user';
  end if;

  insert into recipes (
    user_id, title, description, photo_url, servings, prep_min, cook_min,
    instructions, source_url, visibility, tags, diet_tags
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
    v_source.diet_tags
  )
  returning id into v_new_id;

  insert into recipe_ingredients (recipe_id, ingredient_id, qty, unit, notes, sort_order)
  select v_new_id, ingredient_id, qty, unit, notes, sort_order
  from recipe_ingredients
  where recipe_id = p_recipe_id;

  return v_new_id;
end;
$$;

-- ============================================================================
-- search_public_recipes: trigram-ranked public recipe search
-- (works because pg_trgm + recipes_title_trgm index already exist)
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
  created_at timestamptz
)
language sql stable security invoker set search_path = public as $$
  select r.id, r.user_id, r.title, r.description, r.photo_url,
         r.servings, r.prep_min, r.cook_min,
         coalesce(case when q = '' then 0 else similarity(r.title, q) end, 0)::real as similarity,
         r.created_at
  from recipes r
  where r.visibility = 'public'
    and not exists (
      select 1 from blocks b
      where b.blocker_id = auth.uid() and b.blocked_id = r.user_id
    )
    and (
      q = ''
      or r.title ilike q || '%'
      or r.title % q
    )
  order by
    case when q = '' then 0 else similarity(r.title, q) end desc nulls last,
    r.created_at desc
  limit lim;
$$;
