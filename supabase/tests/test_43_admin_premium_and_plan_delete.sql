-- ============================================================================
-- BLUP test 43 · Admin má Premium, a plán sály sa dá zmazať
-- ============================================================================
-- What is proved here:
--
--   · a full admin has the premium features, without a subscription row
--   · a moderator does not — moderating content is a different job
--   · the accounting still counts only people who actually pay
--   · losing the role loses the perks again
--   · the background picture can be dropped without moving a single sector
--   · a plan cannot be deleted out from under a sold ticket
--   · a plan shared with another night is detached, not destroyed
-- ============================================================================
\set ON_ERROR_STOP on

begin;

set local search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4343434-0000-0000-0000-000000000001', 'admin43@example.com', now(), '{"display_name":"Admin"}'),
  ('a4343434-0000-0000-0000-000000000002', 'mod43@example.com',   now(), '{"display_name":"Moderátor"}'),
  ('a4343434-0000-0000-0000-000000000003', 'payer43@example.com', now(), '{"display_name":"Platiaci"}'),
  ('a4343434-0000-0000-0000-000000000004', 'org43@example.com',   now(), '{"display_name":"Organizátor"}'),
  ('a4343434-0000-0000-0000-000000000005', 'buyer43@example.com', now(), '{"display_name":"Kupujúci"}');

update public.profiles set app_role = 'admin'     where id = 'a4343434-0000-0000-0000-000000000001';
update public.profiles set app_role = 'moderator' where id = 'a4343434-0000-0000-0000-000000000002';

insert into public.premium_subscriptions (user_id, platform, status, product_id, expires_at)
values ('a4343434-0000-0000-0000-000000000003', 'apple', 'active',
        'com.blup.app.premium.monthly', now() + interval '30 days');


-- ============================================================================
-- 1. Admin má funkcie, moderátor nie, a účtovníctvo to nepovažuje za tržbu
-- ============================================================================
do $$
declare
  admin uuid := 'a4343434-0000-0000-0000-000000000001';
  mod   uuid := 'a4343434-0000-0000-0000-000000000002';
  payer uuid := 'a4343434-0000-0000-0000-000000000003';
  n     integer;
begin
  assert public.is_premium(admin), 'an admin can use the premium features';
  assert public.is_premium(payer), 'and so can somebody who pays';
  assert not public.is_premium(mod),
    'a moderator moderates content — that is a different job from running the place';
  raise notice 'PASS admin má Premium na testovanie, moderátor nie';

  -- The grant is not a subscription. Nothing was written to the table that
  -- records who pays, so nothing downstream can mistake an admin for revenue.
  select count(*) into n from public.premium_subscriptions where user_id = admin;
  assert n = 0, format('an admin has no subscription row, got %s', n);

  perform set_config('request.jwt.claim.sub', admin::text, true);
  assert (public.admin_platform_stats() ->> 'premium_users')::int = 1,
    'and the dashboard counts only the one person who actually pays';
  raise notice 'PASS grant nie je predplatné — účtovníctvo vidí len skutočných platiacich';

  -- The badge beside the name comes from profiles.premium_until.
  assert (select premium_until from public.profiles where id = admin) > now() + interval '1 year',
    'an admin sees the badge a subscriber sees';
  raise notice 'PASS admin vidí aj odznak, nielen funkcie';
end $$;


-- ============================================================================
-- 2. Keď rola skončí, skončia aj funkcie
-- ============================================================================
do $$
declare
  admin uuid := 'a4343434-0000-0000-0000-000000000001';
  payer uuid := 'a4343434-0000-0000-0000-000000000003';
begin
  -- Role changes run with no session: protect_profile_privileges() reverts any
  -- app_role written by somebody who is not a full admin, and demoting
  -- yourself means the restore afterwards would be silently undone. In life
  -- this is an admin changing somebody ELSE, or the service role.
  perform set_config('request.jwt.claim.sub', '', true);

  update public.profiles set app_role = 'user' where id = admin;
  assert not public.is_premium(admin), 'losing the role loses the perks';
  assert (select premium_until from public.profiles where id = admin) is null,
    'and the badge with them';
  raise notice 'PASS odobratie roly odoberie aj Premium';

  -- Somebody who is both keeps what they pay for.
  update public.profiles set app_role = 'admin' where id = payer;
  update public.profiles set app_role = 'user'  where id = payer;
  assert public.is_premium(payer), 'a subscriber who was briefly an admin still pays';
  assert (select premium_until from public.profiles where id = payer) > now(),
    'and keeps the badge they bought';
  raise notice 'PASS kto si Premium platí, o nič neprišiel';

  update public.profiles set app_role = 'admin' where id = admin;
end $$;


-- ============================================================================
-- 3. Podkladová fotka preč, sektory zostanú
-- ============================================================================
insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values ('d4343434-0000-0000-0000-000000000001', 'Sála 43', 'sala-43',
        'a4343434-0000-0000-0000-000000000004', 'verified', true);

