-- ============================================================================
-- 0030_paste_import_ai_kind.sql
--
-- Q4 of the recipe-form work: paste-from-clipboard import.
--
-- Adds a 'paste_import' value to the `ai_kind` enum so the AI usage ledger
-- and the per-tier claim_ai_op gate can track paste extractions separately
-- from URL parses. Same cost profile as `url_parse` (one LLM call against
-- a small text input), but the analytics bucket stays distinct so we can
-- see paste vs URL volume independently.
--
-- Mirrors the precedent set by 0014 which added 'pantry_extract'.
--
-- Deploy order: this migration first, then the
-- supabase/functions/extract-recipe-from-text edge function. The function
-- references the enum value at runtime via claimOp.
-- ============================================================================

alter type ai_kind add value if not exists 'paste_import';
