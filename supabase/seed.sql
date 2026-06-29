-- Minimal ingredient seed for development. Replace with curated catalog later.
-- Run via: supabase db reset (local) or psql against the project.

insert into ingredients (name, aliases, category, default_unit, shelf_life_days, package_size, package_unit) values
  ('tomato',     '{tomatoes,roma tomato,vine tomato}', 'produce', 'piece', 7,  1,   'piece'),
  ('onion',      '{onions,yellow onion,brown onion}',  'produce', 'piece', 30, 1,   'piece'),
  ('garlic',     '{garlic clove,garlic cloves}',        'produce', 'clove', 60, 1,   'head'),
  ('olive oil',  '{}',                                   'pantry',  'ml',    365, 500, 'ml'),
  ('chicken breast', '{chicken breasts,boneless chicken breast}', 'meat', 'g', 3, 500, 'g'),
  ('rice',       '{white rice,jasmine rice}',           'pantry',  'g',     365, 1000, 'g'),
  ('salt',       '{table salt,sea salt}',                'pantry',  'g',     1825, 500, 'g'),
  ('black pepper', '{pepper,ground pepper}',             'pantry',  'g',     730, 100, 'g'),
  ('egg',        '{eggs}',                               'dairy',   'piece', 21, 12, 'piece'),
  ('butter',     '{}',                                   'dairy',   'g',     30, 250, 'g')
on conflict (name) do nothing;