do $$
declare
  admin uuid := 'a4343434-0000-0000-0000-000000000001';
  org   uuid := 'a4343434-0000-0000-0000-000000000004';
  map   uuid;
  ev    uuid := 'e4343434-0000-0000-0000-000000000001';
  sect  uuid;
  x_before numeric;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);

  insert into public.venue_maps (organization_id, name, image_url, image_width, image_height, created_by)
  values ('d4343434-0000-0000-0000-000000000001', 'Sála', 'https://example.com/zle-odfotene.jpg',
          1600, 1200, admin)
  returning id into map;

  insert into public.events (id, creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status, venue_map_id)
  values (ev, org, 'd4343434-0000-0000-0000-000000000001', 'Večer v sále', 'theatre',
          now() + interval '20 days', 48.1486, 17.1077, false, 1500, 'published', map);

  insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
  values ('c4343434-0000-0000-0000-000000000001', ev, 'Sedadlo', 1500, 50, 10);

  insert into public.venue_sections (venue_map_id, ticket_type_id, name, x, y, width, height)
  values (map, 'c4343434-0000-0000-0000-000000000001', 'Parter', 0.1, 0.2, 0.7, 0.5)
  returning id into sect;

  perform public.generate_section_seats(sect, 4, 6);

  select x into x_before from public.venue_sections where id = sect;

  perform public.clear_venue_map_image(map);

  assert (select image_url from public.venue_maps where id = map) is null,
    'the picture is gone';
  assert (select x from public.venue_sections where id = sect) = x_before,
    'and the sectors have not moved — they are fractions of the image, not pixels';
  assert (select count(*) from public.venue_seats where venue_section_id = sect) = 24,
    'nor have the seats';
  raise notice 'PASS zlú fotku sály sa dá vymeniť bez toho, aby sa čokoľvek pohlo';

  -- And only BLUP may do it.
  perform set_config('request.jwt.claim.sub', org::text, true);
  begin
    perform public.clear_venue_map_image(map);
    assert false, 'the organizer does not edit the plan';
  exception when others then
    assert sqlerrm = 'VENUE_PLAN_IS_ADMIN_ONLY',
      format('expected VENUE_PLAN_IS_ADMIN_ONLY, got %s', sqlerrm);
  end;
  raise notice 'PASS aj mazanie fotky je vec BLUPu';
end $$;


-- ============================================================================
-- 4. Plán sa nedá zmazať spod predanej vstupenky
-- ============================================================================
do $$
declare
  admin uuid := 'a4343434-0000-0000-0000-000000000001';
  buyer uuid := 'a4343434-0000-0000-0000-000000000005';
  ev    uuid := 'e4343434-0000-0000-0000-000000000001';
  seat  uuid;
  res   jsonb;
  map   uuid;
begin
  select venue_map_id into map from public.events where id = ev;

  select vs.id into seat from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  where s.venue_map_id = map and vs.row_label = 'B' and vs.seat_number = 2;

  insert into public.tickets (event_id, ticket_type_id, venue_seat_id, buyer_id,
                              code, qr_secret, status, price_cents)
  values (ev, 'c4343434-0000-0000-0000-000000000001', seat, buyer,
          'BLP-43-1', 'x', 'valid', 1500);

  perform set_config('request.jwt.claim.sub', admin::text, true);
  begin
    res := public.delete_venue_map(ev);
    assert false, 'a sold seat must not be deleted out from under its ticket';
  exception when others then
    assert sqlerrm = 'SEATS_IN_USE', format('expected SEATS_IN_USE, got %s', sqlerrm);
  end;

  assert (select venue_map_id from public.events where id = ev) = map,
    'and the refusal changes nothing';
  assert (select venue_seat_id from public.tickets where code = 'BLP-43-1') = seat,
    'the ticket still names its seat';
  raise notice 'PASS plán sa nezmaže spod vstupenky, ktorú niekto zaplatil';

  -- Detaching is the way out: the event stops selling by seat, the plan lives.
  res := public.delete_venue_map(ev, true);
  assert (res ->> 'detached')::boolean, 'the plan comes off the event';
  assert not (res ->> 'deleted')::boolean, 'without being destroyed';
  assert (select venue_map_id from public.events where id = ev) is null,
    'the event sells by count again';
  assert (select count(*) from public.venue_maps where id = map) = 1,
    'and the plan is still there for the next night';
  assert (select venue_seat_id from public.tickets where code = 'BLP-43-1') = seat,
    'and the sold ticket still knows where its seat was';
  raise notice 'PASS odpojenie plánu nechá vstupenkám ich miesta';
end $$;


-- ============================================================================
-- 5. Plán, ktorý nikto nepoužíva, sa zmaže naozaj
-- ============================================================================
do $$
declare
  admin uuid := 'a4343434-0000-0000-0000-000000000001';
  org   uuid := 'a4343434-0000-0000-0000-000000000004';
  map   uuid;
  ev    uuid := 'e4343434-0000-0000-0000-000000000002';
  res   jsonb;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);

  insert into public.venue_maps (organization_id, name, image_width, image_height, created_by)
  values ('d4343434-0000-0000-0000-000000000001', 'Omyl', 1000, 1000, admin)
  returning id into map;

  insert into public.events (id, creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status, venue_map_id)
  values (ev, org, 'd4343434-0000-0000-0000-000000000001', 'Zle nakreslené', 'music',
          now() + interval '30 days', 48.1486, 17.1077, true, 0, 'published', map);

  insert into public.venue_sections (venue_map_id, name, x, y, width, height)
  values (map, 'Sem nepatrí', 0.1, 0.1, 0.2, 0.2);

  res := public.delete_venue_map(ev);
  assert (res ->> 'deleted')::boolean, 'a plan nobody uses is deleted';
  assert (select count(*) from public.venue_maps where id = map) = 0, 'really deleted';
  assert (select count(*) from public.venue_sections where venue_map_id = map) = 0,
    'and its sectors with it';
  raise notice 'PASS zle nakreslený plán sa dá zahodiť a začať odznova';
end $$;

rollback;
