-- ============================================================================
-- 0033_pending_aliases.sql
--
-- Localization sub-feature: pending-aliases log + admin alias surface.
-- See docs/V1_SCOPE_DECISIONS.md (Q7e).
--
-- Problem: when a user (any language, but especially Chinese) types or
-- imports an ingredient that doesn't match the English-only canonical
-- catalog, they end up creating a user-scoped ingredient. The admin
-- (= you) has no visibility into which terms users wanted but couldn't
-- match — so the catalog can't improve over time.
--
-- This migration:
--   1. Adds `pending_aliases` — a deduped log of unmatched raw names
--      with hit counts, so the admin worklist is sorted by user impact.
--   2. Adds `log_pending_alias(raw, language)` — RPC called by the
--      client pipeline (lib/recipe-import.ts) on every catalog miss.
--      SECURITY DEFINER so authenticated users can write without seeing
--      others' pending rows.
--   3. Adds admin RPCs to read the worklist, search canonical
--      ingredients, append aliases, and mark pending rows resolved.
--   4. RLS: pending_aliases is admin-only (no client direct reads).
--      All writes go through the SECURITY DEFINER RPCs.
-- ============================================================================

create table if not exists pending_aliases (
  id uuid primary key default gen_random_uuid(),
  -- The raw text as the user/import saw it. Kept for context — admin
  -- sees what was actually typed before resolving.
  raw_name text not null,
  -- Lowercased + whitespace-collapsed for upsert grouping. Two users
  -- typing "Tomato" and "tomato" hit the same row + bump the count.
  normalized_name text not null,
  -- Auto-detected from raw_name at log time. Helps admin batch-process
  -- by language; also lets the worklist show "27 Chinese terms pending."
  language text,
  hit_count int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Resolution audit. resolved_at NULL = still in the worklist.
  resolved_at timestamptz,
  resolved_action text,  -- 'aliased' | 'created_canonical' | 'dismissed'
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_to_ingredient_id uuid references ingredients(id) on delete set null,
  -- Upsert key. COALESCE language to '' so NULL is grouped with NULL
  -- (Postgres uniqueness treats NULLs as distinct without this).
  unique (normalized_name, language)
);

-- Hot path for the admin worklist: "show me top-N unresolved by impact."
create index if not exists pending_aliases_unresolved_hot
  on pending_aliases(hit_count desc, last_seen_at desc)
  where resolved_at is null;

-- RLS: admin-only direct access. All client writes go through the
-- SECURITY DEFINER log_pending_alias RPC.
alter table pending_aliases enable row level security;

drop policy if exists pending_aliases_admin_read on pending_aliases;
create policy pending_aliases_admin_read on pending_aliases for select
  using (is_admin());

