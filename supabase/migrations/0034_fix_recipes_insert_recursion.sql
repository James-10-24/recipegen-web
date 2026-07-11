-- Fix: "infinite recursion detected in policy for relation recipes".
--
-- 0025's recipes_insert WITH CHECK enforced the guest 10-recipe cap with an
-- inline `select count(*) from recipes`. A subquery against `recipes` from
-- inside a `recipes` policy re-enters RLS on the same relation, which Postgres
-- rejects outright. Because the OR's subquery is planned even for
-- authenticated (non-anonymous) users, EVERY recipe insert failed — not just
-- guests' — with a 500 "infinite recursion detected in policy".
--
-- Fix: compute the count in a SECURITY DEFINER helper that runs as the
-- function owner and therefore bypasses RLS on `recipes`. It only ever counts
-- the caller's own rows (user_id = auth.uid()), so exposing it to
-- authenticated/anon leaks nothing.

create or replace function public._own_recipe_count()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int from public.recipes where user_id = auth.uid();
$$;

revoke all on function public._own_recipe_count() from public;
grant execute on function public._own_recipe_count() to authenticated, anon;

drop policy if exists recipes_insert on recipes;
create policy recipes_insert on recipes for insert
with check (
  user_id = auth.uid()
  and visibility = 'private'
  and (
    not public._is_anonymous()
    or public._own_recipe_count() < 10
  )
);
