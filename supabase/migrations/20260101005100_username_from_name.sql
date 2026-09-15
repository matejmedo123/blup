-- ============================================================================
-- BLUP · 0051 · A handle made from your name, and a way to check one
-- ============================================================================
-- The automatic handle came from the e-mail address: jozko.mrkvicka@gmail.com
-- became @jozko.mrkvicka, which publishes half of somebody's address to
-- everyone who opens their profile. The display name is collected during
-- sign-up and is already public, so it is the right thing to derive from; the
-- e-mail stays as a last resort for an account created without a name.
--
-- Either way it is only a suggestion — onboarding asks, and this is what the
-- field starts from.
-- ============================================================================
set search_path = public, extensions;

-- Strips diacritics so "Jožko Mrkvička" suggests "jozkomrkvicka" rather than
-- losing every accented letter and suggesting "jokomrkvika".
create or replace function public.handle_from_name(p_name text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select nullif(
    substr(
      regexp_replace(
        lower(translate(
          coalesce(p_name, ''),
          'áäčďéěíĺľňóôöŕřšťúůüýžÁÄČĎÉĚÍĹĽŇÓÔÖŔŘŠŤÚŮÜÝŽ',
          'aacdeeillnooorrstuuuyzAACDEEILLNOOORRSTUUUYZ'
        )),
        '[^a-z0-9]', '', 'g'
      ),
      1, 20
    ),
    ''
  );
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base_username text;
  candidate     text;
  suffix        integer := 0;
begin
  base_username := coalesce(
    -- Anything the client asked for explicitly.
    public.handle_from_name(new.raw_user_meta_data ->> 'username'),
    -- Then the name they gave when signing up. Public already.
    public.handle_from_name(new.raw_user_meta_data ->> 'display_name'),
    -- Only then the e-mail, which is not.
    public.handle_from_name(split_part(coalesce(new.email, 'blupper'), '@', 1)),
    'blupper'
  );

  if char_length(base_username) < 3 then
    base_username := 'blupper' || base_username;
  end if;
  base_username := substr(base_username, 1, 20);

  candidate := base_username;
  while exists (select 1 from public.profiles p where p.username = candidate::citext) loop
    suffix := suffix + 1;
    candidate := substr(base_username, 1, 20) || suffix::text;
  end loop;

  insert into public.profiles (id, email, username, display_name)
  values (
    new.id,
    new.email,
    candidate,
    coalesce(new.raw_user_meta_data ->> 'display_name', candidate)
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- "Is this one free?"
-- ---------------------------------------------------------------------------
-- Asked while somebody types, so it answers about one handle and nothing else —
-- never a list, never a search. Profiles are publicly readable, so this leaks
-- nothing that a profile page does not; it just saves a round trip through a
-- failed save.
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
  if char_length(handle) < 3 then
    return jsonb_build_object('ok', false, 'reason', 'TOO_SHORT');
  end if;
  if char_length(handle) > 20 then
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
grant execute on function public.handle_from_name(text) to anon, authenticated;
