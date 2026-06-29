-- Phase 3: atomic "cook this recipe" — inserts cook_log + deducts pantry
-- in a single transaction so the two can never drift apart.

create or replace function cook_recipe(
  p_recipe_id uuid,
  p_servings int,
  p_meal_plan_id uuid default null,
  p_pantry_deductions jsonb default '[]'::jsonb
  -- p_pantry_deductions: [{ "pantry_item_id": uuid, "new_qty": numeric }, ...]
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_log_id uuid;
  v_deduction jsonb;
  v_id uuid;
  v_new_qty numeric;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;
  if p_servings <= 0 then
    raise exception 'Servings must be positive';
  end if;

  insert into cook_log (user_id, recipe_id, servings, meal_plan_id)
  values (v_user, p_recipe_id, p_servings, p_meal_plan_id)
  returning id into v_log_id;

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
