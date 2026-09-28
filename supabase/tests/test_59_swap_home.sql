-- ============================================================================
-- Domovská stránka SWAPu ukazuje len to, na čo niekto naozaj ponúka
-- ============================================================================
-- Kategória, po kliknutí na ktorú je prázdno, je horšia než žiadna kategória:
-- je to sľub, ktorý sa nesplní, a druhýkrát naň už nikto neklikne.
--
-- Test sa pýta na tri veci: že sa kategória objaví len s ponukou, že počty pri
-- nej sedia, a že rozdelenie do škatuliek je SWAPove a nie BLUPove.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5959595-0000-0000-0000-000000000001', 'org59@example.com',  now(), '{"display_name":"Organizátor"}'),
  ('a5959595-0000-0000-0000-000000000002', 'sell59@example.com', now(), '{"display_name":"Predajca"}');

insert into public.organizations (id, name, slug, created_by, verification_status)
values ('b5959595-0000-0000-0000-000000000001', 'Klub s.r.o.', 'klub-59',
        'a5959595-0000-0000-0000-000000000001', 'verified');
insert into public.organization_members (organization_id, user_id, role)
values ('b5959595-0000-0000-0000-000000000001', 'a5959595-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- Tri eventy v troch rôznych škatuľkách SWAPu. Ponuka bude len na dva.
insert into public.events (
  id, creator_id, organization_id, title, category, latitude, longitude,
  start_at, end_at, city, venue_name, is_free, price_cents, currency,
  status, visibility
) values
  ('e5959595-0000-0000-0000-000000000001',
   'a5959595-0000-0000-0000-000000000001', 'b5959595-0000-0000-0000-000000000001',
   'Veľký koncert', 'concert', 48.15, 17.11,
   now() + interval '10 days', now() + interval '10 days 3 hours',
   'Bratislava', 'Aréna', false, 5000, 'EUR', 'published', 'public'),
  ('e5959595-0000-0000-0000-000000000002',
   'a5959595-0000-0000-0000-000000000001', 'b5959595-0000-0000-0000-000000000001',
   'Derby', 'football', 48.15, 17.11,
   now() + interval '3 days', now() + interval '3 days 2 hours',
   'Bratislava', 'Štadión', false, 3000, 'EUR', 'published', 'public'),
  -- Divadlo bez jedinej ponuky: v SWAPe sa objaviť NESMIE.
  ('e5959595-0000-0000-0000-000000000003',
   'a5959595-0000-0000-0000-000000000001', 'b5959595-0000-0000-0000-000000000001',
   'Hamlet', 'theatre', 48.15, 17.11,
   now() + interval '20 days', now() + interval '20 days 3 hours',
   'Bratislava', 'Divadlo', false, 2000, 'EUR', 'published', 'public');

-- ============================================================================
-- 1. Škatuľky sú SWAPove, nie BLUPove
-- ============================================================================
do $$
begin
  -- BLUP by koncert aj futbal zaradil podľa nálady: 'music' a 'outdoor'.
  -- SWAP sa pýta inak — na čo sa predáva vstupenka.
  assert public.swap_family('concert') = 'concert', 'koncert nie je v koncertoch';
  assert public.swap_family('techno')  = 'concert', 'techno party nie je v koncertoch';
  assert public.swap_family('football') = 'sport', 'futbal nie je v športe';
  assert public.swap_family('hockey')   = 'sport', 'hokej nie je v športe';
  assert public.swap_family('theatre')  = 'stage', 'divadlo nie je na javisku';
  assert public.swap_family('standup')  = 'stage', 'stand-up nie je na javisku';
  assert public.swap_family('festival') = 'festival', 'festival nie je festival';
  -- Čo sa nikam nehodí, skončí v ostatných — a nie v náhodnej škatuľke.
  assert public.swap_family('yoga') = 'other', 'joga sa votrela do kategórie';
  assert public.swap_family(null)   = 'other', 'event bez kategórie spadol inam';

  raise notice 'PASS škatuľky SWAPu sú o vstupenkách, nie o nálade';
end $$;

-- ============================================================================
-- 2. Kategória sa ukáže len s ponukou a počty sedia
-- ============================================================================
do $$
declare
  v_seller uuid := 'a5959595-0000-0000-0000-000000000002';
  v_home   jsonb;
  v_fams   jsonb;
  v_one    jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);

  -- Zatiaľ nikto nič neponúka.
  v_home := public.swap_home(8);
  assert (v_home->>'total_listings')::integer = 0,
    format('bez ponúk má byť 0, je %s', v_home->>'total_listings');
  assert jsonb_array_length(v_home->'families') = 0, 'bez ponúk sa ukazujú kategórie';
  assert jsonb_array_length(v_home->'soon') = 0, 'bez ponúk sa ukazujú eventy';

  -- Dve ponuky na koncert, jedna na futbal.
  perform public.create_resale_listing(
    'e5959595-0000-0000-0000-000000000001'::uuid, 'external', 4500, null,
    p_delivery_method => 'file', p_quantity => 2, p_external_provider => 'Test',
    p_ticket_file_path => 'sellers/' || v_seller || '/a.pdf');
  perform public.create_resale_listing(
    'e5959595-0000-0000-0000-000000000001'::uuid, 'external', 3800, null,
    p_delivery_method => 'file', p_external_provider => 'Test',
    p_ticket_file_path => 'sellers/' || v_seller || '/b.pdf');
  perform public.create_resale_listing(
    'e5959595-0000-0000-0000-000000000002'::uuid, 'external', 2500, null,
    p_delivery_method => 'file', p_external_provider => 'Test',
    p_ticket_file_path => 'sellers/' || v_seller || '/c.pdf');

  v_home := public.swap_home(8);
  v_fams := v_home->'families';

  assert (v_home->>'total_listings')::integer = 3,
    format('ponúk má byť 3, je %s', v_home->>'total_listings');
  -- Dva kusy + jeden + jeden = štyri vstupenky.
  assert (v_home->>'total_tickets')::integer = 4,
    format('vstupeniek má byť 4, je %s', v_home->>'total_tickets');
  assert (v_home->>'from_cents')::integer = 2500,
    format('najnižšia cena má byť 2500, je %s', v_home->>'from_cents');

  -- Dve kategórie, nie tri: divadlo nemá ponuku.
  assert jsonb_array_length(v_fams) = 2,
    format('kategórie majú byť 2, je ich %s', jsonb_array_length(v_fams));

  select value into v_one from jsonb_array_elements(v_fams) value
  where value->>'key' = 'concert';
  assert found, 'koncerty sa neukázali';
  assert (v_one->>'listing_count')::integer = 2,
    format('koncerty majú mať 2 ponuky, majú %s', v_one->>'listing_count');
  assert (v_one->>'ticket_count')::integer = 3,
    format('koncerty majú mať 3 vstupenky, majú %s', v_one->>'ticket_count');
  assert (v_one->>'from_cents')::integer = 3800,
    format('koncerty majú byť od 3800, sú od %s', v_one->>'from_cents');

  assert not exists (
    select 1 from jsonb_array_elements(v_fams) value where value->>'key' = 'stage'
  ), 'PRÁZDNY SĽUB: ukazuje sa kategória, v ktorej nikto nič neponúka';

  reset role;
  raise notice 'PASS kategória sa ukáže len s ponukou a počty sedia';
