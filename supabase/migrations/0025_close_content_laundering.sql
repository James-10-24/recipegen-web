-- Close the content-laundering / clone-republish bypass.
--
-- Before: recipes_insert / recipes_update allowed clients to write
--   visibility='public' as long as moderation_status='approved'. Because
--   save_recipe (migration 0016) ships clones with moderation_status='approved'
--   already (they inherit the source's approval), a cloner could:
--     1. Save user X's approved public recipe.
--     2. Toggle their clone to public WITHOUT changing content.
--     3. The _reset_moderation_on_edit trigger doesn't fire (no content
--        field changed), so moderation_status stays 'approved'.
--     4. RLS WITH CHECK admits the row → clone appears in Discover under
--        the cloner's name, bypassing the moderate-recipe edge function.
--
--   Net: content laundering + author impersonation by passthrough.
--
-- After: clients can only write visibility='private'. The single legitimate
--   path to visibility='public' is the moderate-recipe edge function, which
--   uses service role and bypasses RLS. The client (lib/queries/recipes.ts)
--   already always writes 'private' and routes the publish through the edge
--   function, so no client change is needed — this just makes the contract
--   defense-in-depth rather than convention.
--
-- The guest 10-recipe cap is preserved.

drop policy if exists recipes_insert on recipes;
create policy recipes_insert on recipes for insert
with check (
  user_id = auth.uid()
  and visibility = 'private'
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
  and visibility = 'private'
);
