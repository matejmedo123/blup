-- ============================================================================
-- Hľadanie nájde interpreta, mesto aj miesto — nielen názov eventu
-- ============================================================================
-- Človek nehľadá „Koncert v hale". Hľadá „Don Toliver", „Bratislava" alebo
-- „O2 Arena". Test sa pýta presne na to a zvlášť na dve veci, ktoré sa ľahko
-- stratia: že sa nájde aj meno, ktoré v názve eventu vôbec nie je, a že
-- diakritika hľadanie nezastaví.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5656565-0000-0000-0000-000000000001', 'org56@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a5656565-0000-0000-0000-000000000002', 'fan56@example.com',  now(), '{"display_name":"Fanúšik"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b5656565-0000-0000-0000-000000000001', 'Hala s.r.o.', 'hala-56',
        'a5656565-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b5656565-0000-0000-0000-000000000001', 'a5656565-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- Názov zámerne nehovorí, kto hrá. Presne toto sa doteraz nedalo nájsť.
insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, city, venue_name, is_free, price_cents, currency,
  status, visibility, performers
) values
  ('e5656565-0000-0000-0000-000000000001',
   'a5656565-0000-0000-0000-000000000001', 'b5656565-0000-0000-0000-000000000001',
   'Koncert v hale', 'concert', 48.15, 17.11,
   now() + interval '20 days', now() + interval '20 days 3 hours',
   'Bratislava', 'O2 Arena', false, 4000, 'EUR', 'published', 'public',
   array['Don Toliver', 'Travis Scott']),
  ('e5656565-0000-0000-0000-000000000002',
   'a5656565-0000-0000-0000-000000000001', 'b5656565-0000-0000-0000-000000000001',
   'Jarný festival', 'festival', 48.72, 21.25,
   now() + interval '40 days', now() + interval '40 days 8 hours',
   'Košice', 'Amfiteáter', true, 0, 'EUR', 'published', 'public',
   array['Dvořák Ensemble']),
  -- Ten istý interpret druhýkrát: počet u interpreta musí sedieť.
  ('e5656565-0000-0000-0000-000000000003',
   'a5656565-0000-0000-0000-000000000001', 'b5656565-0000-0000-0000-000000000001',
   'Afterparty', 'party', 48.15, 17.11,
   now() + interval '21 days', now() + interval '21 days 4 hours',
   'Bratislava', 'Klub', false, 1500, 'EUR', 'published', 'public',
   array['Don Toliver']),
  -- Už skončený: do výsledkov nepatrí, lebo sa naň nedá kúpiť vstupenka.
  ('e5656565-0000-0000-0000-000000000004',
   'a5656565-0000-0000-0000-000000000001', 'b5656565-0000-0000-0000-000000000001',
   'Minuloročný koncert', 'concert', 48.15, 17.11,
   now() - interval '40 days', now() - interval '39 days',
   'Bratislava', 'O2 Arena', false, 4000, 'EUR', 'published', 'public',
   array['Don Toliver']);

-- ============================================================================
-- 1. Meno interpreta, ktoré v názve eventu nie je
-- ============================================================================
do $$
declare
  v_hit  record;
  v_seen integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5656565-0000-0000-0000-000000000002', true);

  select * into v_hit from public.search_all('don toliver', 8)
  where kind = 'artist';

  assert found, 'ÚNIK ZMYSLU: interpret sa nenašiel, hoci je medzi účinkujúcimi';
  assert v_hit.label = 'Don Toliver',
    format('meno sa vrátilo ako %s', v_hit.label);
  -- Dva nadchádzajúce, nie tri: ten minuloročný sa rátať nesmie.
  assert v_hit.event_count = 2,
    format('interpret má mať 2 nadchádzajúce eventy, má %s', v_hit.event_count);

  -- A malými písmenami aj s medzerou navyše to musí nájsť rovnako.
  select count(*) into v_seen from public.search_all('  DON TOLIVER  ', 8)
  where kind = 'artist';
  assert v_seen = 1, 'hľadanie je citlivé na veľkosť písmen alebo medzery';

  -- Kus mena uprostred. Toto je to, čo človek naozaj píše.
  select count(*) into v_seen from public.search_all('toliv', 8) where kind = 'artist';
  assert v_seen = 1, 'hľadanie nenájde meno podľa jeho časti';

  reset role;
  raise notice 'PASS hľadanie nájde interpreta, aj keď v názve eventu nie je';
end $$;

