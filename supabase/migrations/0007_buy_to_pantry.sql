-- Phase 4 follow-up: checking off a grocery item adds it to the pantry
-- atomically; unchecking removes the pantry row we created. Link is kept
-- on grocery_list_items.pantry_item_id so the two can't drift.

alter table grocery_list_items
  add column if not exists pantry_item_id uuid
    references pantry_items(id) on delete set null;

create or replace function check_grocery_item(
  p_item_id uuid,
  p_checked boolean
) returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_item record;
  v_ingredient record;
  v_new_pantry_id uuid;
  v_location pantry_location;
  v_expires date;
  v_owner uuid;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select gli.id, gli.list_id, gli.ingredient_id, gli.qty_to_buy, gli.unit,
         gli.checked_at, gli.pantry_item_id, gl.user_id
    into v_item
    from grocery_list_items gli
    join grocery_lists gl on gl.id = gli.list_id
    where gli.id = p_item_id;
  if v_item.id is null then
    raise exception 'Item not found';
  end if;
  if v_item.user_id <> v_user then
    raise exception 'Not your item';
  end if;

  if p_checked then
    -- Idempotent: already bought + linked pantry row → nothing to do.
    if v_item.checked_at is not null and v_item.pantry_item_id is not null then
      return;
    end if;

    select id, category, shelf_life_days
      into v_ingredient
      from ingredients
      where id = v_item.ingredient_id;

    v_location := case
      when v_ingredient.category in ('produce', 'meat', 'seafood', 'dairy')
        then 'fridge'::pantry_location
      else 'pantry'::pantry_location
    end;

    v_expires := case
      when v_ingredient.shelf_life_days is not null
        then current_date + v_ingredient.shelf_life_days
      else null
    end;

    insert into pantry_items (
      user_id, ingredient_id, qty, unit, location, purchased_at, expires_at
    ) values (
      v_user,
      v_item.ingredient_id,
      v_item.qty_to_buy,
      v_item.unit,
      v_location,
      current_date,
      v_expires
    )
    returning id into v_new_pantry_id;

    update grocery_list_items
      set checked_at = now(),
          pantry_item_id = v_new_pantry_id
      where id = p_item_id;
  else
    -- Uncheck: revert the pantry row, if this check created one.
    if v_item.pantry_item_id is not null then
      delete from pantry_items
        where id = v_item.pantry_item_id and user_id = v_user;
    end if;

    update grocery_list_items
      set checked_at = null, pantry_item_id = null
      where id = p_item_id;
  end if;
end;
$$;
