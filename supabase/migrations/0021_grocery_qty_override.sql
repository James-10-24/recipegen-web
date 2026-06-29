-- Grocery list: per-item qty override.
--
-- When a user taps a list row's qty to edit (e.g., "I'll grab 2 dozen eggs
-- because they're on sale, not the suggested 6"), we mark the row so
-- subsequent regenerations preserve the user value instead of recomputing.
--
-- Default false → existing rows keep current behavior (computed values
-- regenerate cleanly). Rows the user has tapped to edit will carry the
-- flag forward.

alter table grocery_list_items
  add column if not exists qty_overridden_by_user boolean not null default false;

-- Existing rows are not user-edited; the default value matches reality.
