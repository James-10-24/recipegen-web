-- Admin / moderator dashboard backend.
--
-- Adds:
--   · admin_users table — explicit allowlist (don't ship admin status as a
--     boolean column on profiles — it'd be tempting to flip via Supabase
--     Studio without an audit trail)
--   · is_admin() helper — single source of truth, used by RPCs and RLS
--   · account_status enum on profiles ('active', 'suspended') — soft
--     suspension hides public content + blocks publish without revoking
--     auth, so the user can sign in and read their own data while we
--     investigate
--   · RLS updates on recipes_read / recipes_insert / recipes_update so
--     suspended authors disappear from Discover and can't publish
--   · admin_actions audit log — every privileged action gets a row
--   · SECURITY DEFINER RPCs for the moderator dashboard:
--       admin_list_reports, admin_action_report
--       admin_list_recipes, admin_force_reject_recipe, admin_delete_recipe
--       admin_list_users, admin_suspend_user, admin_unsuspend_user,
--       admin_get_stats
--
-- BOOTSTRAP: after applying this migration, enroll yourself as admin via
-- the Supabase SQL editor:
--
--   insert into admin_users (user_id) values (
--     (select id from auth.users where email = 'james@ideagen.tech')
--   );
--
-- Until you do this, the dashboard will refuse all calls.

-- ============================================================================
-- admin_users — the allowlist
-- ============================================================================
create table if not exists admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  notes text
);

alter table admin_users enable row level security;

-- ============================================================================
-- is_admin() — single source of truth for the admin gate.
--
-- SECURITY DEFINER so the function can read admin_users without triggering
-- the table's own RLS (which itself gates on admin status — without this,
-- a freshly-enrolled admin couldn't see their own row through RLS until
-- is_admin() returned true, a chicken-and-egg). The function only ever
-- reads the caller's own row (filter on auth.uid()), so there's no leak
-- of the wider allowlist.
-- ============================================================================
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from admin_users where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Only existing admins can read or write admin_users. Uses is_admin()
-- (SECURITY DEFINER) so the policy doesn't recurse into its own table's
-- RLS. Bootstrap is via the SQL editor (service role bypasses RLS).
drop policy if exists admin_users_admin_read on admin_users;
create policy admin_users_admin_read on admin_users for select
  using (is_admin());
drop policy if exists admin_users_admin_write on admin_users;
create policy admin_users_admin_write on admin_users for all
  using (is_admin())
  with check (is_admin());

-- ============================================================================
-- account_status on profiles — soft suspension
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'account_status') then
    create type account_status as enum ('active', 'suspended');
  end if;
end
$$;

alter table profiles
  add column if not exists account_status account_status not null default 'active',
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text;

-- ============================================================================
-- recipes RLS — hide suspended authors' public content + block their publishes
-- ============================================================================
drop policy if exists recipes_read on recipes;
create policy recipes_read on recipes for select using (
  user_id = auth.uid()
  or is_admin()
  or (
    visibility = 'public'
    and moderation_status = 'approved'
    and not exists (
      select 1 from blocks b
      where b.blocker_id = auth.uid() and b.blocked_id = recipes.user_id
    )
    and coalesce(
      (select account_status from profiles where id = recipes.user_id),
      'active'::account_status
    ) = 'active'::account_status
  )
);

drop policy if exists recipes_insert on recipes;
create policy recipes_insert on recipes for insert
with check (
  user_id = auth.uid()
  -- Suspended users can't write anything. Hard gate — even private writes
  -- are refused while suspended, matching the intent of "hold their account
  -- while we investigate."
  and coalesce(
    (select account_status from profiles where id = auth.uid()),
    'active'::account_status
  ) = 'active'::account_status
  and (visibility = 'private' or moderation_status = 'approved')
  and (visibility = 'private' or not public._is_anonymous())
  and (
    not public._is_anonymous()
    or (select count(*) from recipes r where r.user_id = auth.uid()) < 10
  )
);

drop policy if exists recipes_update on recipes;
create policy recipes_update on recipes for update
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and coalesce(
    (select account_status from profiles where id = auth.uid()),
    'active'::account_status
  ) = 'active'::account_status
  and (visibility = 'private' or moderation_status = 'approved')
  and (visibility = 'private' or not public._is_anonymous())
);

-- search_public_recipes: filter suspended authors. Defense-in-depth — RLS
-- already gates this for non-admins, but the RPC's explicit join makes the
-- behavior obvious.
create or replace function search_public_recipes(q text default '', lim int default 20)
returns table (
  id uuid,
  user_id uuid,
  title text,
  description text,
  photo_url text,
  servings int,
  prep_min int,
  cook_min int,
  similarity real,
  created_at timestamptz,
  author_name text
)
language plpgsql stable security definer set search_path = public as $$
declare
  q_clean text := left(coalesce(q, ''), 100);
  caller uuid := auth.uid();