drop policy if exists pending_aliases_admin_write on pending_aliases;
create policy pending_aliases_admin_write on pending_aliases for all
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- log_pending_alias — client-callable upsert. Bumps hit_count on
-- collision; inserts a new row otherwise. Skips short/empty input
-- (guard against noise). SECURITY DEFINER so the function can write to
-- the admin-RLS-gated table on behalf of any authenticated user.
-- ---------------------------------------------------------------------------
create or replace function log_pending_alias(
  p_raw_name text,
  p_language text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_raw text := nullif(trim(coalesce(p_raw_name, '')), '');
  v_normalized text;
  v_lang text := nullif(trim(coalesce(p_language, '')), '');
begin
  -- Guards: no logging for noise (empty / single-char), no logging
  -- when caller is anonymous (guest), no logging when caller is the
  -- admin themselves (admin's own typing shouldn't pollute the
  -- worklist they're trying to clear).
  if v_raw is null or length(v_raw) < 2 then
    return;
  end if;
  if auth.uid() is null then
    return;
  end if;
  if public._is_anonymous() then
    return;
  end if;
  if is_admin() then
    return;
  end if;

  v_normalized := lower(regexp_replace(v_raw, '\s+', ' ', 'g'));

  insert into pending_aliases (raw_name, normalized_name, language)
  values (v_raw, v_normalized, v_lang)
  on conflict (normalized_name, language) do update
    set hit_count = pending_aliases.hit_count + 1,
        last_seen_at = now()
    where pending_aliases.resolved_at is null;
end;
$$;
revoke all on function log_pending_alias(text, text) from public;
grant execute on function log_pending_alias(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_list_pending_aliases — worklist for the in-app admin surface.
-- Returns unresolved rows ordered by impact (hit_count desc).
-- ---------------------------------------------------------------------------
create or replace function admin_list_pending_aliases(
  p_limit int default 50
)
returns table (
  id uuid,
  raw_name text,
  normalized_name text,
  language text,
  hit_count int,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select pa.id, pa.raw_name, pa.normalized_name, pa.language,
         pa.hit_count, pa.first_seen_at, pa.last_seen_at
  from pending_aliases pa
  where pa.resolved_at is null
  order by pa.hit_count desc, pa.last_seen_at desc
  limit greatest(1, least(p_limit, 200));
end;
$$;
revoke all on function admin_list_pending_aliases(int) from public;
grant execute on function admin_list_pending_aliases(int) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_search_canonical_ingredients — search the canonical catalog
-- for the alias-assignment flow. Returns name + current aliases so the
-- admin can see what's already mapped before adding more.
-- ---------------------------------------------------------------------------
create or replace function admin_search_canonical_ingredients(
  p_query text,
  p_limit int default 20
)
returns table (
  id uuid,
  name text,
  aliases text[],
  category text,
  default_unit text
)
language plpgsql stable security definer set search_path = public as $$
declare
  q text := lower(trim(coalesce(p_query, '')));
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;

  return query
  select i.id, i.name, i.aliases, i.category, i.default_unit
  from ingredients i
  where i.is_canonical = true
    and (
      q = ''
      or lower(i.name) like '%' || q || '%'
      or exists (
        select 1 from unnest(i.aliases) a
        where lower(a) like '%' || q || '%'
      )
    )
  order by
    case when lower(i.name) = q then 0
         when lower(i.name) like q || '%' then 1
         else 2 end,
    i.name asc
  limit greatest(1, least(p_limit, 100));
end;
$$;
revoke all on function admin_search_canonical_ingredients(text, int) from public;
grant execute on function admin_search_canonical_ingredients(text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_add_alias_to_ingredient — append an alias to a canonical row's
-- aliases[] (deduped), optionally marking a pending row resolved in
-- the same transaction. Audit-logged via admin_actions.
-- ---------------------------------------------------------------------------
create or replace function admin_add_alias_to_ingredient(
  p_ingredient_id uuid,
  p_alias text,
  p_pending_id uuid default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
  v_alias text := trim(coalesce(p_alias, ''));
  v_existing_name text;
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if v_alias = '' then
    raise exception 'Alias cannot be empty';
  end if;

  -- Make sure the target ingredient exists + is canonical (don't add
  -- aliases to user-scoped rows).
  select name into v_existing_name from ingredients
  where id = p_ingredient_id and is_canonical = true;
  if v_existing_name is null then
    raise exception 'Canonical ingredient not found';
  end if;

  -- Dedupe — only append if the alias isn't already present (case-
  -- insensitive). array_append + the equality check via unnest gives
  -- us idempotent behavior; re-running the same call is a no-op.
  if not exists (
    select 1 from ingredients i, unnest(i.aliases) a
    where i.id = p_ingredient_id and lower(a) = lower(v_alias)
  ) then
    update ingredients
       set aliases = array_append(aliases, v_alias)
     where id = p_ingredient_id;
  end if;

  if p_pending_id is not null then
    update pending_aliases
       set resolved_at = now(),
           resolved_action = 'aliased',
           resolved_by = v_admin,
           resolved_to_ingredient_id = p_ingredient_id
     where id = p_pending_id
       and resolved_at is null;
  end if;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes)
  values (
    v_admin,
    'add_ingredient_alias',
    'ingredient',
    p_ingredient_id,
    'alias=' || v_alias || coalesce(' (resolved pending_id=' || p_pending_id::text || ')', '')
  );
end;
$$;
revoke all on function admin_add_alias_to_ingredient(uuid, text, uuid) from public;
grant execute on function admin_add_alias_to_ingredient(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_resolve_pending_alias — mark a pending row resolved without
-- adding an alias. For the "dismiss noise" and "created new canonical
-- separately" flows.
-- ---------------------------------------------------------------------------
create or replace function admin_resolve_pending_alias(
  p_pending_id uuid,
  p_action text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := auth.uid();
begin
  if not is_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_action not in ('dismissed', 'created_canonical') then
    raise exception 'Invalid action: %', p_action;
  end if;

  update pending_aliases
     set resolved_at = now(),
         resolved_action = p_action,
         resolved_by = v_admin
   where id = p_pending_id
     and resolved_at is null;

  insert into admin_actions (admin_id, action, target_kind, target_id, notes)
  values (
    v_admin,
    'resolve_pending_alias',
    'pending_alias',
    p_pending_id,
    'action=' || p_action
  );
end;
$$;
revoke all on function admin_resolve_pending_alias(uuid, text) from public;
grant execute on function admin_resolve_pending_alias(uuid, text) to authenticated;
