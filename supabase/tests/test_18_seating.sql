-- ============================================================================
-- BLUP test 18 · Sectors and numbered seats
-- ============================================================================
-- What is actually being proved here:
--
--   · a sector is a ticket type, so everything priced already works on it
--   · holding a seat takes it away from everybody else, immediately
--   · an expired hold gives it back without anything having to sweep it
--   · a seat sold is a seat gone, and cannot be sold twice
--   · a seat marked unsellable cannot be held at all
--   · holding seats still counts against the 20-per-order ceiling
--   · the seat map tells the truth about what is free
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1818181-0000-0000-0000-000000000001', 'org18@example.com',   '{"display_name":"Org"}'),
  ('a1818181-0000-0000-0000-000000000002', 'buyer18@example.com', '{"display_name":"Buyer"}'),
  ('a1818181-0000-0000-0000-000000000003', 'rival18@example.com', '{"display_name":"Rival"}');

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values ('d1818181-0000-0000-0000-000000000001', 'Arena Co', 'arena-co-18',
        'a1818181-0000-0000-0000-000000000001', 'verified', true);

insert into public.venue_maps (id, organization_id, name, image_width, image_height, created_by)
values ('f1818181-0000-0000-0000-000000000001', 'd1818181-0000-0000-0000-000000000001',
        'Veľká hala', 2000, 1400, 'a1818181-0000-0000-0000-000000000001');

insert into public.events (id, creator_id, organization_id, title, category, start_at,
                           latitude, longitude, is_free, price_cents, status, venue_map_id)
values ('d1818181-0000-0000-0000-000000000002', 'a1818181-0000-0000-0000-000000000001',
        'd1818181-0000-0000-0000-000000000001', 'Koncert v hale', 'rock',
        now() + interval '20 days', 48.1486, 17.1077, false, 2500, 'published',
        'f1818181-0000-0000-0000-000000000001');

-- A numbered sector and an open one, each a ticket type.
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
values
  ('c1818181-0000-0000-0000-000000000001', 'd1818181-0000-0000-0000-000000000002',
   'Sedenie A', 3500, 6, 20),
  ('c1818181-0000-0000-0000-000000000002', 'd1818181-0000-0000-0000-000000000002',
   'Státie', 2500, 100, 20);

insert into public.venue_sections (id, venue_map_id, ticket_type_id, name, x, y, width, height)
values
  ('b1818181-0000-0000-0000-000000000001', 'f1818181-0000-0000-0000-000000000001',
   'c1818181-0000-0000-0000-000000000001', 'Sedenie A', 0.1, 0.1, 0.3, 0.2),
  ('b1818181-0000-0000-0000-000000000002', 'f1818181-0000-0000-0000-000000000001',
   'c1818181-0000-0000-0000-000000000002', 'Státie', 0.5, 0.1, 0.4, 0.6);

-- Six seats, one of them behind a pillar.
insert into public.venue_seats (id, venue_section_id, row_label, seat_number, is_sellable)
values
  ('91818181-0000-0000-0000-000000000001', 'b1818181-0000-0000-0000-000000000001', 'A', 1, true),
  ('91818181-0000-0000-0000-000000000002', 'b1818181-0000-0000-0000-000000000001', 'A', 2, true),
  ('91818181-0000-0000-0000-000000000003', 'b1818181-0000-0000-0000-000000000001', 'A', 3, true),
  ('91818181-0000-0000-0000-000000000004', 'b1818181-0000-0000-0000-000000000001', 'B', 1, true),
  ('91818181-0000-0000-0000-000000000005', 'b1818181-0000-0000-0000-000000000001', 'B', 2, true),
  ('91818181-0000-0000-0000-000000000006', 'b1818181-0000-0000-0000-000000000001', 'B', 3, false);

do $$
declare
  buyer uuid := 'a1818181-0000-0000-0000-000000000002';
  rival uuid := 'a1818181-0000-0000-0000-000000000003';
  ev    uuid := 'd1818181-0000-0000-0000-000000000002';
  seat1 uuid := '91818181-0000-0000-0000-000000000001';
  pillar uuid := '91818181-0000-0000-0000-000000000006';
  map jsonb;
  seated jsonb;
  n integer;