begin
  if public._is_anonymous() then
    raise exception 'Guests cannot browse the community library' using errcode = '42501';
  end if;

  return query
  select r.id, r.user_id, r.title, r.description, r.photo_url,
         r.servings, r.prep_min, r.cook_min,
         coalesce(case when q_clean = '' then 0 else similarity(r.title, q_clean) end, 0)::real,
         r.created_at,
         p.display_name
  from recipes r
  left join profiles p on p.id = r.user_id
  where r.visibility = 'public'
    and r.moderation_status = 'approved'
    and coalesce(p.account_status, 'active'::account_status) = 'active'
    and not exists (
      select 1 from blocks b
      where b.blocker_id = caller and b.blocked_id = r.user_id
    )
    and (
      q_clean = ''
      or r.title ilike q_clean || '%'
      or r.title % q_clean
    )
  order by
    case when q_clean = '' then 0 else similarity(r.title, q_clean) end desc nulls last,
    r.created_at desc
  limit greatest(1, least(lim, 50));
end;
$$;
revoke all on function search_public_recipes(text, int) from public;
grant execute on function search_public_recipes(text, int) to authenticated;

-- ============================================================================
-- admin_actions — audit log. Every privileged operation gets a row.
-- ============================================================================
create table if not exists admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references auth.users(id) on delete set null,
  action text not null,        -- 'action_report', 'reject_recipe', 'suspend_user', etc.
  target_kind text not null,   -- 'report', 'recipe', 'user'
  target_id uuid,
  notes text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_actions_recent on admin_actions(created_at desc);
create index if not exists admin_actions_target on admin_actions(target_kind, target_id);

alter table admin_actions enable row level security;
create policy admin_actions_admin_read on admin_actions for select
  using (is_admin());
-- Writes happen exclusively from the SECURITY DEFINER RPCs below.

-- ============================================================================
-- RPC: admin_list_reports — paged list with subject details joined in
-- ============================================================================
create or replace function admin_list_reports(
  p_status text default null,    -- 'pending'|'reviewed'|'dismissed'|'actioned' or null
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  reporter_id uuid,
  reporter_name text,
  reporter_email text,
  subject_kind report_subject,
  recipe_id uuid,
  recipe_title text,
  recipe_visibility text,
  recipe_moderation_status text,
  reported_user_id uuid,
  reported_user_name text,
  reported_user_email text,
  reported_user_status text,
  reason report_reason,
  notes text,
  status report_status,
  created_at timestamptz,
  reviewed_at timestamptz,
  reviewer_notes text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.reporter_id,
    rp.display_name,
    rpu.email,
    r.subject_kind,
    r.recipe_id,
    rec.title,
    rec.visibility::text,
    rec.moderation_status::text,
    r.reported_user_id,
    sp.display_name,
    spu.email,
    coalesce(sp.account_status, 'active'::account_status)::text,
    r.reason,
    r.notes,
    r.status,
    r.created_at,
    r.reviewed_at,
    r.reviewer_notes
  from reports r
  left join profiles rp  on rp.id  = r.reporter_id
  left join auth.users rpu on rpu.id = r.reporter_id
  left join recipes rec on rec.id = r.recipe_id
  left join profiles sp  on sp.id  = r.reported_user_id
  left join auth.users spu on spu.id = r.reported_user_id
  where (p_status is null or r.status::text = p_status)
  order by r.created_at desc
  limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset);
end;
$$;
revoke all on function admin_list_reports(text, int, int) from public;
grant execute on function admin_list_reports(text, int, int) to authenticated;

-- ============================================================================
-- RPC: admin_action_report — set status + reviewer notes + audit log
-- ============================================================================
create or replace function admin_action_report(
  p_report_id uuid,
  p_new_status text,             -- 'reviewed'|'dismissed'|'actioned'
  p_reviewer_notes text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_new_status not in ('reviewed', 'dismissed', 'actioned') then
    raise exception 'Invalid status: %', p_new_status;
  end if;

  update reports
    set status = p_new_status::report_status,
        reviewed_at = now(),
        reviewed_by = v_admin,
        reviewer_notes = p_reviewer_notes
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
revoke all on function admin_action_report(uuid, text, text) from public;
grant execute on function admin_action_report(uuid, text, text) to authenticated;

-- ============================================================================
-- RPC: admin_list_recipes — paged list, filterable by visibility + status
-- ============================================================================
create or replace function admin_list_recipes(
  p_visibility text default null,    -- 'public'|'private' or null
  p_moderation_status text default null,    -- 'pending'|'approved'|'rejected' or null
  p_search text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  user_id uuid,
  author_name text,
  author_email text,
  title text,
  description text,
  visibility text,
  moderation_status text,
  moderation_categories text[],
  photo_url text,
  created_at timestamptz,
  updated_at timestamptz,
  report_count bigint
)
language plpgsql stable security definer set search_path = public as $$
declare
  q_clean text := left(coalesce(p_search, ''), 100);
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select
    r.id,
    r.user_id,
    p.display_name,
    u.email,
    r.title,
    r.description,
    r.visibility::text,
    r.moderation_status::text,
    r.moderation_categories,
    r.photo_url,
    r.created_at,
    r.updated_at,
    (select count(*) from reports rep where rep.recipe_id = r.id)::bigint
  from recipes r
  left join profiles p on p.id = r.user_id
  left join auth.users u on u.id = r.user_id
  where (p_visibility is null or r.visibility::text = p_visibility)
    and (p_moderation_status is null or r.moderation_status::text = p_moderation_status)
    and (q_clean = '' or r.title ilike '%' || q_clean || '%')
  order by r.created_at desc
  limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset);
