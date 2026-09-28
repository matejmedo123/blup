-- ============================================================================
-- Dáta na POZERANIE obrazoviek — jeden admin, jedna hala, jeden event
-- ============================================================================
-- Nie je to demo seed (ten je v seed.mjs a robí desiatky eventov). Toto je
-- najmenšie množstvo dát, pri ktorom sa dá otvoriť editor plánu a Premium a
-- vidieť, ako naozaj vyzerajú.
-- ============================================================================
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'admin@blup.demo', now(),
   '{"display_name":"Admin Adminovič","username":"admin"}')
on conflict (id) do nothing;

-- onboarding_completed, inak appka presmeruje na „Kto si?" a nič iné sa
-- nezobrazí — čo je správne správanie a pre náhľad prekážka.
update public.profiles
set app_role = 'admin', display_name = 'Admin Adminovič', username = 'admin',
    city = 'Nitra', latitude = 48.3069, longitude = 18.0864,
    onboarding_completed = true
where id = '11111111-1111-1111-1111-111111111111';

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values ('22222222-2222-2222-2222-222222222222', 'Aréna Nitra', 'arena-nitra',
        '11111111-1111-1111-1111-111111111111', 'verified', true)
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'owner')
on conflict do nothing;

insert into public.events (id, creator_id, organization_id, title, description, category,
                           start_at, end_at, latitude, longitude, city, venue_name,
                           is_free, price_cents, status, visibility)
values ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222', 'Derby — Nitra vs. Trnava',
        'Jarná časť, 24. kolo.', 'football',
        now() + interval '21 days', now() + interval '21 days 2 hours',
        48.3069, 18.0864, 'Nitra', 'Mestský štadión',
        false, 2200, 'published', 'public')
on conflict (id) do nothing;

insert into public.ticket_types (id, event_id, name, price_cents, quantity_total)
values
  ('44444444-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333',
   'Tribúna A', 2200, 400),
  ('44444444-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333',
   'Tribúna VIP', 4500, 200),
  ('44444444-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333',
   'Státie sever', 1200, 800)
on conflict (id) do nothing;

insert into public.venue_maps (id, organization_id, name, image_width, image_height, created_by)
values ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222',
        'Mestský štadión', 1600, 1200, '11111111-1111-1111-1111-111111111111')
on conflict (id) do nothing;

-- Priradenie plánu k eventu stráži trigger, ktorý pustí len admina.
do $$
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  update public.events set venue_map_id = '55555555-5555-5555-5555-555555555555'
  where id = '33333333-3333-3333-3333-333333333333';
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Štyri sektory, jeden z nich natočený — presne ten prípad, kvôli ktorému
-- otáčanie vzniklo.
insert into public.venue_sections (id, venue_map_id, ticket_type_id, name, colour,
                                   x, y, width, height, rotation, kind, sort_order)
values
  ('66666666-0000-0000-0000-000000000001', '55555555-5555-5555-5555-555555555555',
   '44444444-0000-0000-0000-000000000001', 'Tribúna A', '#FF4D8D',
   0.06, 0.18, 0.22, 0.52, 0, 'standard', 1),
  ('66666666-0000-0000-0000-000000000002', '55555555-5555-5555-5555-555555555555',
   '44444444-0000-0000-0000-000000000002', 'Tribúna VIP', '#0080FF',
   0.72, 0.18, 0.22, 0.52, 0, 'vip', 2),
  ('66666666-0000-0000-0000-000000000003', '55555555-5555-5555-5555-555555555555',
   '44444444-0000-0000-0000-000000000003', 'Státie sever', '#22C55E',
   0.30, 0.04, 0.40, 0.14, -12, 'standing', 3),
  ('66666666-0000-0000-0000-000000000004', '55555555-5555-5555-5555-555555555555',
   null, 'Hracia plocha', '#A855F7',
   0.30, 0.24, 0.40, 0.42, 0, 'stage', 4)
on conflict (id) do nothing;

do $$
begin
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform public.generate_section_seats('66666666-0000-0000-0000-000000000001', 10, 20);
  perform public.generate_section_seats(
    '66666666-0000-0000-0000-000000000002', 8, 12,
    p_row_style => 'numbers', p_row_prefix => 'V', p_seat_start => 101);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ============================================================================
