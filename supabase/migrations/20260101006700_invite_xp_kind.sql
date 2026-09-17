-- ============================================================================
-- Three enum values, on their own, because Postgres insists.
--
-- ALTER TYPE ... ADD VALUE may run inside a transaction, but the new value
-- cannot be USED until that transaction commits — so the xp_rules row that
-- names it has to live in the next migration rather than below it. A file with
-- one line in it is the price of that rule.
-- ============================================================================
alter type xp_kind add value if not exists 'friend_invited';

-- "A ticket you were waiting for is back" and "the person you invited actually
-- turned up" are both their own thing. Filing them under event_updated and
-- new_follower would have worked and would have shown the wrong icon, the wrong
-- sentence, and the wrong answer to "why am I getting this".
alter type notification_type add value if not exists 'waitlist_open';
alter type notification_type add value if not exists 'invite_arrived';
