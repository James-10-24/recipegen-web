-- Phase 5b hardening: atomic AI-budget claiming.
--
-- The previous flow (SELECT sum() → call OpenAI → INSERT row) was a TOCTOU
-- race: two concurrent requests from the same user could both clear the
-- cap check before either inserted, then both bill OpenAI. With Promise.all
-- a malicious client could blow past the cap by 20× per burst.
--
-- New flow: claim_ai_budget acquires a per-user advisory lock for the
-- duration of the transaction, sums today's spend under the lock, and
-- inserts an estimated-cost placeholder row before returning. The caller
-- (edge function) then makes the OpenAI call, and either:
--   - finalize_ai_usage(claim_id, ...): updates the row with real tokens
--     and cost, OR
--   - release_ai_budget(claim_id): deletes the placeholder if the call
--     failed entirely.
--
-- Concurrent claims serialize on the lock, so the cap is enforced exactly.

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

  -- Per-user serialization. Two concurrent calls from the same user will
  -- queue here; different users don't contend.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

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

create or replace function finalize_ai_usage(
  p_claim_id uuid,
  p_tokens_in int,
  p_tokens_out int,
  p_cost_cents int
) returns void
language sql security invoker set search_path = public as $$
  update ai_usage
  set tokens_in = greatest(p_tokens_in, 0),
      tokens_out = greatest(p_tokens_out, 0),
      cost_cents = greatest(p_cost_cents, 1)
  where id = p_claim_id;
$$;

create or replace function release_ai_budget(p_claim_id uuid) returns void
language sql security invoker set search_path = public as $$
  delete from ai_usage where id = p_claim_id;
$$;
