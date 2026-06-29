-- Snap-to-pantry smart-merge — accumulated decisions from the snap grill:
-- when an extracted item matches an existing pantry row by ingredient + unit
-- + close expiry (within 3 days), merge qty into that row instead of
-- creating a duplicate. Different batches (older + newer) stay as
-- separate rows. The "purchased_at" date now threads through from the
-- review screen's "Purchased on" picker.
--
-- The RPC return shape changes from int (count) to jsonb { added, merged,
-- total } so the client can show a "Added 12 items · 3 merged" toast.
--
-- Postgres won't allow `create or replace` to change a function's return
-- type, so drop the previous int-returning definition explicitly. Safe to
-- run on a fresh DB too thanks to `if exists`.
drop function if exists add_pantry_batch(jsonb);

create or replace function add_pantry_batch(p_items jsonb)
returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_item jsonb;
  v_name text;
  v_unit_pantry text;
  v_unit_ingredient text;
  v_qty numeric;
  v_expires date;
  v_purchased date;
  v_location pantry_location;
  v_category text;
  v_shelf_life int;
  v_ingredient_id uuid;
  v_existing_id uuid;
  v_added int := 0;
  v_merged int := 0;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Guests cannot use AI features' using errcode = '42501';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items must be a JSON array';
  end if;

  if jsonb_array_length(p_items) > 30 then
    raise exception 'Batch size exceeds 30 items';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_name := lower(trim(coalesce(v_item ->> 'name', '')));
    if v_name = '' then continue; end if;

    v_qty := coalesce((v_item ->> 'qty')::numeric, 1);
    if v_qty <= 0 then continue; end if;

    v_unit_pantry := coalesce(nullif(trim(v_item ->> 'unit'), ''), 'pcs');

    v_unit_ingredient := case
      when lower(v_unit_pantry) in (
        'pcs', 'g', 'kg', 'ml', 'l',
        'tsp', 'tbsp', 'cup', 'oz', 'lb'
      ) then lower(v_unit_pantry)
      else 'pcs'
    end;

    begin
      v_expires := nullif(v_item ->> 'expires_at', '')::date;
    exception when others then
      v_expires := null;
    end;

    begin
      v_purchased := nullif(v_item ->> 'purchased_at', '')::date;
    exception when others then
      v_purchased := null;
    end;

    v_location := coalesce(
      nullif(v_item ->> 'location', '')::pantry_location,
      'other'::pantry_location
    );

    v_category := nullif(trim(v_item ->> 'category'), '');
    v_shelf_life := nullif(v_item ->> 'shelf_life_days', '')::int;

    -- Resolve ingredient_id (canonical first, then user-scoped, then create).
    select id into v_ingredient_id
    from ingredients
    where user_id is null and lower(name) = v_name
    limit 1;

    if v_ingredient_id is null then
      select id into v_ingredient_id
      from ingredients
      where user_id = v_user and lower(name) = v_name
      limit 1;
    end if;

    if v_ingredient_id is null then
      insert into ingredients (
        name, default_unit, category, shelf_life_days, user_id, is_canonical
      ) values (
        v_name, v_unit_ingredient, v_category, v_shelf_life, v_user, false
      )
      returning id into v_ingredient_id;
    end if;

    -- Smart-merge: existing row with same ingredient + unit + expiry
    -- within 3 days = same batch → add qty + take LATEST expiry.
    -- If either expiry is null, treat as "compatible." Different unit
    -- or expiry > 3 days apart = different batch → new row.
    select id into v_existing_id
    from pantry_items
    where user_id = v_user
      and ingredient_id = v_ingredient_id
      and lower(unit) = lower(v_unit_pantry)
      and (
        (expires_at is null and v_expires is null)
        or expires_at is null
        or v_expires is null
        or abs(expires_at - v_expires) <= 3
      )
    order by expires_at asc nulls last
    limit 1;

    if v_existing_id is not null then
      update pantry_items
      set qty = qty + v_qty,
          expires_at = greatest(
            coalesce(expires_at, v_expires),
            coalesce(v_expires, expires_at)
          ),
          purchased_at = greatest(
            coalesce(purchased_at, v_purchased, current_date),
            coalesce(v_purchased, purchased_at, current_date)
          )
      where id = v_existing_id;
      v_merged := v_merged + 1;
    else
      insert into pantry_items (
        user_id, ingredient_id, qty, unit, purchased_at, expires_at, location
      ) values (
        v_user, v_ingredient_id, v_qty, v_unit_pantry,
        coalesce(v_purchased, current_date), v_expires, v_location
      );
      v_added := v_added + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'added', v_added,
    'merged', v_merged,
    'total', v_added + v_merged
  );
end;
$$;
