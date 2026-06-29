-- Phase 1: user-scoped ingredients + fuzzy search RPC + canonical seed

-- ============================================================================
-- ingredients: allow user-owned rows (null user_id = canonical/global)
-- ============================================================================
alter table ingredients add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table ingredients drop constraint if exists ingredients_name_key;

-- Canonical rows: one per name (case-insensitive).
create unique index if not exists ingredients_canonical_name
  on ingredients (lower(name)) where user_id is null;

-- User rows: one per (user, name) (case-insensitive).
create unique index if not exists ingredients_user_name
  on ingredients (user_id, lower(name)) where user_id is not null;

create index if not exists ingredients_user on ingredients(user_id) where user_id is not null;

-- RLS: update select policy and add write policies.
drop policy if exists ingredients_read on ingredients;
create policy ingredients_read on ingredients for select
  using (user_id is null or user_id = auth.uid());

drop policy if exists ingredients_insert_own on ingredients;
create policy ingredients_insert_own on ingredients for insert
  with check (user_id = auth.uid());

drop policy if exists ingredients_update_own on ingredients;
create policy ingredients_update_own on ingredients for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists ingredients_delete_own on ingredients;
create policy ingredients_delete_own on ingredients for delete
  using (user_id = auth.uid());

-- ============================================================================
-- search_ingredients: trigram-ranked fuzzy search across canonical + own rows
-- ============================================================================
create or replace function search_ingredients(q text, lim int default 10)
returns table (
  id uuid,
  name text,
  category text,
  default_unit text,
  user_id uuid,
  similarity real
)
language sql stable security invoker set search_path = public as $$
  select i.id, i.name, i.category, i.default_unit, i.user_id,
         greatest(
           similarity(i.name, q),
           coalesce((select max(similarity(a, q)) from unnest(i.aliases) a), 0)
         ) as similarity
  from ingredients i
  where (i.user_id is null or i.user_id = auth.uid())
    and (
      i.name ilike q || '%'
      or i.name % q
      or exists (select 1 from unnest(i.aliases) a where a ilike q || '%' or a % q)
    )
  order by similarity desc, i.name asc
  limit lim;
$$;

-- ============================================================================
-- Canonical ingredient seed (~50 common items) — idempotent
-- ============================================================================
insert into ingredients (name, aliases, category, default_unit, shelf_life_days) values
  ('Tomato', array['tomatoes', 'roma tomato'], 'produce', 'pcs', 7),
  ('Onion', array['onions', 'yellow onion'], 'produce', 'pcs', 30),
  ('Garlic', array['garlic clove', 'garlic cloves'], 'produce', 'pcs', 60),
  ('Carrot', array['carrots'], 'produce', 'pcs', 21),
  ('Potato', array['potatoes'], 'produce', 'pcs', 30),
  ('Bell pepper', array['capsicum', 'bell peppers'], 'produce', 'pcs', 10),
  ('Cucumber', array['cucumbers'], 'produce', 'pcs', 7),
  ('Lettuce', array['romaine', 'iceberg'], 'produce', 'pcs', 7),
  ('Spinach', array['baby spinach'], 'produce', 'g', 5),
  ('Broccoli', '{}','produce', 'g', 7),
  ('Mushroom', array['mushrooms', 'button mushroom'], 'produce', 'g', 7),
  ('Lemon', array['lemons'], 'produce', 'pcs', 21),
  ('Lime', array['limes'], 'produce', 'pcs', 21),
  ('Ginger', array['ginger root'], 'produce', 'g', 30),
  ('Chili', array['chilli', 'chili pepper', 'chilies'], 'produce', 'pcs', 14),
  ('Chicken breast', array['chicken breasts'], 'meat', 'g', 2),
  ('Chicken thigh', array['chicken thighs'], 'meat', 'g', 2),
  ('Ground beef', array['beef mince', 'minced beef'], 'meat', 'g', 2),
  ('Pork belly', '{}','meat', 'g', 2),
  ('Salmon', array['salmon fillet'], 'seafood', 'g', 2),
  ('Shrimp', array['prawns', 'prawn'], 'seafood', 'g', 2),
  ('Egg', array['eggs'], 'dairy', 'pcs', 28),
  ('Tofu', array['firm tofu'], 'produce', 'g', 7),
  ('Milk', '{}','dairy', 'ml', 7),
  ('Butter', '{}','dairy', 'g', 30),
  ('Cheddar cheese', array['cheddar'], 'dairy', 'g', 21),
  ('Parmesan', array['parmesan cheese'], 'dairy', 'g', 30),
  ('Mozzarella', array['mozzarella cheese'], 'dairy', 'g', 14),
  ('Yogurt', array['greek yogurt'], 'dairy', 'g', 14),
  ('Heavy cream', array['cream', 'double cream'], 'dairy', 'ml', 7),
  ('Rice', array['white rice', 'jasmine rice'], 'grain', 'g', 365),
  ('Pasta', array['spaghetti', 'penne'], 'grain', 'g', 365),
  ('Bread', '{}','grain', 'pcs', 5),
  ('Flour', array['all-purpose flour', 'plain flour'], 'pantry', 'g', 365),
  ('Sugar', array['white sugar'], 'pantry', 'g', 730),
  ('Salt', '{}','pantry', 'g', 1825),
  ('Black pepper', array['pepper'], 'pantry', 'g', 730),
  ('Olive oil', '{}','pantry', 'ml', 365),
  ('Vegetable oil', array['canola oil'], 'pantry', 'ml', 365),
  ('Soy sauce', '{}','pantry', 'ml', 365),
  ('Vinegar', array['white vinegar'], 'pantry', 'ml', 730),
  ('Honey', '{}','pantry', 'g', 730),
  ('Baking powder', '{}','pantry', 'g', 365),
  ('Baking soda', '{}','pantry', 'g', 730),
  ('Tomato paste', '{}','pantry', 'g', 14),
  ('Canned tomatoes', array['diced tomatoes'], 'pantry', 'g', 730),
  ('Chicken stock', array['chicken broth'], 'pantry', 'ml', 365),
  ('Coconut milk', '{}','pantry', 'ml', 365),
  ('Basil', array['fresh basil'], 'produce', 'g', 5),
  ('Cilantro', array['coriander'], 'produce', 'g', 5),
  ('Parsley', '{}','produce', 'g', 7),
  ('Rosemary', '{}','produce', 'g', 14),
  ('Thyme', '{}','produce', 'g', 14)
on conflict do nothing;