-- Ľudia okolo admina — aby sa dali pozrieť správy, príbehy a feed
-- ============================================================================
-- Sám so sebou si nenapíšeš, nikoho nesleduješ a feed je prázdny, takže tri
-- obrazovky z desiatich sa dali otvoriť len prázdne. Toto je najmenšie
-- množstvo ľudí, pri ktorom je na nich čo vidieť.
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('77777777-0000-0000-0000-000000000001', 'eva@blup.demo', now(),
   '{"display_name":"Eva Horváthová","username":"eva"}'),
  ('77777777-0000-0000-0000-000000000002', 'miro@blup.demo', now(),
   '{"display_name":"Miro Baláž","username":"miro"}')
on conflict (id) do nothing;

update public.profiles
set display_name = 'Eva Horváthová', username = 'eva', city = 'Nitra',
    onboarding_completed = true
where id = '77777777-0000-0000-0000-000000000001';

update public.profiles
set display_name = 'Miro Baláž', username = 'miro', city = 'Nitra',
    onboarding_completed = true
where id = '77777777-0000-0000-0000-000000000002';

-- Admin sleduje oboch. Bez toho je ring nad feedom aj riadok s kruhmi prázdny
-- — správne, ale nedá sa na tom nič overiť.
insert into public.follows (follower_id, following_id) values
  ('11111111-1111-1111-1111-111111111111', '77777777-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111', '77777777-0000-0000-0000-000000000002'),
  ('77777777-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111')
on conflict do nothing;

-- Event, ktorý je naozaj dnes — inak sa „Tvoje kruhy dnes" nedá vidieť, lebo
-- teraz už hlási len to, čo je pravda.
insert into public.events (id, creator_id, title, description, category,
                           start_at, end_at, latitude, longitude, city, venue_name,
                           is_free, status, visibility)
values ('33333333-0000-0000-0000-0000000d0e51',
        '77777777-0000-0000-0000-000000000001',
        'Večer v Hidepark', 'Koncert na dvore, vstup zdarma.', 'music',
        date_trunc('day', now()) + interval '20 hours',
        date_trunc('day', now()) + interval '23 hours',
        48.3069, 18.0864, 'Nitra', 'Hidepark',
        true, 'published', 'public')
on conflict (id) do nothing;

insert into public.event_attendees (event_id, user_id, status) values
  ('33333333-0000-0000-0000-0000000d0e51', '77777777-0000-0000-0000-000000000001', 'going'),
  ('33333333-0000-0000-0000-0000000d0e51', '77777777-0000-0000-0000-000000000002', 'going')
on conflict do nothing;

-- Jeden príbeh, jeden chat a jeden príspevok, aby na každej z tých obrazoviek
-- bolo vidieť riadok naozajstných dát namiesto prázdneho stavu.
do $$
declare
  v_admin uuid := '11111111-1111-1111-1111-111111111111';
  v_eva   uuid := '77777777-0000-0000-0000-000000000001';
  v_conv  uuid;
begin
  perform set_config('request.jwt.claim.sub', v_eva::text, true);

  perform public.create_story(
    'https://tchvgzbxddqdneylkqvi.supabase.co/storage/v1/object/public/stories/demo/vecer.jpg',
    'Dnes o ôsmej v Hideparku 🎸',
    '33333333-0000-0000-0000-0000000d0e51',
    null
  );

  v_conv := public.start_direct_conversation(v_admin);
  perform public.send_message(v_conv, 'Ideš dnes na ten koncert?', null, null);

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform public.send_message(v_conv, 'Jasné, vidíme sa tam.', null, null);

  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Pár vstupeniek, aby bolo na čo pozerať pri dverách: dve odbavené, tri čakajú
