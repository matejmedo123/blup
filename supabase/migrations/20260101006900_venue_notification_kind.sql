-- ============================================================================
-- One enum value, alone, because ADD VALUE cannot be used in the transaction
-- that adds it. The next migration is what uses it.
-- ============================================================================
alter type notification_type add value if not exists 'venue_plan';