begin
  -- ---- the map before anything happens --------------------------------------
  map := public.seat_map_for_event(ev);
  assert map is not null, 'an event with a plan has a seat map';
  assert jsonb_array_length(map -> 'sections') = 2, 'both sectors are on it';

  seated := (select s from jsonb_array_elements(map -> 'sections') s
             where s ->> 'name' = 'Sedenie A');
  assert (seated ->> 'numbered')::boolean, 'the seated sector says it is numbered';
  assert (seated ->> 'available')::int = 5,
    format('five sellable seats, not six — one is behind a pillar; got %s', seated ->> 'available');
  raise notice 'PASS the map counts sellable seats, not all seats';

  -- ---- an open sector counts by ticket type ---------------------------------
  seated := (select s from jsonb_array_elements(map -> 'sections') s where s ->> 'name' = 'Státie');
  assert not (seated ->> 'numbered')::boolean, 'the standing sector is not numbered';
  assert (seated ->> 'available')::int = 100, 'and counts its ticket type';
  raise notice 'PASS an open sector sells by count, a numbered one by seat';

  -- ---- holding ---------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', buyer::text, true);
  perform public.cart_hold_seat(seat1);

  perform set_config('request.jwt.claim.sub', rival::text, true);
  begin
    perform public.cart_hold_seat(seat1);
    assert false, 'a held seat must not be holdable by somebody else';
  exception when others then
    assert sqlerrm = 'SEAT_HELD', format('expected SEAT_HELD, got %s', sqlerrm);
  end;
  raise notice 'PASS a held seat is gone for everybody else at once';

  map := public.seat_map_for_event(ev);
  seated := (select s from jsonb_array_elements(map -> 'sections') s
             where s ->> 'name' = 'Sedenie A');
  assert (seated ->> 'available')::int = 4, 'and the map says so';

  -- ---- a seat behind a pillar ------------------------------------------------
  begin
    perform public.cart_hold_seat(pillar);
    assert false, 'an unsellable seat must not be holdable';
  exception when others then
    assert sqlerrm = 'SEAT_NOT_SELLABLE', format('expected SEAT_NOT_SELLABLE, got %s', sqlerrm);
  end;
  raise notice 'PASS a seat held back cannot be sold';

  -- ---- an expired hold -------------------------------------------------------
  update public.cart_items set expires_at = now() - interval '1 minute'
  where venue_seat_id = seat1;

  perform public.cart_hold_seat(seat1);   -- the rival, now that it lapsed
  assert exists (select 1 from public.cart_items
                 where venue_seat_id = seat1 and user_id = rival and expires_at > now()),
    'an expired hold releases the seat to the next person';
  raise notice 'PASS an expired hold gives the seat back';

  -- ---- sold is sold ----------------------------------------------------------
  insert into public.tickets (event_id, ticket_type_id, venue_seat_id, buyer_id, code, qr_secret, status, price_cents)
  values (ev, 'c1818181-0000-0000-0000-000000000001', seat1, rival, 'BLP-SEAT-1', 'x', 'valid', 3500);

  delete from public.cart_items where venue_seat_id = seat1;

  perform set_config('request.jwt.claim.sub', buyer::text, true);
  begin
    perform public.cart_hold_seat(seat1);
    assert false, 'a sold seat must not be holdable';
  exception when others then
    assert sqlerrm = 'SEAT_TAKEN', format('expected SEAT_TAKEN, got %s', sqlerrm);
  end;
  raise notice 'PASS a sold seat cannot be held again';

  -- ---- and cannot be sold twice, whatever the app does ----------------------
  begin
    insert into public.tickets (event_id, ticket_type_id, venue_seat_id, buyer_id, code, qr_secret, status, price_cents)
    values (ev, 'c1818181-0000-0000-0000-000000000001', seat1, buyer, 'BLP-SEAT-2', 'y', 'valid', 3500);
    assert false, 'the database must refuse a second live ticket for one seat';
  exception when unique_violation then
    null;
  end;
  raise notice 'PASS one seat cannot carry two live tickets';

  -- ---- the ceiling still applies --------------------------------------------
  perform public.cart_hold_seat('91818181-0000-0000-0000-000000000002');
  perform public.cart_hold_seat('91818181-0000-0000-0000-000000000003');
  select coalesce(sum(quantity), 0) into n
  from public.cart_items where user_id = buyer and expires_at > now();
  assert n = 2, format('two seats are two tickets in the basket, got %s', n);
  raise notice 'PASS seats count against the basket like any other ticket';
end $$;

rollback;
