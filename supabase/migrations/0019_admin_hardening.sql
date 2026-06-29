-- Admin hardening — closes the post-audit punch list (issues 1–4, 7, 11–12,
-- 26–28 from the moderator-feature security review).
--
-- Adds:
--   · audit log immutability — admin_actions writes are RPC/service-role only
--   · admin_users protection — writes via grant/revoke RPCs, both step-up
--     gated; trigger refuses removal of the last admin
--   · admin-step-up rate limit (admin_step_up_attempts table)
--   · 5-min → 90s step-up freshness window
--   · reviewer-notes history on reports (append-only) via JSONB column
--   · admin_get_recipe now embeds report history for the recipe
--   · admin_action_reports_bulk RPC (mark many at once)
--   · appeals table + RLS — users can contest a moderation decision
--
-- Apply order: this lands after 0017 (admin baseline) and 0018 (step-up).

-- ============================================================================
-- 1. Audit log immutability
-- ============================================================================
-- Revoke all write privileges on admin_actions from authenticated. The only
-- way to write is via the SECURITY DEFINER RPCs (which run as the function
-- owner, bypassing this revoke) or the service role from edge functions.
-- A compromised admin session can no longer DELETE rows to cover tracks.
revoke insert, update, delete on admin_actions from authenticated;
revoke insert, update, delete on admin_actions from anon;

-- Defensive: also forbid TRUNCATE.
revoke truncate on admin_actions from authenticated, anon;

-- Add success/failure tracking (issue #11) so a failed delete-user doesn't
-- leave a misleading "I deleted X" entry.
alter table admin_actions
  add column if not exists succeeded boolean not null default true,
  add column if not exists error text;

-- ============================================================================
-- 2 + 3. admin_users — step-up gated writes + last-admin guard
-- ============================================================================

-- Drop the old admins-can-write policy. We replace it with: NO direct writes
-- from authenticated. Writes only via admin_grant / admin_revoke RPCs which
-- step-up gate + audit log.
drop policy if exists admin_users_admin_write on admin_users;

-- Recreate the read policy idempotently — 0017 already created it but
-- defensive drop-then-create keeps this migration safe on partial replays.
drop policy if exists admin_users_admin_read on admin_users;
create policy admin_users_admin_read on admin_users for select
  using (is_admin());
-- Re-create with read-only; explicit no insert/update/delete policies means
-- those operations are denied by default for authenticated.
revoke insert, update, delete on admin_users from authenticated;
revoke insert, update, delete on admin_users from anon;
revoke truncate on admin_users from authenticated, anon;

-- Last-admin protection. A BEFORE DELETE trigger refuses to delete the
-- final admin row, regardless of caller (including SECURITY DEFINER RPCs
-- and service role). This is intentional belt-and-suspenders — if you
-- truly need to drop the last admin, do it from the SQL editor with a
-- transaction that adds a new admin in the same statement.
create or replace function public._refuse_last_admin_delete()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from admin_users) <= 1 then
    raise exception 'Cannot remove the last admin — promote another user first'
      using errcode = '42501';
  end if;
  return old;
end;
$$;

drop trigger if exists admin_users_refuse_last_delete on admin_users;
create trigger admin_users_refuse_last_delete
  before delete on admin_users
  for each row
  execute function public._refuse_last_admin_delete();

-- admin_grant — grant another user admin status. Step-up gated + audited.
create or replace function admin_grant(p_user_id uuid, p_notes text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_email text;
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if not admin_step_up_active() then
    raise exception 'Step-up auth required' using errcode = '42511';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'User not found';
  end if;

  insert into admin_users (user_id, granted_by, notes)
  values (p_user_id, v_admin, left(coalesce(p_notes, ''), 500))
  on conflict (user_id) do nothing;

  select email::text into v_email from auth.users where id = p_user_id;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes, metadata)
  values (v_admin, 'grant_admin', 'user', p_user_id,
          left(coalesce(p_notes, ''), 500),
          jsonb_build_object('email', v_email));
end;
$$;
revoke all on function admin_grant(uuid, text) from public;
grant execute on function admin_grant(uuid, text) to authenticated;

-- admin_revoke — strip another user's admin status. Step-up gated; the
-- last-admin trigger above handles the "you can't lock yourself out" case.
create or replace function admin_revoke(p_user_id uuid, p_reason text default null)
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

  delete from admin_users where user_id = p_user_id;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes)
  values (v_admin, 'revoke_admin', 'user', p_user_id,
          left(coalesce(p_reason, ''), 500));
