-- Phase 5b polish: replace hashtext (int4) with hashtextextended (int8) for
-- the per-user advisory lock so two distinct user_ids can no longer collide
-- into the same lock token.
--
-- hashtext returns int4 (~4B distinct values), so collisions are rare but
-- not impossible. hashtextextended returns int8 — collision odds drop into
-- birthday-paradox territory only at billions of users.
--
-- Behaviour identical otherwise. CREATE OR REPLACE makes this safe to run
-- repeatedly.

create or replace function claim_ai_budget(
  p_user_id uuid,
  p_kind ai_kind,
  p_estimated_cents int default 1
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_cap constant int := 20;
  v_spent int;
  v_id uuid;
  v_reset timestamptz;
begin
  if p_user_id is null then
    raise exception 'Missing user_id';
  end if;
  if p_estimated_cents < 1 then
    p_estimated_cents := 1;
  end if;

  -- Per-user serialization. hashtextextended returns int8 so collisions
  -- between distinct users are negligible.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  v_reset := date_trunc('day', now() at time zone 'UTC') + interval '1 day';

  select coalesce(sum(cost_cents), 0)
    into v_spent
    from ai_usage
    where user_id = p_user_id
      and created_at >= date_trunc('day', now() at time zone 'UTC');

  if v_spent + p_estimated_cents > v_cap then
    return jsonb_build_object(
      'ok', false,
      'spent_cents', v_spent,
      'cap_cents', v_cap,
      'reset_at', v_reset
    );
  end if;

  insert into ai_usage (user_id, kind, tokens_in, tokens_out, cost_cents)
  values (p_user_id, p_kind, 0, 0, p_estimated_cents)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'claim_id', v_id,
    'spent_cents', v_spent + p_estimated_cents,
    'cap_cents', v_cap,
    'reset_at', v_reset
  );
end;
$$;