-- a jedna vrátená — presne tá zmes, v ktorej je vidieť, že vrátená sa medzi
-- čakajúcich neráta.
insert into public.tickets (event_id, buyer_id, code, qr_secret, status, price_cents, checked_in_at)
values
  ('33333333-3333-3333-3333-333333333333', '77777777-0000-0000-0000-000000000001',
   'PRV-0001', 'preview-1', 'used',     1900, now() - interval '20 minutes'),
  ('33333333-3333-3333-3333-333333333333', '77777777-0000-0000-0000-000000000002',
   'PRV-0002', 'preview-2', 'used',     1900, now() - interval '12 minutes'),
  ('33333333-3333-3333-3333-333333333333', '77777777-0000-0000-0000-000000000001',
   'PRV-0003', 'preview-3', 'valid',    1900, null),
  ('33333333-3333-3333-3333-333333333333', '77777777-0000-0000-0000-000000000002',
   'PRV-0004', 'preview-4', 'valid',    1900, null),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'PRV-0005', 'preview-5', 'valid',    1900, null),
  ('33333333-3333-3333-3333-333333333333', '77777777-0000-0000-0000-000000000001',
   'PRV-0006', 'preview-6', 'refunded', 1900, null)
on conflict (code) do nothing;

-- Burza: štyri ponuky na ten istý event, aby bolo vidieť rozdiel medzi
-- overenou BLUP vstupenkou a vstupenkou odinakiaľ. Bez oboch druhov naraz sa
-- na obrazovke nedá posúdiť, či sú od seba odlíšené dosť zreteľne.
do $$
declare
  v_eva   uuid := '77777777-0000-0000-0000-000000000001';
  v_miro  uuid := '77777777-0000-0000-0000-000000000002';
  v_event uuid := '33333333-3333-3333-3333-333333333333';
  v_t1    uuid;
  v_t2    uuid;
begin
  select id into v_t1 from public.tickets
  where code = 'PRV-0003' and buyer_id = v_eva;
  select id into v_t2 from public.tickets
  where code = 'PRV-0004' and buyer_id = v_miro;

  set local role authenticated;

  -- Dve naše, prevediteľné.
  perform set_config('request.jwt.claim.sub', v_eva::text, true);
  perform public.create_resale_listing(
    v_event, 'blup', 1900, v_t1,
    p_section => 'A', p_row_label => '4', p_seat_label => '12',
    p_note => 'Nemôžem ísť, mám službu. Prevod hneď po zaplatení.'
  );

  perform set_config('request.jwt.claim.sub', v_miro::text, true);
  perform public.create_resale_listing(
    v_event, 'blup', 1700, v_t2,
    p_section => 'B', p_row_label => '11', p_seat_label => '3'
  );

  -- A dve odinakiaľ, ktorých pravosť overiť nevieme.
  perform public.create_resale_listing(
    v_event, 'external', 2200, null,
    p_quantity => 2,
    p_delivery_method => 'file',
    p_section => 'C', p_row_label => '2',
    p_external_provider => 'Ticketportal',
    p_face_value_cents => 2500,
    p_ticket_file_path => 'sellers/' || v_miro || '/prv-c2.pdf',
    p_note => 'Dve vedľa seba, PDF dostaneš hneď po platbe.'
  );

  perform set_config('request.jwt.claim.sub', v_eva::text, true);
  perform public.create_resale_listing(
    v_event, 'external', 2000, null,
    p_delivery_method => 'mobile_transfer',
    p_ticket_label => 'Státie',
    p_external_provider => 'Predpredaj.sk'
  );

  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Účinkujúci, aby hľadanie v SWAPe malo čo nájsť podľa mena.
update public.events set performers = array['Don Toliver', 'Travis Scott']
where id = '33333333-3333-3333-3333-333333333333';
update public.events set performers = array['Hidepark Live']
where id = '33333333-0000-0000-0000-0000000d0e51';

-- Prihlásený človek v náhľade je admin. Nech má aj on čo predávať a čo
-- predané — inak je obrazovka „Predávam" prázdna a nedá sa na nej nič
-- posúdiť.
do $$
declare
  v_me    uuid := '11111111-1111-1111-1111-111111111111';
  v_buyer uuid := '77777777-0000-0000-0000-000000000002';
  v_event uuid := '33333333-3333-3333-3333-333333333333';
  v_t     uuid;
  v_l     public.resale_listings;
  v_res   public.resale_reservations;
  v_ord   public.resale_orders;