end;
$$;
revoke all on function admin_revoke(uuid, text) from public;
grant execute on function admin_revoke(uuid, text) to authenticated;

-- ============================================================================
-- 4. admin-step-up rate limit — counts attempts in a small log table.
-- The edge function inserts a row per attempt (success or fail) and the
-- helper rejects when a flood is detected.
-- ============================================================================
create table if not exists admin_step_up_attempts (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users(id) on delete cascade,
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
create index if not exists admin_step_up_attempts_recent
  on admin_step_up_attempts(admin_id, attempted_at desc);

alter table admin_step_up_attempts enable row level security;
-- Admins can read their own attempts (for a "X failed attempts in last hour"
-- UI affordance later). Writes are exclusively service role.
drop policy if exists admin_step_up_attempts_self_read on admin_step_up_attempts;
create policy admin_step_up_attempts_self_read on admin_step_up_attempts for select
  using (admin_id = auth.uid());
revoke insert, update, delete on admin_step_up_attempts from authenticated, anon;

-- Helper: how many failed attempts in the last hour?
create or replace function public.admin_step_up_recent_fails(p_user_id uuid)
returns int
language sql stable security definer set search_path = public
as $$
  select count(*)::int
  from admin_step_up_attempts
  where admin_id = p_user_id
    and succeeded = false
    and attempted_at > now() - interval '1 hour';
$$;
revoke all on function public.admin_step_up_recent_fails(uuid) from public;
grant execute on function public.admin_step_up_recent_fails(uuid) to authenticated;

-- ============================================================================
-- 7. Step-up window 5min → 90s. The rationale (per #7 in the audit) is that
-- once stepped up an attacker has a 5-minute window to batch-delete; cutting
-- this to 90s while keeping cache-comfort still gives a relaxed triage flow
-- but tightens the post-compromise blast radius.
-- ============================================================================
create or replace function public.admin_step_up_active()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from admin_step_up
    where admin_id = auth.uid()
      and confirmed_at > now() - interval '90 seconds'
  );
$$;

-- ============================================================================
-- 11. admin-delete-user logs *after* with success flag — done at the edge
-- function level, but the schema already supports it via the new succeeded
-- column (above). No SQL change here, just calling out the contract.
-- ============================================================================

-- ============================================================================
-- 12. Reviewer-notes history — append-only JSONB array on reports.
-- Old reviewer_notes column kept for the latest summary; the array carries
-- the full chain of moderator decisions on this report.
-- ============================================================================
alter table reports
  add column if not exists review_history jsonb not null default '[]'::jsonb;

-- Update admin_action_report to append to history instead of overwriting.
create or replace function admin_action_report(
  p_report_id uuid,
  p_new_status text,
  p_reviewer_notes text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_now timestamptz := now();
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_new_status not in ('reviewed', 'dismissed', 'actioned') then
    raise exception 'Invalid status: %', p_new_status;
  end if;

  update reports
    set status = p_new_status::report_status,
        reviewed_at = v_now,
        reviewed_by = v_admin,
        reviewer_notes = p_reviewer_notes,
        review_history = review_history || jsonb_build_object(
          'at', v_now,
          'by', v_admin,
          'status', p_new_status,
          'notes', p_reviewer_notes
        )
    where id = p_report_id;

  if not found then
    raise exception 'Report not found';
  end if;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes)
  values (v_admin, 'action_report', 'report', p_report_id,
          'status=' || p_new_status ||
          coalesce(' notes=' || left(p_reviewer_notes, 200), ''));
end;
$$;

-- ============================================================================
-- 26. admin_get_recipe — include report history
-- ============================================================================
create or replace function admin_get_recipe(p_recipe_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_recipe jsonb;
  v_ingredients jsonb;
  v_reports jsonb;
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  select to_jsonb(r) || jsonb_build_object(
    'author_name', p.display_name,
    'author_email', u.email,
    'author_status', coalesce(p.account_status, 'active'::account_status)::text
  )
  into v_recipe
  from recipes r
  left join profiles p on p.id = r.user_id
  left join auth.users u on u.id = r.user_id
  where r.id = p_recipe_id;

  if v_recipe is null then
    raise exception 'Recipe not found';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'qty', ri.qty,
      'unit', ri.unit,
      'notes', ri.notes,
      'sort_order', ri.sort_order,
      'ingredient_name', i.name
    ) order by ri.sort_order
  ), '[]'::jsonb)
  into v_ingredients
  from recipe_ingredients ri
  join ingredients i on i.id = ri.ingredient_id
  where ri.recipe_id = p_recipe_id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', rep.id,
      'reason', rep.reason,
      'notes', rep.notes,
      'status', rep.status,
      'created_at', rep.created_at,
      'reporter_name', rp.display_name,
      'reporter_email', rpu.email
    ) order by rep.created_at desc
  ), '[]'::jsonb)
  into v_reports
  from reports rep
  left join profiles rp on rp.id = rep.reporter_id
  left join auth.users rpu on rpu.id = rep.reporter_id
  where rep.recipe_id = p_recipe_id
  limit 20;

  return v_recipe || jsonb_build_object(
    'ingredients', v_ingredients,
    'reports', v_reports
  );
