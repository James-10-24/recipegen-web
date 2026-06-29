-- Step-up auth for destructive admin actions.
--
-- Pattern: before suspending/deleting a user or rejecting/deleting a recipe,
-- the moderator re-enters their password. The admin-step-up edge function
-- verifies the password and stamps a row in admin_step_up. Destructive RPCs
-- check that row's freshness (≤5 minutes) and refuse without it.
--
-- Read-only ops (list/view) and reversible ops (action_report, unsuspend)
-- stay friction-free. The freshness window applies per-admin: each step-up
-- buys 5 minutes of destructive-action capability.

-- ============================================================================
-- admin_step_up — confirmed_at per admin
-- ============================================================================
create table if not exists admin_step_up (
  admin_id uuid primary key references auth.users(id) on delete cascade,
  confirmed_at timestamptz not null default now()
);

alter table admin_step_up enable row level security;

-- Admins can read their own row (so the UI can show "step-up valid until X"
-- without a round-trip). Writes happen exclusively from the admin-step-up
-- edge function via service role (which bypasses RLS).
create policy admin_step_up_self_read on admin_step_up for select
  using (admin_id = auth.uid());

-- ============================================================================
-- admin_step_up_active() — single source of truth for freshness check
-- ============================================================================
create or replace function public.admin_step_up_active()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from admin_step_up
    where admin_id = auth.uid()
      and confirmed_at > now() - interval '5 minutes'
  );
$$;
revoke all on function public.admin_step_up_active() from public;
grant execute on function public.admin_step_up_active() to authenticated;

-- ============================================================================
-- Gate the destructive RPCs on a fresh step-up.
--
-- 42511 is reserved for "step-up required" so the client can distinguish it
-- from a plain admin-gate failure (42501) and re-prompt for password.
-- ============================================================================

-- admin_force_reject_recipe — flip a recipe to rejected/private
create or replace function admin_force_reject_recipe(
  p_recipe_id uuid,
  p_categories text[] default null,
  p_reason text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if not admin_step_up_active() then
    raise exception 'Step-up auth required' using errcode = '42511';
  end if;

  update recipes
    set visibility = 'private',
        moderation_status = 'rejected',
        moderation_categories = p_categories,
        moderated_at = now()
    where id = p_recipe_id;

  if not found then
    raise exception 'Recipe not found';
  end if;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes, metadata)
  values (v_admin, 'reject_recipe', 'recipe', p_recipe_id,
          left(coalesce(p_reason, ''), 500),
          jsonb_build_object('categories', coalesce(p_categories, '{}'::text[])));
end;
$$;
revoke all on function admin_force_reject_recipe(uuid, text[], text) from public;
grant execute on function admin_force_reject_recipe(uuid, text[], text) to authenticated;

-- admin_delete_recipe — hard delete (cascades to recipe_ingredients)
create or replace function admin_delete_recipe(
  p_recipe_id uuid,
  p_reason text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_title text;
  v_user_id uuid;
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if not admin_step_up_active() then
    raise exception 'Step-up auth required' using errcode = '42511';
  end if;

  select title, user_id into v_title, v_user_id from recipes where id = p_recipe_id;
  if v_title is null then
    raise exception 'Recipe not found';
  end if;

  delete from recipes where id = p_recipe_id;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes, metadata)
  values (v_admin, 'delete_recipe', 'recipe', p_recipe_id,
          left(coalesce(p_reason, ''), 500),
          jsonb_build_object('title', v_title, 'owner_id', v_user_id));
end;
$$;
revoke all on function admin_delete_recipe(uuid, text) from public;
grant execute on function admin_delete_recipe(uuid, text) to authenticated;

-- admin_suspend_user — flip account_status to suspended
create or replace function admin_suspend_user(
  p_user_id uuid,
  p_reason text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if not admin_step_up_active() then
    raise exception 'Step-up auth required' using errcode = '42511';
  end if;
  if p_user_id = v_admin then
    raise exception 'Cannot suspend yourself';
  end if;
  if exists (select 1 from admin_users where user_id = p_user_id) then
    raise exception 'Cannot suspend an admin (revoke admin first)';
  end if;

  update profiles
    set account_status = 'suspended',
        suspended_at = now(),
        suspended_reason = left(coalesce(p_reason, ''), 500)
    where id = p_user_id;
  if not found then
    insert into profiles (id, account_status, suspended_at, suspended_reason)
    values (p_user_id, 'suspended', now(), left(coalesce(p_reason, ''), 500))
    on conflict (id) do update
      set account_status = excluded.account_status,
          suspended_at = excluded.suspended_at,
          suspended_reason = excluded.suspended_reason;
  end if;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes)
  values (v_admin, 'suspend_user', 'user', p_user_id, left(coalesce(p_reason, ''), 500));
end;
$$;
revoke all on function admin_suspend_user(uuid, text) from public;
grant execute on function admin_suspend_user(uuid, text) to authenticated;

-- admin_unsuspend_user is intentionally NOT step-up gated. Reversing a
-- suspension is a low-risk recovery action; making it free of friction
-- means an over-suspend can be quickly undone.
