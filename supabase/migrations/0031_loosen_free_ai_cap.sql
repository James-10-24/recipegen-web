-- ============================================================================
-- 0031_loosen_free_ai_cap.sql
--
-- From the pricing grill: under the freemium-with-hard-wall philosophy, AI
-- is no longer the upgrade trigger — the 100-recipe cap is. The 5/month
-- AI cap was too tight and pinched typical users before they hit the
-- recipe wall. Bumping to 25/month so power users still hit it (and
-- convert via that signal) but typical users have headroom.
--
-- Unit economics under the new cap (typical free user uses 3-5 ops/mo,
-- heavy free user uses 25/mo all-vision = $0.50/mo cost):
--   Per-1K free users: ~$50-200/mo cost
--   One Pro subscriber covers ~6 heavy free users at the cap; typical
--   ratio of ~20:1 free:paid keeps unit economics comfortable.
--
-- See docs/PRICING_DECISIONS.md for the full reasoning.
--
-- Operationally: this is a SECURITY INVOKER function recreated in place.
-- Existing in-flight claims are unaffected; the new cap only applies to
-- claims made after this migration lands.
-- ============================================================================

create or replace function claim_ai_op(
  p_user_id uuid,
  p_kind ai_kind,
  p_estimated_cents int default 1
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_free_monthly_cap constant int := 25;  -- was 5; raised per pricing grill
  v_pro_daily_cap_cents constant int := 200;  -- ~100 ops/day at 2¢ avg
  v_pro_active boolean;
  v_subscription_expires timestamptz;
  v_status subscription_status;
  v_ops_this_month int;
  v_credits int;
  v_spent_today int;
  v_id uuid;
  v_now timestamptz := now();
  v_month_reset timestamptz;
  v_day_reset timestamptz;
begin
  if p_user_id is null then
    raise exception 'Missing user_id';
  end if;
  if p_estimated_cents < 1 then
    p_estimated_cents := 1;
  end if;

  -- Serialize concurrent claims from the same user.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  v_month_reset := date_trunc('month', v_now at time zone 'UTC') + interval '1 month';
  v_day_reset := date_trunc('day', v_now at time zone 'UTC') + interval '1 day';

  -- Resolve the user's tier. We use the same formula as is_pro() but inline
  -- since this function runs as security invoker and we want to read the
  -- profiles row directly under RLS.
  select subscription_status, subscription_expires_at
    into v_status, v_subscription_expires
    from profiles where id = p_user_id;

  v_pro_active := v_status in ('pro_monthly', 'pro_yearly')
                   and (v_subscription_expires is null
                        or v_subscription_expires > v_now);
  if not v_pro_active and v_status = 'cancelled' then
    v_pro_active := v_subscription_expires is not null
                     and v_subscription_expires > v_now;
  end if;

  -- ─── Pro ───────────────────────────────────────────────────────────────
  if v_pro_active then
    select coalesce(sum(cost_cents), 0) into v_spent_today
      from ai_usage
      where user_id = p_user_id
        and created_at >= date_trunc('day', v_now at time zone 'UTC');

    if v_spent_today + p_estimated_cents > v_pro_daily_cap_cents then
      return jsonb_build_object(
        'ok', false,
        'reason', 'pro_fair_use',
        'spent_cents_today', v_spent_today,
        'cap_cents_today', v_pro_daily_cap_cents,
        'reset_at', v_day_reset
      );
    end if;

    insert into ai_usage (user_id, kind, tokens_in, tokens_out, cost_cents, source)
    values (p_user_id, p_kind, 0, 0, p_estimated_cents, 'pro')
    returning id into v_id;

    return jsonb_build_object(
      'ok', true,
      'claim_id', v_id,
      'source', 'pro',
      'spent_cents_today', v_spent_today + p_estimated_cents,
      'cap_cents_today', v_pro_daily_cap_cents
    );
  end if;

  -- ─── Free tier: monthly op count ──────────────────────────────────────
  -- Only ops sourced from 'free_quota' count toward the monthly cap. A user
  -- whose subscription lapsed mid-month doesn't get their old pro-sourced
  -- ops counted against them.
  select count(*)::int into v_ops_this_month
    from ai_usage
    where user_id = p_user_id
      and source = 'free_quota'
      and created_at >= date_trunc('month', v_now at time zone 'UTC');

  if v_ops_this_month < v_free_monthly_cap then
    insert into ai_usage (user_id, kind, tokens_in, tokens_out, cost_cents, source)
    values (p_user_id, p_kind, 0, 0, p_estimated_cents, 'free_quota')
    returning id into v_id;

    return jsonb_build_object(
      'ok', true,
      'claim_id', v_id,
      'source', 'free_quota',
      'ops_used_this_month', v_ops_this_month + 1,
      'ops_cap_this_month', v_free_monthly_cap,
      'reset_at', v_month_reset
    );
  end if;

  -- ─── Free quota exhausted: try credit pack ───────────────────────────
  -- Credit pack purchase UX is deferred to v1.x per the pricing grill, but
  -- the server-side path stays wired so admin-granted credits + future
  -- credit pack purchases work without another migration.
  select ai_credits_remaining into v_credits from profiles where id = p_user_id;
  v_credits := coalesce(v_credits, 0);

  if v_credits > 0 then
    update profiles
       set ai_credits_remaining = ai_credits_remaining - 1
     where id = p_user_id;

    insert into ai_usage (user_id, kind, tokens_in, tokens_out, cost_cents, source)
    values (p_user_id, p_kind, 0, 0, p_estimated_cents, 'credits')
    returning id into v_id;

    return jsonb_build_object(
      'ok', true,
      'claim_id', v_id,
      'source', 'credits',
      'credits_remaining', v_credits - 1
    );
  end if;

  -- ─── Both buckets empty: deny ────────────────────────────────────────
  return jsonb_build_object(
    'ok', false,
    'reason', 'free_cap',
    'ops_used_this_month', v_ops_this_month,
    'ops_cap_this_month', v_free_monthly_cap,
    'credits_remaining', 0,
    'reset_at', v_month_reset
  );
end;
$$;