end;
$$;

-- ============================================================================
-- 27. Bulk action RPC — mark many reports at once. Reduces the click-per-row
-- cost when a wave of spam reports lands.
-- ============================================================================
create or replace function admin_action_reports_bulk(
  p_report_ids uuid[],
  p_new_status text,
  p_reviewer_notes text default null
)
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_count int := 0;
  v_now timestamptz := now();
  v_id uuid;
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_new_status not in ('reviewed', 'dismissed', 'actioned') then
    raise exception 'Invalid status: %', p_new_status;
  end if;
  if array_length(p_report_ids, 1) is null then
    return 0;
  end if;
  if array_length(p_report_ids, 1) > 200 then
    raise exception 'Bulk limit is 200 reports per call';
  end if;

  update reports
    set status = p_new_status::report_status,
        reviewed_at = v_now,
        reviewed_by = v_admin,
        reviewer_notes = p_reviewer_notes,
        review_history = review_history || jsonb_build_object(
          'at', v_now,
          'by', v_admin,
          'status', p_new_status,
          'notes', p_reviewer_notes,
          'bulk', true
        )
    where id = any(p_report_ids);
  get diagnostics v_count = row_count;

  -- One audit log entry per bulk action, listing the targets.
  insert into admin_actions (admin_id, action, target_kind, target_id, notes, metadata)
  values (v_admin, 'action_reports_bulk', 'report', null,
          'status=' || p_new_status || ' count=' || v_count,
          jsonb_build_object('report_ids', p_report_ids, 'reviewer_notes', p_reviewer_notes));

  return v_count;
end;
$$;
revoke all on function admin_action_reports_bulk(uuid[], text, text) from public;
grant execute on function admin_action_reports_bulk(uuid[], text, text) to authenticated;

-- ============================================================================
-- 28. Appeals — users can contest a moderation decision (force-reject, delete,
-- account suspension). The /admin tool surfaces them on a future tab; for
-- now the schema is in place so users can file from the iOS app.
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'appeal_kind') then
    create type appeal_kind as enum ('recipe_rejected', 'recipe_deleted', 'account_suspended');
  end if;
  if not exists (select 1 from pg_type where typname = 'appeal_status') then
    create type appeal_status as enum ('open', 'upheld', 'overturned');
  end if;
end
$$;

create table if not exists appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind appeal_kind not null,
  -- The thing being appealed. recipe_id for recipe appeals; null for
  -- account suspension (the user_id IS the subject).
  recipe_id uuid references recipes(id) on delete set null,
  user_message text not null check (length(user_message) <= 2000),
  status appeal_status not null default 'open',
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolver_notes text,
  created_at timestamptz not null default now()
);
create index if not exists appeals_open on appeals(status, created_at desc);
create index if not exists appeals_user on appeals(user_id, created_at desc);

alter table appeals enable row level security;

-- Users can read + insert their own appeals. They cannot edit or delete them
-- once filed. Admins (via is_admin) see everything.
drop policy if exists appeals_self_read on appeals;
create policy appeals_self_read on appeals for select
  using (user_id = auth.uid() or is_admin());
drop policy if exists appeals_self_insert on appeals;
create policy appeals_self_insert on appeals for insert
  with check (
    user_id = auth.uid()
    and not public._is_anonymous()
    -- Cap at 5 open appeals per user to prevent flood.
    and (
      select count(*) from appeals a
      where a.user_id = auth.uid() and a.status = 'open'
    ) < 5
  );
revoke update, delete on appeals from authenticated, anon;

-- ============================================================================
-- 31. Idempotency cleanup — make 0017/0018/0019 reruns safer. Most use
-- if-not-exists / drop-if-exists already; this catches a couple of stray
-- create-policy statements added in earlier migrations.
-- ============================================================================
-- (No-op block — kept as a marker. Future migrations should follow the
-- same idempotent pattern: alter ... add column if not exists, drop policy
-- if exists / create policy, create or replace function, etc.)
