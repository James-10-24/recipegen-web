-- RecipeGen — initial schema
-- Run via: supabase db push (after `supabase link --project-ref <ref>`)

create extension if not exists pg_trgm;

-- ============================================================================
-- Enums
-- ============================================================================
create type meal_type as enum ('breakfast', 'lunch', 'dinner', 'snack');
create type recipe_visibility as enum ('private', 'public');
create type unit_system as enum ('metric', 'imperial');
create type pantry_location as enum ('fridge', 'freezer', 'pantry', 'other');
create type waste_risk as enum ('low', 'medium', 'high');
create type grocery_status as enum ('draft', 'active', 'completed', 'archived');
create type ai_kind as enum ('recipe_generate', 'url_parse', 'ingredient_normalize');

-- ============================================================================
-- profiles  (1:1 with auth.users)
-- ============================================================================
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  household_size int not null default 2 check (household_size > 0),
  units unit_system not null default 'metric',
  diet_tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profile row on signup
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================================
-- ingredients  (canonical catalog, read-all / admin-write)
-- ============================================================================
create table ingredients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  aliases text[] not null default '{}',
  category text,
  default_unit text not null,
  shelf_life_days int,
  package_size numeric,
  package_unit text,
  density_g_per_ml numeric,
  is_canonical boolean not null default true,
  created_at timestamptz not null default now()
);
create index ingredients_name_trgm on ingredients using gin (name gin_trgm_ops);
create index ingredients_aliases_gin on ingredients using gin (aliases);

-- ============================================================================
-- recipes
-- ============================================================================
create table recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  photo_url text,
  servings int not null default 2 check (servings > 0),
  prep_min int,
  cook_min int,
  instructions text,
  source_url text,
  visibility recipe_visibility not null default 'private',
  tags text[] not null default '{}',
  diet_tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recipes_user_id on recipes(user_id);
create index recipes_visibility on recipes(visibility) where visibility = 'public';
create index recipes_title_trgm on recipes using gin (title gin_trgm_ops);

create table recipe_ingredients (
  recipe_id uuid not null references recipes(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  qty numeric not null check (qty >= 0),
  unit text not null,
  notes text,
  sort_order int not null default 0,
  primary key (recipe_id, ingredient_id, sort_order)
);
create index recipe_ingredients_ingredient on recipe_ingredients(ingredient_id);

-- ============================================================================
-- meal_plans
-- ============================================================================
create table meal_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  meal_type meal_type not null,
  recipe_id uuid not null references recipes(id) on delete cascade,
  servings_override int check (servings_override > 0),
  created_at timestamptz not null default now(),
  unique (user_id, date, meal_type, recipe_id)
);
create index meal_plans_user_date on meal_plans(user_id, date);

-- ============================================================================
-- pantry_items
-- ============================================================================
create table pantry_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  qty numeric not null check (qty >= 0),
  unit text not null,
  purchased_at date,
  expires_at date,
  location pantry_location not null default 'pantry',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pantry_items_user on pantry_items(user_id);
create index pantry_items_user_expiry on pantry_items(user_id, expires_at) where expires_at is not null;

-- ============================================================================
-- grocery_lists
-- ============================================================================
create table grocery_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  range_start date not null,
  range_end date not null,
  status grocery_status not null default 'draft',
  created_at timestamptz not null default now(),
  check (range_end >= range_start)
);
create index grocery_lists_user on grocery_lists(user_id, status);

create table grocery_list_items (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references grocery_lists(id) on delete cascade,
  ingredient_id uuid not null references ingredients(id) on delete restrict,
  needed_qty numeric not null check (needed_qty >= 0),
  qty_to_buy numeric not null check (qty_to_buy >= 0),
  pantry_qty numeric not null default 0,
  unit text not null,
  waste_risk waste_risk not null default 'low',
  notes text,
  checked_at timestamptz,
  unique (list_id, ingredient_id)
);

-- ============================================================================
-- cook_log  (used for pantry deduction + future "what did we eat" history)
-- ============================================================================
create table cook_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  recipe_id uuid not null references recipes(id) on delete restrict,
  cooked_at timestamptz not null default now(),
  servings int not null default 2 check (servings > 0),
  meal_plan_id uuid references meal_plans(id) on delete set null
);
create index cook_log_user_date on cook_log(user_id, cooked_at desc);

-- ============================================================================
-- ai_usage  (per-user metering for AI calls)
-- ============================================================================
create table ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind ai_kind not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  cost_cents int not null default 0,
  created_at timestamptz not null default now()
);
create index ai_usage_user_date on ai_usage(user_id, created_at desc);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();
create trigger recipes_updated_at before update on recipes
  for each row execute function set_updated_at();
create trigger pantry_items_updated_at before update on pantry_items
  for each row execute function set_updated_at();

-- ============================================================================
-- Row-Level Security
-- ============================================================================
alter table profiles enable row level security;
alter table ingredients enable row level security;
alter table recipes enable row level security;
alter table recipe_ingredients enable row level security;
alter table meal_plans enable row level security;
alter table pantry_items enable row level security;
alter table grocery_lists enable row level security;
alter table grocery_list_items enable row level security;
alter table cook_log enable row level security;
alter table ai_usage enable row level security;

-- profiles: users see/edit own
create policy profiles_self on profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

-- ingredients: read-all (anon + authed); writes only via service role
create policy ingredients_read on ingredients for select using (true);

-- recipes: read own + public; write own
create policy recipes_read on recipes for select
  using (visibility = 'public' or user_id = auth.uid());
create policy recipes_insert on recipes for insert with check (user_id = auth.uid());
create policy recipes_update on recipes for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy recipes_delete on recipes for delete using (user_id = auth.uid());

-- recipe_ingredients: tied to parent recipe
create policy recipe_ings_read on recipe_ingredients for select
  using (exists (select 1 from recipes r where r.id = recipe_id
                  and (r.visibility = 'public' or r.user_id = auth.uid())));
create policy recipe_ings_write on recipe_ingredients for all
  using (exists (select 1 from recipes r where r.id = recipe_id and r.user_id = auth.uid()))
  with check (exists (select 1 from recipes r where r.id = recipe_id and r.user_id = auth.uid()));

-- user-owned: meal_plans, pantry_items, grocery_lists, cook_log, ai_usage
create policy meal_plans_self on meal_plans for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy pantry_items_self on pantry_items for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy grocery_lists_self on grocery_lists for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy grocery_list_items_self on grocery_list_items for all
  using (exists (select 1 from grocery_lists gl where gl.id = list_id and gl.user_id = auth.uid()))
  with check (exists (select 1 from grocery_lists gl where gl.id = list_id and gl.user_id = auth.uid()));
create policy cook_log_self on cook_log for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy ai_usage_read on ai_usage for select using (user_id = auth.uid());
-- ai_usage inserts done via service role (Edge Function), not user
