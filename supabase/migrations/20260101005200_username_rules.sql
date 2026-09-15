-- ============================================================================
-- BLUP · 0052 · One rule for what a handle may look like
-- ============================================================================
-- `username_available` said 3–20 while the table's own constraint says 3–24, so
-- a perfectly legal 22-character handle was reported as too long by the check
-- and then accepted by the save. A rule that two pieces of code disagree about
-- is not a rule.
--
-- Letters, digits, a dot and an underscore. Nothing else, and the message says
-- so rather than making somebody guess by trial.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.username_available(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  handle text := lower(btrim(coalesce(p_username, '')));
begin
  if handle = '' then
    return jsonb_build_object('ok', false, 'reason', 'EMPTY');
  end if;
  if char_length(handle) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'TOO_SHORT');
  end if;
  -- 24, the same number the profiles table checks.
  if char_length(handle) > 24 then
    return jsonb_build_object('ok', false, 'reason', 'TOO_LONG');
  end if;
  if handle !~ '^[a-z0-9_.]+$' then
    return jsonb_build_object('ok', false, 'reason', 'BAD_CHARACTERS');
  end if;

  if exists (
    select 1 from public.profiles p
    where p.username = handle::citext and p.id is distinct from auth.uid()
  ) then
    return jsonb_build_object('ok', false, 'reason', 'TAKEN');
  end if;

  return jsonb_build_object('ok', true, 'reason', null);
end;
$$;

grant execute on function public.username_available(text) to anon, authenticated;
