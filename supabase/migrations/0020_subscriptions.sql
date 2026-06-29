-- Subscriptions, credit packs, and tier-aware AI metering.
--
-- Adds the schema + RPC layer for a freemium model:
--
--   FREE        50 personal recipes
--               5 AI ops / month (recipe gen, URL import, pantry snap)
--               10 Discover saves
--   PRO         Unlimited recipes / pantry / Discover saves
--               Unlimited AI under a 100/day fair-use cap (not advertised)
--               $3.99/mo or $30.99/yr (~35% off)
--   CREDITS     One-time purchase: 10 AI ops for $1.99
--               Consumed only after the monthly free quota is spent
--
-- Apple IAP is the canonical source of truth on subscription state. The
-- RevenueCat webhook function (revenuecat-webhook) updates these columns
-- on purchase / renewal / cancellation. Auth.uid() readers see their own
-- row via the existing profiles_self RLS.
--
-- Recipe-count caps are enforced via the recipes_insert policy below
-- (hard block on the 51st recipe for free, 11th for guests, none for pro).
-- AI-op caps are enforced via claim_ai_op() — the new gate that all
-- AI-bearing edge functions now route through.

-- ============================================================================
-- subscription_status enum + profile columns
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'subscription_status') then
    create type subscription_status as enum (
      'free',
      'pro_monthly',
      'pro_yearly',
      'cancelled'  -- was paid; now in grace / lapsed but data retained
    );
  end if;
end
$$;

alter table profiles
  add column if not exists subscription_status subscription_status not null default 'free',
  add column if not exists subscription_expires_at timestamptz,
  -- Shows when "Renews on Apr 28" copy is appropriate. False after user
  -- cancels mid-period (we still grant access until expires_at).
  add column if not exists subscription_will_renew boolean not null default false,
  -- RevenueCat's app_user_id (typically the auth.users id, but we store
  -- explicitly so the webhook can look up by either).
  add column if not exists revenuecat_app_user_id text,
  -- AI credits balance + lifetime counter (the lifetime value is for
  -- analytics — "how many users ever bought a credit pack").
  add column if not exists ai_credits_remaining int not null default 0
    check (ai_credits_remaining >= 0),
  add column if not exists ai_credits_purchased_lifetime int not null default 0
    check (ai_credits_purchased_lifetime >= 0);

create index if not exists profiles_revenuecat
  on profiles(revenuecat_app_user_id) where revenuecat_app_user_id is not null;

-- ============================================================================
-- is_pro() — single source of truth for the gated paths.
--
-- Returns true if the caller has an active pro subscription (status flagged
-- pro_* AND expiry hasn't passed). 'cancelled' status accounts that haven't
-- expired yet still count as Pro until expires_at.
-- ============================================================================
create or replace function public.is_pro()
returns boolean
language sql stable security invoker set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and (
        (
          subscription_status in ('pro_monthly', 'pro_yearly')
          and (subscription_expires_at is null or subscription_expires_at > now())
        )
        or (
          subscription_status = 'cancelled'
          and subscription_expires_at is not null
          and subscription_expires_at > now()
        )
      )
  );
$$;
revoke all on function public.is_pro() from public;
grant execute on function public.is_pro() to authenticated;

-- ============================================================================
-- ai_usage.source — which bucket paid for this op
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'ai_op_source') then
    create type ai_op_source as enum ('free_quota', 'pro', 'credits');
  end if;
end
$$;

alter table ai_usage
  add column if not exists source ai_op_source not null default 'free_quota';

create index if not exists ai_usage_user_month
  on ai_usage(user_id, source, created_at);

