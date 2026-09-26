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
    p_note => 'Dve vedľa seba, PDF pošlem hneď po platbe.'
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
