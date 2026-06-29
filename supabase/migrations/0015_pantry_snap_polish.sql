-- Polishes on top of 0014_pantry_snap.
--
-- Two changes in the add_pantry_batch RPC:
--   1. Skip rows with qty <= 0 (the client filters these out, but
--      defense-in-depth — bad client builds shouldn't insert junk rows).
--   2. Normalize the user-scoped ingredient's default_unit to the
--      canonical unit family. The pantry_items.unit stays as the user
--      typed it (e.g. "1 jar pasta sauce"), but the *catalog* row gets
--      a sensible default_unit instead of polluting the user's
--      ingredients picker forever with weird per-purchase units.

create or replace function add_pantry_batch(p_items jsonb)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_item jsonb;
  v_name text;
  v_unit_pantry text;       -- as user typed; stored on the pantry row
  v_unit_ingredient text;   -- normalized; stored on a fresh catalog row
  v_qty numeric;
  v_expires date;
  v_location pantry_location;
  v_category text;
  v_shelf_life int;
  v_ingredient_id uuid;
  v_count int := 0;
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
    -- Skip non-positive quantities entirely — they're either a bad
    -- client filter or user error. Better to drop the row than insert
    -- a useless qty=0 record the user won't notice in the pantry list.
    if v_qty <= 0 then continue; end if;

    v_unit_pantry := coalesce(nullif(trim(v_item ->> 'unit'), ''), 'pcs');

    -- Catalog default_unit: clamp to known canonical units. Anything
    -- else falls back to 'pcs'. This protects the ingredient picker
    -- from per-purchase quirks like "jar", "bottle", "bag".
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

    v_location := coalesce(
      nullif(v_item ->> 'location', '')::pantry_location,
      'other'::pantry_location
    );

    v_category := nullif(trim(v_item ->> 'category'), '');
    v_shelf_life := nullif(v_item ->> 'shelf_life_days', '')::int;

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
        v_name,
        v_unit_ingredient,
        v_category,
        v_shelf_life,
        v_user,
        false
      )
      returning id into v_ingredient_id;
    end if;

    insert into pantry_items (
      user_id, ingredient_id, qty, unit, purchased_at, expires_at, location
    ) values (
      v_user, v_ingredient_id, v_qty, v_unit_pantry,
      current_date, v_expires, v_location
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
