-- Meal-plan model rework — accumulated decisions from the meal-planning
-- grill: leftovers (meals_count), eating out / skip (kind enum), one
-- recipe per slot (unique constraint replacement), copy-last-week RPC.
--
-- Pre-migration dedupe: today the schema allows multiple recipes per
-- (user, date, meal_type) via the recipe_id-inclusive unique constraint.
-- The new one-recipe-per-slot constraint requires us to keep at most one
-- row per slot. We keep the most recently created row per slot and drop
-- the rest before adding the new unique constraint.

-- ============================================================================
-- 1) Kind enum
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'meal_plan_kind') then
    create type meal_plan_kind as enum ('recipe', 'no_cook');
  end if;
end
$$;

-- ============================================================================
-- 2) Columns: meals_count, kind
-- ============================================================================
alter table meal_plans
  add column if not exists meals_count int not null default 1
    check (meals_count between 1 and 7),
  add column if not exists kind meal_plan_kind not null default 'recipe';

-- ============================================================================
-- 3) recipe_id becomes nullable for no_cook rows
-- ============================================================================
alter table meal_plans
  alter column recipe_id drop not null;

-- ============================================================================
-- 4) Check constraints — kind/recipe_id agree, no_cook can't have meals_count>1
-- ============================================================================
alter table meal_plans
  drop constraint if exists meal_plans_kind_recipe_match;
alter table meal_plans
  add constraint meal_plans_kind_recipe_match
    check (
      (kind = 'recipe' and recipe_id is not null)
      or (kind = 'no_cook' and recipe_id is null)
    );

alter table meal_plans
  drop constraint if exists meal_plans_no_cook_singleton;
alter table meal_plans
  add constraint meal_plans_no_cook_singleton
    check (kind = 'recipe' or meals_count = 1);

-- ============================================================================
-- 5) Pre-migration dedupe — keep most recent row per (user_id, date, meal_type)
-- ============================================================================
with ranked as (
  select id,
    row_number() over (
      partition by user_id, date, meal_type
      order by id desc
    ) as rn
  from meal_plans
)
delete from meal_plans where id in (select id from ranked where rn > 1);

-- ============================================================================
-- 6) Drop old constraint, add new one. Idempotent guards in case the names
--    differ between fresh installs and upgrades.
-- ============================================================================
do $$
declare
  v_constraint text;
begin
  select conname into v_constraint
  from pg_constraint
  where conrelid = 'meal_plans'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) like '%recipe_id%';
  if v_constraint is not null then
    execute format('alter table meal_plans drop constraint %I', v_constraint);
  end if;
end
$$;

alter table meal_plans
  drop constraint if exists meal_plans_user_id_date_meal_type_key;
alter table meal_plans
  add constraint meal_plans_user_id_date_meal_type_key
    unique (user_id, date, meal_type);

-- ============================================================================
-- 7) copy_meal_plan_week — copies a source week's plan rows forward,
--    skipping any (date, meal_type) slot already occupied in the target
--    week. Idempotent: calling twice is a no-op the second time.
-- ============================================================================
create or replace function copy_meal_plan_week(
  p_source_week_start date,
  p_target_week_start date
)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_source_end date := p_source_week_start + interval '6 days';
  v_offset int := p_target_week_start - p_source_week_start;
  v_count int := 0;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;
  if v_offset = 0 then
    raise exception 'Source and target week are the same';
  end if;

  insert into meal_plans (
    user_id, date, meal_type, recipe_id, servings_override,
    meals_count, kind
  )
  select
    v_user,
    source.date + v_offset,
    source.meal_type,
    source.recipe_id,
    source.servings_override,
    source.meals_count,
    source.kind
  from meal_plans source
  where source.user_id = v_user
    and source.date between p_source_week_start and v_source_end
    and not exists (
      select 1 from meal_plans target
      where target.user_id = v_user
        and target.date = source.date + v_offset
        and target.meal_type = source.meal_type
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function copy_meal_plan_week(date, date) from public;
grant execute on function copy_meal_plan_week(date, date) to authenticated;
