-- ============================================================================
-- SWAP — čitateľné adresy
-- ============================================================================
-- Odkaz na burzu vyzeral takto:
--
--   https://blup.sk/swap/863b30b0-f37e-4acc-8e6f-d856a0b1c0b6
--
-- Nedá sa prečítať ani nadiktovať. Eventy majú `slug` od začiatku, len ho SWAP
-- nikdy nedostal do ruky.
--
-- Tri veci, ktoré sa tu overujú, lebo každá sa dá pokaziť ticho:
--
--   1. karty a hľadanie slug naozaj vracajú — bez toho appka nemá z čoho
--      postaviť lepšiu adresu a ticho zostane pri uuid,
--   2. stará adresa s uuid funguje ďalej — odkaz v cudzom chate nesmie umrieť
--      preto, že sme si vylepšili adresy,
--   3. spolu so slugom sa nestratili počty ani zoradenie. Pri prepisoch
--      `search_events` sa už raz stalo, že sa s novým stĺpcom vrátila stará
--      podmienka, a odhalil to až cudzí test.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a6565656-0000-0000-0000-000000000001', 'org65@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a6565656-0000-0000-0000-000000000002', 'sell65@example.com', now(), '{"display_name":"Predajca"}');

insert into public.events (
  id, creator_id, title, category, latitude, longitude,
  start_at, end_at, is_free, price_cents, currency, status, visibility,
  city, venue_name, performers
) values
  ('e6565656-0000-0000-0000-000000000001',
   'a6565656-0000-0000-0000-000000000001',
   'Hypeland', 'festival', 48.15, 17.11,
   now() + interval '10 days', now() + interval '10 days 8 hours',
   true, 0, 'EUR', 'published', 'public',
   'Bratislava', 'Zimný štadión', array['Hypeland Crew']),
  ('e6565656-0000-0000-0000-000000000002',
   'a6565656-0000-0000-0000-000000000001',
   'Nočná jazda', 'concert', 48.15, 17.11,
   now() + interval '20 days', now() + interval '20 days 4 hours',
   true, 0, 'EUR', 'published', 'public',
   'Košice', 'Kunsthalle', array[]::text[]);

-- ============================================================================
-- 1. Slug sa dostane všade, kde appka berie eventy pre SWAP
-- ============================================================================
do $$
declare
  v_hype   uuid := 'e6565656-0000-0000-0000-000000000001';
  v_noc    uuid := 'e6565656-0000-0000-0000-000000000002';
  v_seller uuid := 'a6565656-0000-0000-0000-000000000002';
  v_slug   text;
  v_row    record;
  v_home   jsonb;
  v_hit    jsonb;
begin
  -- Slug si event vyrobí sám pri vzniku.
  select slug into v_slug from public.events where id = v_hype;
  assert v_slug = 'hypeland', format('slug má byť hypeland, je %s', v_slug);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);
  perform public.create_resale_listing(v_hype, 'external', 3000, null,
    p_delivery_method => 'file', p_ticket_label => 'Státie',
    p_ticket_file_path => 'sellers/' || v_seller || '/hype.pdf');
  perform public.create_resale_listing(v_noc, 'external', 2000, null,
    p_delivery_method => 'file', p_ticket_label => 'Sedenie',
    p_ticket_file_path => 'sellers/' || v_seller || '/noc.pdf');

  -- Mriežka SWAPu.
  select * into v_row from public.swap_events(null, false, 50) where event_id = v_hype;
  assert v_row.event_slug = 'hypeland',
    format('karta SWAPu nevrátila slug, vrátila %s', coalesce(v_row.event_slug, 'NULL'));
  assert v_row.listing_count = 1, 'so slugom sa pokazil počet ponúk';

  -- Stránka kategórie.
  select * into v_row from public.swap_events_in_family('festival', 50)
  where event_id = v_hype;
  assert v_row.event_slug = 'hypeland', 'stránka kategórie nevrátila slug';

  -- Eventy za výsledkom hľadania.
  select * into v_row from public.swap_events_for('city', 'Bratislava', 50)
  where event_id = v_hype;
  assert v_row.event_slug = 'hypeland', 'eventy mesta nevrátili slug';

  -- Domovská stránka.
  v_home := public.swap_home(8);
  select value into v_hit
  from jsonb_array_elements(v_home->'soon')
  where value->>'event_id' = v_hype::text;
  assert v_hit->>'event_slug' = 'hypeland',
    format('domovská nevrátila slug, vrátila %s', coalesce(v_hit->>'event_slug', 'NULL'));

  -- Hľadanie: `key` je to, čo ide do adresy.
  select to_jsonb(s) into v_hit
  from public.swap_search('hypeland', 30) s
  where s.kind = 'event' and s.event_id = v_hype;
  assert v_hit->>'key' = 'hypeland',
    format('hľadanie dáva do adresy %s namiesto slugu', coalesce(v_hit->>'key', 'NULL'));
  -- Uuid sa z výsledku nestratilo: appka ním pýta ponuky.
  assert v_hit->>'event_id' = v_hype::text, 'hľadanie prestalo vracať uuid';

  reset role;
  raise notice 'PASS 1/3 — slug je na karte, v kategórii, na domovskej aj v hľadaní';
