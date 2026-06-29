-- Add updated_at to meal_plans so the shop tab can detect when the plan
-- has changed since the active grocery list was generated.
--
-- Background: Q14 of the model-coherence grill locked two banners on
-- shop tab — past-range (range_end < today) and inputs-changed (plan or
-- pantry edited after the list's generated_at). Past-range shipped in
-- the shop-tab UI commit; inputs-changed was deferred because
-- meal_plans didn't carry an updated_at column. profiles, recipes, and
-- pantry_items all do (per migration 0001), so the pattern is well-
-- established — same set_updated_at() helper, same trigger shape.
--
-- Once this lands, useIsListStale can compare list.created_at to the
-- max(updated_at) across meal_plans (filtered to the list's range) and
-- pantry_items. Banner surfaces when either exceeds the list's
-- generation timestamp.
--
-- Three-step add to backfill existing rows correctly:
--   1. Add nullable column.
--   2. Backfill from created_at so existing rows reflect their actual
--      last-modified timestamp (not the migration's NOW()).
--   3. Lock down: NOT NULL + default now() for future inserts.
-- All steps are idempotent.

alter table meal_plans
  add column if not exists updated_at timestamptz;

update meal_plans
   set updated_at = created_at
 where updated_at is null;

alter table meal_plans alter column updated_at set not null;
alter table meal_plans alter column updated_at set default now();

drop trigger if exists meal_plans_updated_at on meal_plans;
create trigger meal_plans_updated_at
  before update on meal_plans
  for each row execute function set_updated_at();