begin
  select id into v_t from public.tickets where code = 'PRV-0005' and buyer_id = v_me;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_me::text, true);
  v_l := public.create_resale_listing(
    v_event, 'blup', 1900, v_t,
    p_section => 'A', p_row_label => '7', p_seat_label => '22'
  );

  -- A jedna už predaná, aby bolo vidieť aj peniaze a stav po predaji.
  v_l := public.create_resale_listing(
    v_event, 'external', 2400, null,
    p_delivery_method => 'file',
    p_ticket_label => 'Tribúna Sever',
    p_external_provider => 'Ticketportal',
    p_ticket_file_path => 'sellers/' || v_me || '/prv-sever.pdf'
  );

  perform set_config('request.jwt.claim.sub', v_buyer::text, true);
  v_res := public.reserve_resale_listing(v_l.id, 1);
  v_ord := public.create_resale_order(v_res.id);

  reset role;
  perform public.mark_resale_order_paid(v_ord.id, 'pi_preview_1');
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- Trh na jednom evente, aby mala rada k cene z čoho vychádzať.
--
-- Bez cudzích ponúk by obrazovka „Za koľko" ukázala len „o tomto evente
-- zatiaľ nič nevieme" a nedalo by sa posúdiť, či rada vôbec funguje.
do $$
declare
  v_event uuid := '33333333-3333-3333-3333-333333333333';
  v_eva   uuid := '77777777-0000-0000-0000-000000000001';
  v_miro  uuid := '77777777-0000-0000-0000-000000000002';
  v_l     public.resale_listings;
begin
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', v_eva::text, true);
  perform public.create_resale_listing(
    v_event, 'external', 1600, null,
    p_delivery_method => 'file', p_ticket_label => 'Státie',
    p_external_provider => 'Predpredaj.sk',
    p_ticket_file_path => 'sellers/' || v_eva || '/trh-statie.pdf');
  perform public.create_resale_listing(
    v_event, 'external', 2600, null,
    p_delivery_method => 'file', p_ticket_label => 'Tribúna Juh',
    p_external_provider => 'Ticketportal',
    p_ticket_file_path => 'sellers/' || v_eva || '/trh-juh.pdf');

  perform set_config('request.jwt.claim.sub', v_miro::text, true);
  perform public.create_resale_listing(
    v_event, 'external', 3400, null,
    p_delivery_method => 'file', p_ticket_label => 'VIP',
    p_external_provider => 'Ticketmaster',
    p_ticket_file_path => 'sellers/' || v_miro || '/trh-vip.pdf');
  v_l := public.create_resale_listing(
    v_event, 'external', 2200, null,
    p_delivery_method => 'file', p_ticket_label => 'Státie',
    p_external_provider => 'Predpredaj.sk',
    p_ticket_file_path => 'sellers/' || v_miro || '/trh-statie2.pdf');

  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Tri dokončené predaje. Menej než tri server zámerne neukáže, aby sa
  -- z mediánu nedala dopočítať suma jedného človeka.
  insert into public.resale_orders (
    listing_id, event_id, buyer_id, seller_id, source, quantity,
    ticket_price_cents, total_cents, seller_fee_cents, seller_net_cents,
    currency, payment_status, order_status, paid_at, completed_at
  ) values
    (v_l.id, v_event, v_eva, v_miro, 'external', 1, 2100, 2100, 210, 1890,
     'EUR', 'succeeded', 'completed', now() - interval '9 days', now() - interval '9 days'),
    (v_l.id, v_event, v_eva, v_miro, 'external', 1, 2500, 2500, 250, 2250,
     'EUR', 'succeeded', 'completed', now() - interval '5 days', now() - interval '5 days'),
    (v_l.id, v_event, v_eva, v_miro, 'external', 1, 2900, 2900, 290, 2610,
     'EUR', 'succeeded', 'completed', now() - interval '2 days', now() - interval '2 days');
end $$;

-- Zopár ďalších eventov s ponukou, nech má domovská SWAPu čo ukázať v mriežke
-- a nech sa dá posúdiť, či filtre naozaj filtrujú.
do $$
declare
  v_org   uuid := '22222222-2222-2222-2222-222222222222';
  v_me    uuid := '11111111-1111-1111-1111-111111111111';
  v_eva   uuid := '77777777-0000-0000-0000-000000000001';
  v_miro  uuid := '77777777-0000-0000-0000-000000000002';
  v_ev    uuid;
  r       record;
