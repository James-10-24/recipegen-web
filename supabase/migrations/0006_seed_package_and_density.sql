-- Phase 4 prep: seed package_size / package_unit on common canonical
-- ingredients so grocery-list rounding has sensible defaults. Also seed
-- density_g_per_ml for ingredients where cups↔grams crossover is common
-- (flour, sugar, milk, oils, etc.) so unit conversion can bridge recipe
-- units (cups) and pantry units (g).
--
-- Safe on re-run — only sets fields that are still NULL.

update ingredients set package_size = 12,   package_unit = 'pcs' where lower(name) = 'egg' and package_size is null;
update ingredients set package_size = 1000, package_unit = 'ml'  where lower(name) = 'milk' and package_size is null;
update ingredients set package_size = 250,  package_unit = 'g'   where lower(name) = 'butter' and package_size is null;
update ingredients set package_size = 1000, package_unit = 'g'   where lower(name) = 'flour' and package_size is null;
update ingredients set package_size = 1000, package_unit = 'g'   where lower(name) = 'sugar' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'salt' and package_size is null;
update ingredients set package_size = 100,  package_unit = 'g'   where lower(name) = 'black pepper' and package_size is null;
update ingredients set package_size = 1000, package_unit = 'g'   where lower(name) = 'rice' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'pasta' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'bread' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'ml'  where lower(name) = 'olive oil' and package_size is null;
update ingredients set package_size = 1000, package_unit = 'ml'  where lower(name) = 'vegetable oil' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'ml'  where lower(name) = 'soy sauce' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'ml'  where lower(name) = 'vinegar' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'honey' and package_size is null;
update ingredients set package_size = 100,  package_unit = 'g'   where lower(name) = 'baking powder' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'baking soda' and package_size is null;
update ingredients set package_size = 400,  package_unit = 'g'   where lower(name) = 'canned tomatoes' and package_size is null;
update ingredients set package_size = 170,  package_unit = 'g'   where lower(name) = 'tomato paste' and package_size is null;
update ingredients set package_size = 1000, package_unit = 'ml'  where lower(name) = 'chicken stock' and package_size is null;
update ingredients set package_size = 400,  package_unit = 'ml'  where lower(name) = 'coconut milk' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'chicken breast' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'chicken thigh' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'ground beef' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'pork belly' and package_size is null;
update ingredients set package_size = 300,  package_unit = 'g'   where lower(name) = 'salmon' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'shrimp' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'tofu' and package_size is null;
update ingredients set package_size = 500,  package_unit = 'g'   where lower(name) = 'yogurt' and package_size is null;
update ingredients set package_size = 250,  package_unit = 'ml'  where lower(name) = 'heavy cream' and package_size is null;
update ingredients set package_size = 250,  package_unit = 'g'   where lower(name) = 'cheddar cheese' and package_size is null;
update ingredients set package_size = 200,  package_unit = 'g'   where lower(name) = 'parmesan' and package_size is null;
update ingredients set package_size = 250,  package_unit = 'g'   where lower(name) = 'mozzarella' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'onion' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'garlic' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'tomato' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'carrot' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'potato' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'bell pepper' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'cucumber' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'lettuce' and package_size is null;
update ingredients set package_size = 250,  package_unit = 'g'   where lower(name) = 'spinach' and package_size is null;
update ingredients set package_size = 400,  package_unit = 'g'   where lower(name) = 'broccoli' and package_size is null;
update ingredients set package_size = 250,  package_unit = 'g'   where lower(name) = 'mushroom' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'lemon' and package_size is null;
update ingredients set package_size = 1,    package_unit = 'pcs' where lower(name) = 'lime' and package_size is null;
update ingredients set package_size = 100,  package_unit = 'g'   where lower(name) = 'ginger' and package_size is null;
update ingredients set package_size = 50,   package_unit = 'g'   where lower(name) = 'basil' and package_size is null;
update ingredients set package_size = 50,   package_unit = 'g'   where lower(name) = 'cilantro' and package_size is null;
update ingredients set package_size = 50,   package_unit = 'g'   where lower(name) = 'parsley' and package_size is null;
update ingredients set package_size = 30,   package_unit = 'g'   where lower(name) = 'rosemary' and package_size is null;
update ingredients set package_size = 30,   package_unit = 'g'   where lower(name) = 'thyme' and package_size is null;

-- Densities for ingredients where recipes use volume (cup/tbsp) but pantry
-- tracks mass (g). Values in grams per milliliter — roughly correct, not
-- lab-grade. Refuses to convert when null (see lib/units.ts).
update ingredients set density_g_per_ml = 0.53 where lower(name) = 'flour'           and density_g_per_ml is null;
update ingredients set density_g_per_ml = 0.85 where lower(name) = 'sugar'           and density_g_per_ml is null;
update ingredients set density_g_per_ml = 1.20 where lower(name) = 'salt'            and density_g_per_ml is null;
update ingredients set density_g_per_ml = 0.50 where lower(name) = 'black pepper'    and density_g_per_ml is null;
update ingredients set density_g_per_ml = 0.75 where lower(name) = 'rice'            and density_g_per_ml is null;
update ingredients set density_g_per_ml = 0.92 where lower(name) = 'olive oil'       and density_g_per_ml is null;
update ingredients set density_g_per_ml = 0.92 where lower(name) = 'vegetable oil'   and density_g_per_ml is null;
update ingredients set density_g_per_ml = 1.03 where lower(name) = 'milk'            and density_g_per_ml is null;
update ingredients set density_g_per_ml = 0.91 where lower(name) = 'butter'          and density_g_per_ml is null;
update ingredients set density_g_per_ml = 1.01 where lower(name) = 'heavy cream'     and density_g_per_ml is null;
update ingredients set density_g_per_ml = 1.40 where lower(name) = 'honey'           and density_g_per_ml is null;
update ingredients set density_g_per_ml = 1.04 where lower(name) = 'soy sauce'       and density_g_per_ml is null;
update ingredients set density_g_per_ml = 1.01 where lower(name) = 'vinegar'         and density_g_per_ml is null;
update ingredients set density_g_per_ml = 0.90 where lower(name) = 'baking powder'   and density_g_per_ml is null;
update ingredients set density_g_per_ml = 2.20 where lower(name) = 'baking soda'     and density_g_per_ml is null;
