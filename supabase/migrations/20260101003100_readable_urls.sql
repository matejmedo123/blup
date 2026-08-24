-- ============================================================================
-- Addresses a person can read, and paste.
--
--   /event/c3d9abad-e5d9-42de-9a34-13c810a04a3d
--   /event/techno-v-starej-trznici-c3d9abad
--
-- The first tells nobody anything, survives no retyping, and looks like an
-- error when it is pasted into a chat. Every event gets a slug made from its
-- title; the old uuid keeps working, because links already handed out must not
-- start 404-ing.
-- ============================================================================

-- unaccent is not installed, and this only has to handle the Latin alphabet
-- Slovak is written in, so the fold is a table rather than a dependency.
create or replace function public.slugify(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select nullif(
    trim(both '-' from
      regexp_replace(
        regexp_replace(
          lower(translate(
            coalesce(p_text, ''),
            'áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽàâçèêëîïôùûüÀÂÇÈÊËÎÏÔÙÛÜãõäöüßÃÕÄÖÜąćęłńśźżĄĆĘŁŃŚŹŻěřůĚŘŮ',
            'aacdeillnoorstuyzAACDEILLNOORSTUYZaaceeeiiouuuAACEEEIIOUUUaoaousAOAOUacelnszzACELNSZZeruERU'
          )),
          '[^a-z0-9]+', '-', 'g'),
        '-{2,}', '-', 'g')
    ),
  '');
$$;

alter table public.events add column if not exists slug text;

-- ---------------------------------------------------------------------------
-- Slug assignment.
--
-- The title alone is not unique — two "Silvester 2026" are not a mistake — so
-- a slug that is taken gains a short suffix from the event's own id. That is
-- stable: regenerating produces the same slug rather than a growing counter.
-- ---------------------------------------------------------------------------
create or replace function public.event_slug_for(p_id uuid, p_title text)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  base      text := public.slugify(p_title);
  candidate text;
begin
  -- A title of nothing but punctuation or emoji leaves no letters behind.
  if base is null then
    return 'event-' || left(replace(p_id::text, '-', ''), 8);
  end if;

  base := left(base, 60);
  candidate := base;

  if exists (select 1 from public.events e where e.slug = candidate and e.id <> p_id) then
    candidate := base || '-' || left(replace(p_id::text, '-', ''), 8);
  end if;

  return candidate;
end;
$$;

create or replace function public.set_event_slug()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Regenerated when the title changes, so a corrected typo does not live on in
  -- the address for the life of the event. The uuid still resolves either way.
  if tg_op = 'INSERT' or new.title is distinct from old.title then
    new.slug := public.event_slug_for(new.id, new.title);
  end if;
  return new;
end;
$$;

drop trigger if exists events_set_slug on public.events;
create trigger events_set_slug
  before insert or update of title on public.events
  for each row execute function public.set_event_slug();

-- Backfill, oldest first so the earliest event keeps the unsuffixed slug.
do $$
declare e record;
begin
  for e in select id, title from public.events where slug is null order by created_at loop
    update public.events set slug = public.event_slug_for(e.id, e.title) where id = e.id;
  end loop;
end $$;

create unique index if not exists events_slug_key on public.events (slug);

-- ---------------------------------------------------------------------------
-- Resolution: one function that takes whatever is in the address bar.
-- ---------------------------------------------------------------------------
create or replace function public.event_id_from_ref(p_ref text)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    -- A uuid is still a uuid: links handed out before slugs existed must work.
    when p_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then p_ref::uuid
    else (select e.id from public.events e where e.slug = p_ref)
  end;
$$;

create or replace function public.profile_id_from_ref(p_ref text)
returns uuid
language sql
stable
-- citext lives in the extensions schema; without it on the path the cast below
-- fails at creation time rather than at call time.
set search_path = public, extensions, pg_temp
as $$
  select case
    when p_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then p_ref::uuid
    -- Both @handle and handle, because people paste the @ and people type it.
    else (select p.id from public.profiles p
          where p.username = ltrim(p_ref, '@')::citext)
  end;
$$;

grant execute on function public.slugify(text) to anon, authenticated;
grant execute on function public.event_id_from_ref(text) to anon, authenticated;
grant execute on function public.profile_id_from_ref(text) to anon, authenticated;
