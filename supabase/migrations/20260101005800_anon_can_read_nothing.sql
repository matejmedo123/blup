-- ============================================================================
-- BLUP · 0058 · A visitor should see no rows, not an error
-- ============================================================================
-- `tickets_select` (0049) asks `guest_email = current_user_email()`, and
-- current_user_email() was revoked from `anon`. So a signed-out browser reading
-- the tickets table did not get zero rows — it got
--
--     ERROR: permission denied for function current_user_email
--
-- which surfaces in the app as a failure rather than as an empty list. It went
-- unnoticed because every screen that reads tickets was already behind a
-- sign-in gate; opening the checkout to people without an account is exactly
-- the change that starts walking into it.
--
-- Granting it to `anon` leaks nothing. It returns the caller's own address and
-- nothing else, and a caller with no session has no address: it answers null,
-- the policy term is false, and the visitor sees the zero rows they should.
-- ============================================================================

set search_path = public, extensions;

grant execute on function public.current_user_email() to anon;
