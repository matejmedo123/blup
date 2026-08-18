-- ============================================================================
-- BLUP · 0015b · New notification types (messaging + gamification)
-- ============================================================================
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
-- so the new enum labels live in their own migration ahead of the features that
-- emit them.
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;

alter type notification_type add value if not exists 'new_message';
alter type notification_type add value if not exists 'badge_earned';
alter type notification_type add value if not exists 'level_up';