begin
  for r in
    select * from (values
      ('33333333-0000-0000-0000-00000000c001'::uuid, 'Nočná scéna — Elektro',  'concert',  9,  'Bratislava', 'Nová Cvernovka'),
      ('33333333-0000-0000-0000-00000000c002'::uuid, 'Letný festival pri rieke','festival', 34, 'Piešťany',   'Lodenica'),
      ('33333333-0000-0000-0000-00000000c003'::uuid, 'Stand-up: dlhý večer',    'comedy',   5,  'Košice',     'Kunsthalle'),
      ('33333333-0000-0000-0000-00000000c004'::uuid, 'Hokej — semifinále',      'hockey',   16, 'Nitra',      'Zimný štadión')
    ) as t(id, title, category, days, city, venue)
  loop
    insert into public.events (
      id, creator_id, organization_id, title, category, city, venue_name,
      latitude, longitude, start_at, end_at, is_free, price_cents, currency,
      status, visibility
    ) values (
      r.id, v_me, v_org, r.title, r.category, r.city, r.venue,
      48.15, 17.11,
      now() + (r.days || ' days')::interval,
      now() + (r.days || ' days')::interval + interval '3 hours',
      false, 3000, 'EUR', 'published', 'public'
    ) on conflict (id) do nothing;

    v_ev := r.id;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', v_eva::text, true);
    perform public.create_resale_listing(v_ev, 'external', 1800 + r.days * 40, null,
      p_delivery_method => 'file', p_ticket_label => 'Státie',
      p_external_provider => 'Predpredaj.sk',
      p_ticket_file_path => 'sellers/' || v_eva || '/' || v_ev || '-statie.pdf');
    perform set_config('request.jwt.claim.sub', v_miro::text, true);
    perform public.create_resale_listing(v_ev, 'external', 2600 + r.days * 40, null,
      p_delivery_method => 'file', p_ticket_label => 'Sedenie',
      p_external_provider => 'Ticketportal',
      p_ticket_file_path => 'sellers/' || v_miro || '/' || v_ev || '-sedenie.pdf');
    reset role;
    perform set_config('request.jwt.claim.sub', '', true);
  end loop;
end $$;

-- Titulné fotky pre náhľad.
--
-- Sú to generované SVG v dátovom URI, nie fotky zo súborov: náhľadový backend
-- nie je Supabase Storage a nemal by ich odkiaľ servírovať. Dva eventy ich
-- schválne NEMAJÚ — na nich je vidieť, ako vyzerá karta s chýbajúcou fotkou
-- (gradient podľa kategórie), a to je presne ten stav, kvôli ktorému sa karta
-- SWAPu prepísala na `GradientCover`.

update public.events set cover_image_url = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMEE4NEZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjN0IyQkY1Ii8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxyZWN0IHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIGZpbGw9InVybCgjZykiLz4KPGcgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjE0KSI+CjxjaXJjbGUgY3g9IjM4MCIgY3k9IjMwMCIgcj0iMjYwIi8+PGNpcmNsZSBjeD0iMTU2MCIgY3k9IjgyMCIgcj0iMzIwIi8+PC9nPgo8dGV4dCB4PSI5NiIgeT0iOTgwIiBmb250LWZhbWlseT0iSGVsdmV0aWNhLEFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iODIiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiNGRkZGRkYiPkRFUkJZPC90ZXh0Pgo8L3N2Zz4='
 where id = '33333333-3333-3333-3333-333333333333';
update public.events set cover_image_url = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPgo8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjRkY0RDhEIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjRkY4QTNEIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+CjxyZWN0IHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIGZpbGw9InVybCgjZykiLz4KPGcgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjE0KSI+CjxjaXJjbGUgY3g9IjM4MCIgY3k9IjMwMCIgcj0iMjYwIi8+PGNpcmNsZSBjeD0iMTU2MCIgY3k9IjgyMCIgcj0iMzIwIi8+PC9nPgo8dGV4dCB4PSI5NiIgeT0iOTgwIiBmb250LWZhbWlseT0iSGVsdmV0aWNhLEFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iODIiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiNGRkZGRkYiPkZFU1RJVkFMPC90ZXh0Pgo8L3N2Zz4='
 where id = '33333333-0000-0000-0000-00000000c002';