-- ============================================================================
-- 2. Diakritika hľadanie nezastaví
-- ============================================================================
-- Na slovenskej appke je toto polovica hľadaní: nikto nepíše mäkčene do
-- vyhľadávacieho poľa.
do $$
declare
  v_seen integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5656565-0000-0000-0000-000000000002', true);

  select count(*) into v_seen from public.search_all('kosice', 8) where kind = 'city';
  assert v_seen = 1, 'Košice sa nenašli, keď sa napísalo bez diakritiky';

  select count(*) into v_seen from public.search_all('dvorak', 8) where kind = 'artist';
  assert v_seen = 1, 'Dvořák sa nenašiel, keď sa napísalo bez diakritiky';

  -- A naopak: s diakritikou to musí nájsť tiež.
  select count(*) into v_seen from public.search_all('Košice', 8) where kind = 'city';
  assert v_seen = 1, 'Košice sa nenašli ani s diakritikou';

  reset role;
  raise notice 'PASS diakritika hľadanie nezastaví ani v jednom smere';
end $$;

-- ============================================================================
-- 3. Mesto, miesto a event naraz
-- ============================================================================
do $$
declare
  v_city  record;
  v_venue record;
  v_seen  integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5656565-0000-0000-0000-000000000002', true);

  select * into v_city from public.search_all('bratislava', 8) where kind = 'city';
  assert found, 'mesto sa nenašlo';
  assert v_city.event_count = 2,
    format('v Bratislave majú byť 2 nadchádzajúce eventy, je %s', v_city.event_count);
  assert v_city.latitude is not null, 'mesto sa vrátilo bez súradníc';

  select * into v_venue from public.search_all('o2 arena', 8) where kind = 'venue';
  assert found, 'miesto sa nenašlo';
  assert v_venue.sublabel = 'Bratislava',
    format('pri mieste má byť mesto, je %s', v_venue.sublabel);

  select count(*) into v_seen from public.search_all('koncert', 8) where kind = 'event';
  assert v_seen = 1,
    format('názov mal nájsť 1 nadchádzajúci event, našiel %s', v_seen);

  -- Nezmysel nesmie vrátiť nič, nie všetko.
  select count(*) into v_seen from public.search_all('xyzqwerty', 8);
  assert v_seen = 0, format('nezmyselný dotaz vrátil %s výsledkov', v_seen);

  -- Prázdny dotaz tiež nie — inak by sa pri vymazaní poľa vysypala celá
  -- databáza.
  select count(*) into v_seen from public.search_all('   ', 8);
  assert v_seen = 0, 'prázdny dotaz vrátil výsledky';

  reset role;
  raise notice 'PASS mesto, miesto aj event sa nájdu a nezmysel nevráti nič';
end $$;

-- ============================================================================
-- 4. Z výsledku sa dá prejsť na zoznam eventov
-- ============================================================================
do $$
declare
  v_seen integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5656565-0000-0000-0000-000000000002', true);

  select count(*) into v_seen from public.events_matching('artist', 'Don Toliver', 40);
  assert v_seen = 2,
    format('kliknutie na interpreta má dať 2 eventy, dalo %s', v_seen);

  select count(*) into v_seen from public.events_matching('city', 'bratislava', 40);
  assert v_seen = 2,
    format('kliknutie na mesto má dať 2 eventy, dalo %s', v_seen);

  select count(*) into v_seen from public.events_matching('venue', 'O2 Arena', 40);
  assert v_seen = 1,
    format('kliknutie na miesto má dať 1 event, dalo %s', v_seen);

  reset role;
  raise notice 'PASS z interpreta, mesta aj miesta sa dá prejsť na ich eventy';
end $$;

-- ============================================================================
-- 5. Horný riadok a zoznam pod ním nesmú protirečiť
-- ============================================================================
-- Toto bolo vidieť až na screenshote: hore „Don Toliver · 1 event", dole
-- „Nič také tu nie je." Obe tvrdenia boli vo svojom svete pravdivé —
-- `search_all` pozerá do účinkujúcich, `search_events` do názvu — ale pre
-- človeka je to jedno pole a jedna odpoveď.
do $$
declare
  v_hits   integer;
  v_events integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a5656565-0000-0000-0000-000000000002', true);

  select event_count into v_hits from public.search_all('toliver', 8) where kind = 'artist';
  select count(*) into v_events from public.search_events(p_query => 'toliver');

  assert v_hits = v_events,
    format('horný riadok hlási %s eventov, zoznam ukazuje %s', v_hits, v_events);
  assert v_events = 2, format('malo sa nájsť 2, našlo sa %s', v_events);

  -- A stále musí platiť aj to, čo tam bolo predtým: názov, mesto, miesto.
  select count(*) into v_events from public.search_events(p_query => 'festival');
  assert v_events = 1, 'hľadanie podľa názvu prestalo fungovať';

  select count(*) into v_events from public.search_events(p_query => 'Amfiteáter');
  assert v_events = 1, 'hľadanie podľa miesta prestalo fungovať';

  reset role;
  raise notice 'PASS zoznam eventov nájde to isté, čo horný riadok';
end $$;

rollback;