-- ============================================================================
-- claim_ai_op — tier-aware claim. Replaces claim_ai_budget for new callers.
--
-- Returns jsonb with `ok`, and on success: `claim_id`, `source`, plus the
-- relevant counters. On denial: `reason` ('free_cap' | 'pro_fair_use'),
-- `reset_at`, plus the same counters so the client can show a useful
-- "5 of 5 used, resets May 1" message.
--
-- Per-user advisory lock prevents concurrent calls from blowing past caps.
-- Same defense-in-depth pattern as the original claim_ai_budget.
-- ============================================================================
create or replace function claim_ai_op(
  p_user_id uuid,
  p_kind ai_kind,
  p_estimated_cents int default 1
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_free_monthly_cap constant int := 5;
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
revoke all on function claim_ai_op(uuid, ai_kind, int) from public;
-- Edge functions call this via the service role — no grant to authenticated.

-- ============================================================================
-- release_ai_op — refunds an unused claim. If the source was 'credits',
-- the credit gets returned to the user's balance so a failed OpenAI call
-- doesn't burn a paid op.
-- ============================================================================
create or replace function release_ai_op(p_claim_id uuid)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_source ai_op_source;
  v_user_id uuid;
begin
  select source, user_id into v_source, v_user_id
    from ai_usage where id = p_claim_id;
  if not found then
    return;
  end if;

  if v_source = 'credits' then
    update profiles
       set ai_credits_remaining = ai_credits_remaining + 1
     where id = v_user_id;
  end if;

  delete from ai_usage where id = p_claim_id;
end;
$$;
revoke all on function release_ai_op(uuid) from public;

-- finalize_ai_usage already exists from 0009 and works for all sources
-- (it just updates token counts + final cost on the claimed row). No
-- changes needed.

-- ============================================================================
-- my_ai_quota — non-claiming status read for the iOS app's UI affordances.
-- The app shows "5 of 5 AI ops used this month" and "buy a credit pack"
-- before the user hits the wall. This RPC returns the same shape as a
-- denied claim_ai_op without mutating anything.
-- ============================================================================
create or replace function my_ai_quota()
returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_status subscription_status;
  v_expires timestamptz;
  v_pro boolean;
  v_ops int;
  v_credits int;
  v_now timestamptz := now();
  v_month_reset timestamptz := date_trunc('month', v_now at time zone 'UTC') + interval '1 month';
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  select subscription_status, subscription_expires_at, ai_credits_remaining
    into v_status, v_expires, v_credits
    from profiles where id = v_user_id;
  v_credits := coalesce(v_credits, 0);

  v_pro := v_status in ('pro_monthly', 'pro_yearly')
            and (v_expires is null or v_expires > v_now);
  if not v_pro and v_status = 'cancelled' then
    v_pro := v_expires is not null and v_expires > v_now;
  end if;

  if v_pro then
    return jsonb_build_object(
      'tier', 'pro',
      'subscription_status', v_status,
      'expires_at', v_expires,
      'credits_remaining', v_credits
    );
  end if;

  select count(*)::int into v_ops
    from ai_usage
    where user_id = v_user_id
      and source = 'free_quota'
      and created_at >= date_trunc('month', v_now at time zone 'UTC');

  return jsonb_build_object(
    'tier', 'free',
    'ops_used_this_month', v_ops,
    'ops_cap_this_month', 5,
    'credits_remaining', v_credits,
    'reset_at', v_month_reset
  );
end;
$$;
revoke all on function my_ai_quota() from public;
grant execute on function my_ai_quota() to authenticated;

-- ============================================================================
-- recipes_insert — extend the cap check to enforce free-tier 50-recipe limit.
--
-- Existing rules from 0017 + 0018 + 0019 (suspended check, moderation gate,
-- guest cap, anonymous public-publish block) preserved verbatim — only the
-- count-cap clause changes.
-- ============================================================================
drop policy if exists recipes_insert on recipes;
create policy recipes_insert on recipes for insert
with check (
  user_id = auth.uid()
  and coalesce(
    (select account_status from profiles where id = auth.uid()),
    'active'::account_status
  ) = 'active'::account_status
  and (visibility = 'private' or moderation_status = 'approved')
  and (visibility = 'private' or not public._is_anonymous())
  and (
    -- Pro: unlimited
    public.is_pro()
    -- Guest: 10
    or (
      public._is_anonymous()
      and (select count(*) from recipes r where r.user_id = auth.uid()) < 10
    )
    -- Free authenticated: 50
    or (
      not public._is_anonymous()
      and not public.is_pro()
      and (select count(*) from recipes r where r.user_id = auth.uid()) < 50
    )
  )
);

-- ============================================================================
-- record_credit_pack_purchase — RevenueCat webhook calls this on a NON_RENEWING
-- consumable purchase. Idempotent on RevenueCat's transaction id so duplicate
-- webhooks don't double-grant.
-- ============================================================================
create table if not exists credit_pack_purchases (
  -- RevenueCat's store_transaction_identifier — App Store gives us the same
  -- value on retried webhook deliveries. Unique key prevents double-grants.
  store_transaction_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ops_granted int not null,
  product_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists credit_pack_purchases_user
  on credit_pack_purchases(user_id, created_at desc);

alter table credit_pack_purchases enable row level security;
create policy credit_pack_purchases_self_read on credit_pack_purchases for select
  using (user_id = auth.uid());

create or replace function record_credit_pack_purchase(
  p_user_id uuid,
  p_store_transaction_id text,
  p_ops_granted int,
  p_product_id text
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_existing text;
begin
  -- Idempotency: same transaction id → no double credit.
  select store_transaction_id into v_existing
    from credit_pack_purchases
    where store_transaction_id = p_store_transaction_id;
  if v_existing is not null then
    return 0;
  end if;

  insert into credit_pack_purchases (
    store_transaction_id, user_id, ops_granted, product_id
  ) values (
    p_store_transaction_id, p_user_id, p_ops_granted, p_product_id
  );

  update profiles
     set ai_credits_remaining = ai_credits_remaining + p_ops_granted,
         ai_credits_purchased_lifetime = ai_credits_purchased_lifetime + p_ops_granted
   where id = p_user_id;

  return p_ops_granted;
end;
$$;
revoke all on function record_credit_pack_purchase(uuid, text, int, text) from public;
-- Service role only (RevenueCat webhook).

-- ============================================================================
-- apply_subscription_state — RevenueCat webhook calls this on subscription
-- events (purchase / renewal / cancellation / expiration / billing issue).
-- The webhook function decides what status to apply; this RPC just persists
-- atomically with audit metadata.
-- ============================================================================
create or replace function apply_subscription_state(
  p_user_id uuid,
  p_status subscription_status,
  p_expires_at timestamptz,
  p_will_renew boolean,
  p_revenuecat_app_user_id text default null
) returns void
language sql security definer set search_path = public as $$
  update profiles
     set subscription_status = p_status,
         subscription_expires_at = p_expires_at,
         subscription_will_renew = coalesce(p_will_renew, false),
         revenuecat_app_user_id = coalesce(p_revenuecat_app_user_id, revenuecat_app_user_id)
   where id = p_user_id;
$$;
revoke all on function apply_subscription_state(uuid, subscription_status, timestamptz, boolean, text) from public;
