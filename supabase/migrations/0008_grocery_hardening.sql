-- Phase 4 hardening: close data-correctness gaps around buy → pantry.
--
-- 1. grocery_list_items.unconvertible_count surfaces how many recipe
--    contributions we had to drop because a unit couldn't be converted.
-- 2. Enforce that at most one grocery_list_items row points at a given
--    pantry_item (defensive against any future concurrency bug).
-- 3. Replace check_grocery_item so it:
--      a. refuses writes on completed/archived lists,
--      b. preserves the pantry row on uncheck when the user has edited
--         it since creation (keyed on updated_at > created_at + tolerance),
--      c. returns a text status the client can react to.

alter table grocery_list_items
  add column if not exists unconvertible_count int not null default 0;

create unique index if not exists grocery_list_items_pantry_item_unique
  on grocery_list_items (pantry_item_id)
  where pantry_item_id is not null;

drop function if exists check_grocery_item(uuid, boolean);

create or replace function check_grocery_item(
  p_item_id uuid,
  p_checked boolean
) returns text
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_item record;
  v_ingredient record;
  v_new_pantry_id uuid;
  v_location pantry_location;
  v_expires date;
  v_pantry_created timestamptz;
  v_pantry_updated timestamptz;
  v_modified boolean;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select gli.id, gli.list_id, gli.ingredient_id, gli.qty_to_buy, gli.unit,
         gli.checked_at, gli.pantry_item_id, gl.user_id, gl.status
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
  if v_item.status in ('completed', 'archived') then
    raise exception 'List is % and cannot be changed', v_item.status;
  end if;

  if p_checked then
    if v_item.checked_at is not null and v_item.pantry_item_id is not null then
      return 'already_checked';
    end if;

    select category, shelf_life_days
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
      v_user, v_item.ingredient_id, v_item.qty_to_buy, v_item.unit,
      v_location, current_date, v_expires
    )
    returning id into v_new_pantry_id;

    update grocery_list_items
      set checked_at = now(), pantry_item_id = v_new_pantry_id
      where id = p_item_id;

    return 'checked';
  else
    v_modified := false;

    if v_item.pantry_item_id is not null then
      select created_at, updated_at
        into v_pantry_created, v_pantry_updated
        from pantry_items
        where id = v_item.pantry_item_id and user_id = v_user;

      -- Tolerance: insert-time updated_at can differ from created_at by a
      -- fraction of a ms due to clock resolution. 2s is safely beyond that
      -- and far shorter than any real user edit window.
      if v_pantry_updated is not null
         and v_pantry_created is not null
         and v_pantry_updated > v_pantry_created + interval '2 seconds'
      then
        v_modified := true;
      end if;

      if not v_modified then
        delete from pantry_items
          where id = v_item.pantry_item_id and user_id = v_user;
      end if;
    end if;

    update grocery_list_items
      set checked_at = null, pantry_item_id = null
      where id = p_item_id;

    if v_modified then
      return 'pantry_row_preserved';
    elsif v_item.pantry_item_id is not null then
      return 'pantry_row_deleted';
    else
      return 'unchecked';
    end if;
  end if;
end;
$$;
