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
