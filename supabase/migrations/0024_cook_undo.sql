-- Cook log undo — accumulated decisions from the cook-log grill:
-- cook_log.deductions stores the pre-cook pantry snapshot so we can
-- reverse a cook within the 10-second undo window without losing
-- pantry state.

alter table cook_log
  add column if not exists deductions jsonb;

-- ============================================================================
-- cook_recipe: extended to capture snapshot before applying deductions.
-- Each cook_log row now optionally carries the exact pantry mutations
-- it caused, with prev_qty + identifying fields. Backwards-compatible:
-- rows from before this migration have null deductions and can't be
-- undone by the simple path.
-- ============================================================================
create or replace function cook_recipe(
  p_recipe_id uuid,
  p_servings int,
  p_meal_plan_id uuid default null,
  p_pantry_deductions jsonb default '[]'::jsonb
)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_log_id uuid;
  v_deduction jsonb;
  v_id uuid;
  v_new_qty numeric;
  v_pantry_row pantry_items%rowtype;
  v_snapshot jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;
  if p_servings <= 0 then
    raise exception 'Servings must be positive';
  end if;

  -- Build a snapshot of every pantry row we're about to touch BEFORE
  -- mutating. Snapshot includes prev_qty + identifying metadata so undo
  -- can re-create a pantry row even if it gets hard-deleted between
  -- cook and undo (e.g., user manually removed it from the pantry tab).
  for v_deduction in select * from jsonb_array_elements(p_pantry_deductions)
  loop
    v_id := (v_deduction->>'pantry_item_id')::uuid;
    select * into v_pantry_row from pantry_items where id = v_id and user_id = v_user;
    if v_pantry_row.id is null then continue; end if;
    v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object(
      'pantry_item_id', v_pantry_row.id,
      'ingredient_id', v_pantry_row.ingredient_id,
      'prev_qty', v_pantry_row.qty,
      'unit', v_pantry_row.unit,
      'location', v_pantry_row.location,
      'expires_at', v_pantry_row.expires_at,
      'purchased_at', v_pantry_row.purchased_at,
      'new_qty', (v_deduction->>'new_qty')::numeric
    ));
  end loop;

  insert into cook_log (user_id, recipe_id, servings, meal_plan_id, deductions)
  values (v_user, p_recipe_id, p_servings, p_meal_plan_id, v_snapshot)
  returning id into v_log_id;

  -- Apply deductions (same as the pre-migration behavior).
  for v_deduction in select * from jsonb_array_elements(p_pantry_deductions)
  loop
    v_id := (v_deduction->>'pantry_item_id')::uuid;
    v_new_qty := (v_deduction->>'new_qty')::numeric;

    if v_new_qty <= 0 then
      delete from pantry_items where id = v_id and user_id = v_user;
    else
      update pantry_items set qty = v_new_qty
        where id = v_id and user_id = v_user;
    end if;
  end loop;

  return v_log_id;
end;
$$;

-- ============================================================================
-- undo_cook_recipe: restore pantry from the snapshot, then delete the
-- cook_log row. Atomic.
-- ============================================================================
create or replace function undo_cook_recipe(p_cook_log_id uuid)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_deductions jsonb;
  v_deduction jsonb;
  v_id uuid;
  v_prev_qty numeric;
  v_ingredient_id uuid;
  v_unit text;
  v_location pantry_location;
  v_expires date;
  v_purchased date;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select deductions into v_deductions
  from cook_log
  where id = p_cook_log_id and user_id = v_user;

  if v_deductions is null then
    raise exception 'Cook log not found, or this cook has no recoverable snapshot (pre-migration row).';
  end if;

  for v_deduction in select * from jsonb_array_elements(v_deductions)
  loop
    v_id := (v_deduction->>'pantry_item_id')::uuid;
    v_prev_qty := (v_deduction->>'prev_qty')::numeric;
    v_ingredient_id := (v_deduction->>'ingredient_id')::uuid;
    v_unit := v_deduction->>'unit';
    v_location := nullif(v_deduction->>'location', '')::pantry_location;
    begin
      v_expires := nullif(v_deduction->>'expires_at', '')::date;
    exception when others then
      v_expires := null;
    end;
    begin
      v_purchased := nullif(v_deduction->>'purchased_at', '')::date;
    exception when others then
      v_purchased := null;
    end;

    -- Restore qty by id when the row still exists.
    update pantry_items set qty = v_prev_qty
    where id = v_id and user_id = v_user;

    if not found then
      -- Row was hard-deleted between cook and undo. Re-create from the
      -- snapshot — some metadata (notes) may have been lost.
      insert into pantry_items (
        user_id, ingredient_id, qty, unit, expires_at, purchased_at, location
      ) values (
        v_user, v_ingredient_id, v_prev_qty, v_unit,
        v_expires, v_purchased, coalesce(v_location, 'other'::pantry_location)
      );
    end if;
  end loop;

  delete from cook_log where id = p_cook_log_id and user_id = v_user;
end;
$$;
revoke all on function undo_cook_recipe(uuid) from public;
grant execute on function undo_cook_recipe(uuid) to authenticated;
