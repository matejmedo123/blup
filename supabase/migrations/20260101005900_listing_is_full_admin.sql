-- ============================================================================
-- BLUP · 0059 · Putting BLUP's name on somebody else's event is an owner's call
-- ============================================================================
-- The listing guard accepted `is_admin()`, which is admin *or* moderator. A
-- moderator's job is content — hiding a report, removing a photo. Saying "BLUP
-- added this" is something else: it is our name on a stranger's event, it is
-- what the terms lean on when they say the contract is between the buyer and
-- the organizer, and it is the one label on the site that borrows our own
-- credibility. That belongs to a full admin.
-- ============================================================================

set search_path = public, extensions;

create or replace function public.guard_platform_listing()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.listed_by_platform and not public.is_full_admin() then
      raise exception 'NOT_AUTHORIZED'
        using hint = 'Event za niekoho iného vie pridať len admin BLUPu.';
    end if;
    return new;
  end if;

  -- On update: the flag and the attribution move together, and only for admins.
  if (new.listed_by_platform    is distinct from old.listed_by_platform
   or new.external_organizer_name is distinct from old.external_organizer_name
   or new.external_source_url     is distinct from old.external_source_url)
    and not public.is_full_admin()
  then
    raise exception 'NOT_AUTHORIZED'
      using hint = 'Označenie „Pridal BLUP" spravuje admin BLUPu.';
  end if;

  return new;
end;
$$;