end $$;

-- ============================================================================
-- 2. Stará adresa s uuid funguje ďalej
-- ============================================================================
-- Toto je celý dôvod, prečo sa uuid nikde neodstránilo. Odkaz, ktorý si
-- niekto pred mesiacom hodil do chatu, nesmie prestať fungovať preto, že sa
-- adresy stali čitateľnými.
do $$
declare
  v_hype uuid := 'e6565656-0000-0000-0000-000000000001';
  v_bad  integer;
  v_ok   integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'a6565656-0000-0000-0000-000000000002', true);

  select count(*) into v_ok from public.swap_events_for('event', v_hype::text, 50);
  assert v_ok = 1, format('cez uuid sa event nenašiel (%s)', v_ok);

  select count(*) into v_ok from public.swap_events_for('event', 'hypeland', 50);
  assert v_ok = 1, format('cez slug sa event nenašiel (%s)', v_ok);

  -- A nezmysel nevráti nič. Bez tejto kontroly by „nájde oboje" mohlo
  -- znamenať „nájde všetko".
  select count(*) into v_bad from public.swap_events_for('event', 'toto-neexistuje', 50);
  assert v_bad = 0, format('neexistujúca adresa vrátila %s eventov', v_bad);

  reset role;
  raise notice 'PASS 2/3 — uuid aj slug vedú na ten istý event, nezmysel nikam';
end $$;

-- ============================================================================
-- 3. Zoradenie a počty sa so slugom nepokazili
-- ============================================================================
do $$
declare
  v_seller uuid := 'a6565656-0000-0000-0000-000000000002';
  v_hype   uuid := 'e6565656-0000-0000-0000-000000000001';
  v_first  uuid;
  v_count  integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);

  -- Ešte dve ponuky na Hypeland, nech má najviac na výber.
  perform public.create_resale_listing(v_hype, 'external', 3500, null,
    p_delivery_method => 'file',
    p_ticket_file_path => 'sellers/' || v_seller || '/hype2.pdf');
  perform public.create_resale_listing(v_hype, 'external', 2800, null,
    p_delivery_method => 'file',
    p_ticket_file_path => 'sellers/' || v_seller || '/hype3.pdf');

  -- `swap_events` radí podľa dátumu — Hypeland je skôr.
  select event_id into v_first from public.swap_events(null, false, 50) limit 1;
  assert v_first = v_hype, 'mriežka prestala radiť podľa dátumu';

  select listing_count into v_count from public.swap_events(null, false, 50)
  where event_id = v_hype;
  assert v_count = 3, format('počet ponúk má byť 3, je %s', v_count);

  -- Filter „len overené" musí filtrovať AŽ PO zoskupení, inak by sa počty na
  -- kartách zmenili na „koľko z nich je overených".
  select count(*) into v_count from public.swap_events(null, true, 50);
  assert v_count = 0, 'bez jedinej overenej ponuky sa niečo ukázalo';

  reset role;
  raise notice 'PASS 3/3 — počty aj zoradenie zostali, filter overených filtruje';
end $$;

rollback;
