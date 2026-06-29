-- Phase 8: Pantry photo capture
--
-- Two pieces:
--   1. Extend the ai_kind enum with 'pantry_extract' so the AI usage
--      ledger can track vision calls separately from text calls. Useful
--      for monetization analysis later.
--   2. add_pantry_batch RPC — accepts a JSON array of items extracted by
--      the vision model (or hand-edited by the user on the review
--      screen) and inserts them into pantry_items, resolving each name
--      against the ingredients catalog and creating user-scoped
--      ingredients on the fly for novel names.
--
-- Deploy order: this migration first, then extract-pantry-items edge
-- function. The function references the enum value at runtime.

-- ============================================================================
-- Extend ai_kind enum
-- ============================================================================
alter type ai_kind add value if not exists 'pantry_extract';

-- ============================================================================
-- add_pantry_batch — bulk-insert pantry items with ingredient resolution
-- ============================================================================
create or replace function add_pantry_batch(p_items jsonb)
returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_item jsonb;
  v_name text;
  v_unit text;
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

  -- Anonymous users can't reach this — extract-pantry-items returns 403
  -- before they ever see a review screen — but enforce server-side too.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Guests cannot use AI features' using errcode = '42501';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items must be a JSON array';
  end if;

  -- Cap batch size — 30 matches the AI extractor's output ceiling and
  -- keeps RPC latency bounded.
  if jsonb_array_length(p_items) > 30 then
    raise exception 'Batch size exceeds 30 items';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_name := lower(trim(coalesce(v_item ->> 'name', '')));
    if v_name = '' then continue; end if;

    v_qty := coalesce((v_item ->> 'qty')::numeric, 1);
    if v_qty < 0 then v_qty := 0; end if;

    v_unit := coalesce(nullif(trim(v_item ->> 'unit'), ''), 'pcs');

    -- Expires: optional ISO date. Default null (no expiry tracking).
    begin
      v_expires := nullif(v_item ->> 'expires_at', '')::date;
    exception when others then
      v_expires := null;
    end;

    -- Location: must be one of the enum values; default 'other' per the
    -- "leave blank → other" UX decision.
    v_location := coalesce(
      nullif(v_item ->> 'location', '')::pantry_location,
      'other'::pantry_location
    );

    v_category := nullif(trim(v_item ->> 'category'), '');
    v_shelf_life := nullif(v_item ->> 'shelf_life_days', '')::int;

    -- Resolve the ingredient. Order:
    --   1. Canonical match by exact-lower name.
    --   2. User-scoped match by exact-lower name.
    --   3. Create user-scoped row.
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
        v_unit,
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
      v_user, v_ingredient_id, v_qty, v_unit, current_date, v_expires, v_location
    );

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function add_pantry_batch(jsonb) from public;
grant execute on function add_pantry_batch(jsonb) to authenticated;
