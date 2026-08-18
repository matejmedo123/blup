-- ============================================================================
-- BLUP · 0015 · Make views respect the caller's RLS
-- ============================================================================
-- A PostgreSQL view runs with the permissions of its OWNER unless it opts in to
-- `security_invoker`. `organization_balances` is owned by the migration role, so
-- reading it bypassed Row Level Security on `ledger_entries` entirely: any
-- authenticated user could read the revenue and payout balance of every
-- organization on the platform. Supabase's linter flags this as CRITICAL, and
-- it is right.
--
-- With security_invoker the view evaluates under the querying user, so the
-- ledger_entries policy (owner/admin/finance of that organization, or a BLUP
-- admin) applies. Organizers still see their own balance; nobody else does.
--
-- Requires PostgreSQL 15+. Supabase runs 15/17 and the test cluster is 16.
-- ============================================================================

set search_path = public, extensions;

alter view public.organization_balances set (security_invoker = on);
