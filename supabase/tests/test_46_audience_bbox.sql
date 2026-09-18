-- ============================================================================
-- BLUP test 46 · Obdĺžnik okolo kruhu nesmie zmeniť odpoveď
-- ============================================================================
-- Optimalizácia, ktorá po ceste stratí človeka, je horšia než pomalý dotaz:
-- organizátor by zaplatil za publikum, ktoré je v skutočnosti väčšie, a nikdy
-- by sa to nedozvedel. Preto sa tu ten istý odhad počíta dvakrát — raz cez
-- funkciu s obdĺžnikom, raz priamym dotazom bez neho — a musí sedieť na kus.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

set local search_path = public, extensions;

insert into auth.users (id, email)
select ('a4646464-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       'bbox' || i || '@example.com'
from generate_series(1, 120) i;

insert into auth.users (id, email) values
  ('a4646464-1111-1111-1111-111111111111', 'organizator46@example.com');

-- 120 ľudí rozsypaných okolo Nitry: časť v kruhu, časť v rohoch obdĺžnika
-- (teda vnútri obdĺžnika, ale mimo kruhu), časť úplne inde. Rohy sú ten prípad,
-- kvôli ktorému test existuje.
update public.profiles p
set latitude  = 48.3069 + ((p.id::text ~ '[13579]$')::int * 0.22) - 0.11
                        + (('x' || substr(md5(p.id::text), 1, 4))::bit(16)::int % 100) * 0.004,
    longitude = 18.0864 + (('x' || substr(md5(p.id::text), 5, 4))::bit(16)::int % 100) * 0.006 - 0.3
where p.id::text like 'a4646464-0000%';

insert into public.events (id, creator_id, title, category, latitude, longitude,
                           start_at, end_at, is_free, status, visibility)
values ('a4646464-2222-2222-2222-222222222222',
        'a4646464-1111-1111-1111-111111111111',
        'Event v Nitre', 'techno', 48.3069, 18.0864,
        now() + interval '20 days', now() + interval '20 days 5 hours',
        true, 'published', 'public');

do $$
declare
  ev      uuid := 'a4646464-2222-2222-2222-222222222222';
  radius  integer;
  fast    integer;
  slow    integer;
  checked integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a4646464-1111-1111-1111-111111111111', true);

  -- Cez celý rozsah polomerov, ktorý obrazovka ponúka.
  foreach radius in array array[1000, 5000, 15000, 30000, 60000, 120000, 200000]
  loop
    fast := (public.ad_audience_estimate(ev, radius, null) ->> 'people')::int;

    -- To isté bez obdĺžnika, teda presne tak, ako to bolo pred optimalizáciou.
    select count(*) into slow
    from public.profiles p, public.events e
    where e.id = ev
      and p.id <> e.creator_id
      and p.latitude is not null
      and p.longitude is not null
      and not coalesce(p.is_suspended, false)
      and public.blup_distance_m(e.latitude, e.longitude, p.latitude, p.longitude) <= radius;

    assert fast = slow,
      format('okruh %s m: cez obdĺžnik %s ľudí, bez neho %s', radius, fast, slow);
    checked := checked + 1;
  end loop;

  reset role;
  assert checked = 7, 'všetkých sedem polomerov sa skutočne overilo';

  -- A dôkaz, že sa tu neoveruje prázdno: pri 30 km musia byť ľudia, ktorí sú
  -- V OBDĹŽNIKU, ale MIMO kruhu — teda presne tí, o ktorých by sa zlý obdĺžnik
  -- pomýlil. Bez nich by zhoda hore nič nehovorila.
  declare
    in_box    integer;
    in_circle integer;
    lat_d     double precision := 30000 / 111320.0;
    lon_d     double precision := 30000 / (111320.0 * cos(radians(48.3069)));
  begin
    select
      count(*) filter (
        where p.latitude between 48.3069 - lat_d and 48.3069 + lat_d
          and p.longitude between 18.0864 - lon_d and 18.0864 + lon_d
      ),
      count(*) filter (
        where public.blup_distance_m(48.3069, 18.0864, p.latitude, p.longitude) <= 30000
      )
    into in_box, in_circle
    from public.profiles p
    where p.id::text like 'a4646464-0000%';

    assert in_box > in_circle,
      format('rohy obdĺžnika musia byť obsadené, inak test nič netestuje (%s v obdĺžniku, %s v kruhu)',
             in_box, in_circle);
  end;

  raise notice 'PASS obdĺžnik nestratí ani jedného človeka (7 polomerov, 120 profilov)';
end $$;

-- --- a s cieleným publikom to platí tiež --------------------------------------
do $$
declare
  ev   uuid := 'a4646464-2222-2222-2222-222222222222';
  fast integer;
  slow integer;
begin
  insert into public.user_interests (user_id, interest_id)
  select p.id, i.id
  from public.profiles p
  cross join lateral (select id from public.interests where slug = 'techno' limit 1) i
  where p.id::text like 'a4646464-0000-0000-0000-00000000000%'
  on conflict do nothing;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a4646464-1111-1111-1111-111111111111', true);

  fast := (public.ad_audience_estimate(ev, 200000, array['music']) ->> 'people')::int;

  select count(*) into slow
  from public.profiles p, public.events e
  where e.id = ev
    and p.id <> e.creator_id
    and p.latitude is not null
    and p.longitude is not null
    and not coalesce(p.is_suspended, false)
    and public.blup_distance_m(e.latitude, e.longitude, p.latitude, p.longitude) <= 200000
    and exists (
      select 1 from public.user_interests ui
      join public.interests i on i.id = ui.interest_id
      where ui.user_id = p.id and i.category = 'music'
    );

  reset role;
  assert fast = slow, format('s cielením: %s vs %s', fast, slow);
  assert fast > 0, 'a niekoho to naozaj našlo — inak sa zhoda nič nedokazuje';
  raise notice 'PASS cielenie na záujmy sa obdĺžnikom nepokazilo';
end $$;

rollback;