end $$;

-- ============================================================================
-- 3. „Čoskoro" je naozaj podľa dátumu a kliknutie vedie na ponuky
-- ============================================================================
do $$
declare
  v_seller uuid := 'a5959595-0000-0000-0000-000000000002';
  v_home   jsonb;
  v_first  jsonb;
  v_seen   integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_seller::text, true);

  v_home := public.swap_home(8);
  v_first := (v_home->'soon')->0;

  -- Derby je o tri dni, koncert o desať.
  assert v_first->>'event_id' = 'e5959595-0000-0000-0000-000000000002',
    format('prvý v „Čoskoro" má byť Derby, je %s', v_first->>'title');

  -- „Najviac na výber" radí inak: tam vedie koncert s dvoma ponukami.
  assert ((v_home->'most')->0)->>'event_id' = 'e5959595-0000-0000-0000-000000000001',
    'v „Najviac na výber" nevedie event s najviac ponukami';

  -- A kliknutie na kategóriu naozaj niekam vedie.
  select count(*) into v_seen from public.swap_events_in_family('concert', 40);
  assert v_seen = 1, format('koncerty majú dať 1 event, dali %s', v_seen);

  select count(*) into v_seen from public.swap_events_in_family('stage', 40);
  assert v_seen = 0, 'prázdna kategória predsa niečo vrátila';

  reset role;
  raise notice 'PASS „Čoskoro" radí podľa dátumu, „Najviac" podľa ponúk';
end $$;


-- ============================================================================
-- 4. Jeden zoznam ponuky — filtre nemenia čísla na kartách
-- ============================================================================
-- Domovská SWAPu je postavená ako domovská BLUPu: pás filtrov a pod ním jeden
-- zoznam. Filter „len overené" je tu tá zákerná časť — keby sa uplatnil pred
-- zoskupením, event by na karte tvrdil menej vstupeniek, než na ňom naozaj je,
-- a človek by prišiel do ponuky, ktorá vyzerá inak než jej vlastný náhľad.
do $$
declare
  v_all      integer;
  v_filtered integer;
  v_tickets_all integer;
  v_tickets_ver integer;
  v_event    uuid;
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into v_all from public.swap_events(null, false, 100);
  assert v_all >= 1, 'zoznam ponuky je prázdny, hoci ponuky sú';

  -- 'all' z URL znamená to isté, čo prázdny filter.
  select count(*) into v_filtered from public.swap_events('all', false, 100);
  assert v_filtered = v_all, format('„all" má znamenať to isté čo nič: %s vs %s', v_filtered, v_all);

  -- Kategória zúži, ale nevymyslí.
  select count(*) into v_filtered from public.swap_events('concert', false, 100);
  assert v_filtered <= v_all, 'kategória vrátila viac než všetko';

  -- A teraz to podstatné: počty na karte sú počty CELÉHO eventu, aj keď sa
  -- filtruje na overené.
  select event_id, ticket_count into v_event, v_tickets_all
    from public.swap_events(null, false, 100)
   where verified_count > 0 and ticket_count > verified_count
   limit 1;

  if v_event is not null then
    select ticket_count into v_tickets_ver
      from public.swap_events(null, true, 100) where event_id = v_event;
    assert v_tickets_ver = v_tickets_all,
      format('filter zmenil počet vstupeniek na karte: %s vs %s', v_tickets_ver, v_tickets_all);
  end if;

  reset role;
  raise notice 'PASS zoznam ponuky sa filtruje a počty na kartách zostávajú pravdivé';
end $$;

rollback;