-- Plagát na výšku vycentrovaný na plátne 1920 × 1080 — presne to, čo z
-- orezávania vyjde, keď si organizátor plagát oddiali, aby bol celý.
update public.events set cover_image_url = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPgo8cmVjdCB3aWR0aD0iMTkyMCIgaGVpZ2h0PSIxMDgwIiBmaWxsPSIjRjJGMkVFIi8+CjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDcwMCwwKSI+CjxyZWN0IHdpZHRoPSI1MjAiIGhlaWdodD0iMTA4MCIgZmlsbD0iI0ZGRkZGRiIvPgo8cmVjdCB4PSI0MCIgeT0iNzAiIHdpZHRoPSI0NDAiIGhlaWdodD0iNzAiIGZpbGw9IiNFMTFEMkUiLz4KPHRleHQgeD0iMjYwIiB5PSIxMjIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EsQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzNCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iI0ZGRkZGRiI+UE9TTEVETsOBIFNIT1cgVE9IVE8gUk9LQTwvdGV4dD4KPHRleHQgeD0iMjYwIiB5PSIyNjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EsQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSI3NCIgZm9udC13ZWlnaHQ9IjgwMCIgZmlsbD0iIzExMTExMSI+Tk/EjE7DgTwvdGV4dD4KPHRleHQgeD0iMjYwIiB5PSIzNDUiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EsQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSI3NCIgZm9udC13ZWlnaHQ9IjgwMCIgZmlsbD0iIzExMTExMSI+U0PDiU5BPC90ZXh0Pgo8dGV4dCB4PSIyNjAiIHk9IjQ3MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkhlbHZldGljYSxBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjQ2IiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjMTExMTExIj5FTEVLVFJPIMK3IDAwMTwvdGV4dD4KPHJlY3QgeD0iNDAiIHk9IjU0MCIgd2lkdGg9IjQ0MCIgaGVpZ2h0PSI2IiBmaWxsPSIjMTExMTExIi8+Cjx0ZXh0IHg9IjI2MCIgeT0iNjQwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iSGVsdmV0aWNhLEFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iNDAiIGZvbnQtd2VpZ2h0PSI3MDAiIGZpbGw9IiMxMTExMTEiPjYuIE9LVMOTQkVSIDIwMjY8L3RleHQ+Cjx0ZXh0IHg9IjI2MCIgeT0iNzAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iSGVsdmV0aWNhLEFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMzQiIGZpbGw9IiM0NDQ0NDQiPk5PVsOBIENWRVJOT1ZLQSwgQkE8L3RleHQ+CjxjaXJjbGUgY3g9IjI2MCIgY3k9Ijg4MCIgcj0iMTEwIiBmaWxsPSJub25lIiBzdHJva2U9IiMxMTExMTEiIHN0cm9rZS13aWR0aD0iOCIvPgo8dGV4dCB4PSIyNjAiIHk9IjkwMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkhlbHZldGljYSxBcmlhbCxzYW5zLXNlcmlmIiBmb250LXNpemU9IjQ0IiBmb250LXdlaWdodD0iODAwIiBmaWxsPSIjMTExMTExIj4yMjowMDwvdGV4dD4KPC9nPjwvc3ZnPg=='
 where id = '33333333-0000-0000-0000-00000000c001';

-- Viac sektorov na jednom evente, aby sa dalo posúdiť hľadanie miesta.
do $$
declare
  v_event uuid := '33333333-3333-3333-3333-333333333333';
  v_eva   uuid := '77777777-0000-0000-0000-000000000001';
  v_miro  uuid := '77777777-0000-0000-0000-000000000002';
  r       record;
begin
  set local role authenticated;
  for r in
    select * from (values
      (v_eva,  'Tribúna Sever', 2400), (v_miro, 'Tribúna Sever', 2700),
      (v_eva,  'Tribúna Juh',   1900), (v_miro, 'Tribúna Juh',   2100),
      (v_miro, 'Tribúna Juh',   2300), (v_eva,  'VIP lóža',      6900),
      (v_miro, 'Státie sever',  1500), (v_eva,  'Státie sever',  1700)
    ) as t(seller, label, price)
  loop
    perform set_config('request.jwt.claim.sub', r.seller::text, true);
    perform public.create_resale_listing(v_event, 'external', r.price, null,
      p_delivery_method => 'file', p_ticket_label => r.label,
      p_external_provider => 'Ticketportal',
      p_ticket_file_path => 'sellers/' || r.seller || '/sektor-' || r.price || '.pdf');
  end loop;
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