end;
$$;
revoke all on function admin_list_recipes(text, text, text, int, int) from public;
grant execute on function admin_list_recipes(text, text, text, int, int) to authenticated;

-- ============================================================================
-- RPC: admin_force_reject_recipe — flip a recipe to rejected/private
-- ============================================================================
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

-- ============================================================================
-- RPC: admin_delete_recipe — hard delete (cascades to recipe_ingredients)
-- ============================================================================
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

-- ============================================================================
-- RPC: admin_list_users — paged list with recipe count + report count
-- ============================================================================
create or replace function admin_list_users(
  p_status text default null,    -- 'active'|'suspended' or null
  p_search text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  user_id uuid,
  email text,
  display_name text,
  account_status text,
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz,
  recipe_count bigint,
  public_recipe_count bigint,
  report_count_against bigint,
  report_count_filed bigint,
  is_admin_user boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  q_clean text := lower(left(coalesce(p_search, ''), 100));
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select
    u.id,
    u.email::text,
    p.display_name,
    coalesce(p.account_status, 'active'::account_status)::text,
    p.suspended_at,
    p.suspended_reason,
    u.created_at,
    (select count(*) from recipes r where r.user_id = u.id)::bigint,
    (select count(*) from recipes r where r.user_id = u.id
        and r.visibility = 'public' and r.moderation_status = 'approved')::bigint,
    (select count(*) from reports rp where rp.reported_user_id = u.id)::bigint,
    (select count(*) from reports rp where rp.reporter_id = u.id)::bigint,
    exists (select 1 from admin_users a where a.user_id = u.id)
  from auth.users u
  left join profiles p on p.id = u.id
  where (
      p_status is null
      or coalesce(p.account_status, 'active'::account_status)::text = p_status
    )
    and (
      q_clean = ''
      or lower(coalesce(u.email::text, '')) like '%' || q_clean || '%'
      or lower(coalesce(p.display_name, '')) like '%' || q_clean || '%'
    )
  order by u.created_at desc
  limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset);
end;
$$;
revoke all on function admin_list_users(text, text, int, int) from public;
grant execute on function admin_list_users(text, text, int, int) to authenticated;

-- ============================================================================
-- RPC: admin_suspend_user / admin_unsuspend_user
-- ============================================================================
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
    -- Profile row should always exist (created on signup), but if not,
    -- create it so suspension takes effect.
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

create or replace function admin_unsuspend_user(p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  update profiles
    set account_status = 'active',
        suspended_at = null,
        suspended_reason = null
    where id = p_user_id;

  insert into admin_actions (admin_id, action, target_kind, target_id)
  values (v_admin, 'unsuspend_user', 'user', p_user_id);
end;
$$;
revoke all on function admin_unsuspend_user(uuid) from public;
grant execute on function admin_unsuspend_user(uuid) to authenticated;

-- ============================================================================
-- RPC: admin_get_stats — counts for the dashboard hub
-- ============================================================================
create or replace function admin_get_stats()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'reports_pending', (select count(*) from reports where status = 'pending'),
    'reports_total', (select count(*) from reports),
    'recipes_public', (select count(*) from recipes
                         where visibility = 'public' and moderation_status = 'approved'),
    'recipes_pending', (select count(*) from recipes
                         where visibility = 'public' and moderation_status = 'pending'),
    'recipes_rejected', (select count(*) from recipes where moderation_status = 'rejected'),
    'users_active', (select count(*) from profiles where coalesce(account_status, 'active'::account_status) = 'active'),
    'users_suspended', (select count(*) from profiles where account_status = 'suspended'),
    'recent_actions', coalesce((
      select jsonb_agg(row_to_json(a) order by created_at desc)
      from (
        select id, action, target_kind, target_id, notes, created_at, admin_id
        from admin_actions order by created_at desc limit 20
      ) a
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function admin_get_stats() from public;
grant execute on function admin_get_stats() to authenticated;

-- ============================================================================
-- RPC: admin_get_recipe — full recipe + ingredients for moderator review
-- (skips RLS so moderator can see private/rejected recipes)
-- ============================================================================
create or replace function admin_get_recipe(p_recipe_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_recipe jsonb;
  v_ingredients jsonb;
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

  return v_recipe || jsonb_build_object('ingredients', v_ingredients);
end;
$$;
revoke all on function admin_get_recipe(uuid) from public;
grant execute on function admin_get_recipe(uuid) to authenticated;
