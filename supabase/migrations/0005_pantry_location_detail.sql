-- Phase 3 follow-up: optional free-text location detail for pantry items
-- in the "other" bucket (e.g. "garage fridge", "wine cooler", "spice rack").
-- Nullable; only populated when location = 'other'.
alter table pantry_items add column if not exists location_detail text;
