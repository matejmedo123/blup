-- ============================================================================
-- BLUP test 42 · Sála, hala, štadión — a kto ich smie nakresliť
-- ============================================================================
-- The seating tests before this one used a six-seat fixture, which proves the
-- rules and nothing about the rooms. This builds three real ones and checks
-- that the thing holds at their size and shape:
--
--   sála     divadlo: parter, balkón, dve VIP lóže, pódium a bar ako orientácia
--   hala     státie na ploche predávané na počet + štyri číslované tribúny
--   štadión  štyri sektory po 2 000 miestach — osem tisíc dohromady
--
-- And the two rules that are new with it:
--
--   · plán kreslí BLUP. Organizátor požiada, my nakreslíme — a odmietnutie
--     platí aj preňho, nielen pre cudzieho človeka.
--   · sektor má druh. „VIP lóža" a „pódium" nie sú to isté čo „Sektor A", a
--     pódium nie je na predaj vôbec.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

set local search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4242424-0000-0000-0000-000000000001', 'admin42@example.com',  now(), '{"display_name":"Admin"}'),
  ('a4242424-0000-0000-0000-000000000002', 'org42@example.com',    now(), '{"display_name":"Organizátor"}'),
  ('a4242424-0000-0000-0000-000000000003', 'buyer42@example.com',  now(), '{"display_name":"Kupujúci"}'),
  ('a4242424-0000-0000-0000-000000000004', 'random42@example.com', now(), '{"display_name":"Nikto"}');

update public.profiles set app_role = 'admin' where id = 'a4242424-0000-0000-0000-000000000001';

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values ('d4242424-0000-0000-0000-000000000001', 'Mestské kultúrne', 'mestske-42',
        'a4242424-0000-0000-0000-000000000002', 'verified', true);

insert into public.organization_members (organization_id, user_id, role)
values ('d4242424-0000-0000-0000-000000000001', 'a4242424-0000-0000-0000-000000000002', 'owner')
on conflict do nothing;

insert into public.events (id, creator_id, organization_id, title, category, start_at,
                           latitude, longitude, is_free, price_cents, status)
values
  ('e4242424-0000-0000-0000-000000000001', 'a4242424-0000-0000-0000-000000000002',
   'd4242424-0000-0000-0000-000000000001', 'Divadlo · premiéra', 'theatre',
   now() + interval '20 days', 48.1486, 17.1077, false, 1800, 'published'),
  ('e4242424-0000-0000-0000-000000000002', 'a4242424-0000-0000-0000-000000000002',
   'd4242424-0000-0000-0000-000000000001', 'Hala · koncert', 'music',
   now() + interval '40 days', 48.1486, 17.1077, false, 3500, 'published'),
  ('e4242424-0000-0000-0000-000000000003', 'a4242424-0000-0000-0000-000000000002',
   'd4242424-0000-0000-0000-000000000001', 'Štadión · derby', 'sport',
   now() + interval '60 days', 48.1486, 17.1077, false, 2200, 'published'),
  ('e4242424-0000-0000-0000-000000000004', 'a4242424-0000-0000-0000-000000000002',
   'd4242424-0000-0000-0000-000000000001', 'Hala · koncert o mesiac', 'music',
   now() + interval '70 days', 48.1486, 17.1077, false, 3500, 'published');


-- ============================================================================
-- 1. Plán kreslí BLUP — nie organizátor a nie cudzí človek
-- ============================================================================
do $$
declare
  org    uuid := 'a4242424-0000-0000-0000-000000000002';
  nobody uuid := 'a4242424-0000-0000-0000-000000000004';
  admin  uuid := 'a4242424-0000-0000-0000-000000000001';
  ev     uuid := 'e4242424-0000-0000-0000-000000000001';
  map_id uuid;
begin
  -- The organizer owns this event. They still cannot draw its plan: a sector
  -- ten pixels wrong sells the wrong seat, and one pointed at the wrong ticket
  -- type sells the wrong price.
  perform set_config('request.jwt.claim.sub', org::text, true);
  begin
    perform public.assert_can_manage_venue_map(null);
    assert false, 'the organizer must not be able to draw their own plan';
  exception when others then
    assert sqlerrm = 'VENUE_PLAN_IS_ADMIN_ONLY',
      format('expected VENUE_PLAN_IS_ADMIN_ONLY, got %s', sqlerrm);
  end;

  perform set_config('request.jwt.claim.sub', nobody::text, true);
  begin
    perform public.assert_can_manage_venue_map(null);
    assert false, 'and neither may a passer-by';
  exception when others then
    assert sqlerrm = 'VENUE_PLAN_IS_ADMIN_ONLY',
      format('expected VENUE_PLAN_IS_ADMIN_ONLY, got %s', sqlerrm);
  end;
  raise notice 'PASS plán sály nekreslí organizátor ani cudzí človek';

  -- And attaching somebody else's finished plan is the same decision, so it is
  -- refused at the table rather than in the screen that usually does it.
  perform set_config('request.jwt.claim.sub', admin::text, true);
  insert into public.venue_maps (id, organization_id, name, image_width, image_height, created_by)
  values ('f4242424-0000-0000-0000-000000000001', 'd4242424-0000-0000-0000-000000000001',
          'Divadelná sála', 1600, 1200, admin)
  returning id into map_id;

  perform set_config('request.jwt.claim.sub', org::text, true);
  begin
    update public.events set venue_map_id = map_id where id = ev;
    assert false, 'the organizer must not be able to attach a plan either';
  exception when others then
    assert sqlerrm = 'VENUE_PLAN_IS_ADMIN_ONLY',
      format('expected VENUE_PLAN_IS_ADMIN_ONLY, got %s', sqlerrm);
  end;
  raise notice 'PASS ani priradenie hotového plánu na event nie je vec organizátora';

  perform set_config('request.jwt.claim.sub', admin::text, true);
  update public.events set venue_map_id = map_id where id = ev;
  assert (select venue_map_id from public.events where id = ev) = map_id,
    'an admin attaches it';
  raise notice 'PASS admin plán priradí';
end $$;


-- ============================================================================
-- 2. Sála: parter, balkón, dve VIP lóže, pódium a bar
-- ============================================================================
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
values
  ('c4242424-0000-0000-0000-000000000001', 'e4242424-0000-0000-0000-000000000001', 'Parter', 1800, 300, 10),
  ('c4242424-0000-0000-0000-000000000002', 'e4242424-0000-0000-0000-000000000001', 'Balkón', 1200, 120, 10),
  ('c4242424-0000-0000-0000-000000000003', 'e4242424-0000-0000-0000-000000000001', 'VIP lóža', 6000, 12, 6);

do $$
declare
  admin uuid := 'a4242424-0000-0000-0000-000000000001';
  ev    uuid := 'e4242424-0000-0000-0000-000000000001';
  map   uuid := 'f4242424-0000-0000-0000-000000000001';
  parter uuid; balkon uuid; vip_l uuid; vip_p uuid; podium uuid; bar uuid;
  made  jsonb;
  sect  jsonb;
  total integer;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);

  insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, x, y, width, height, sort_order)
  values (map, 'c4242424-0000-0000-0000-000000000001', 'Parter', '#0080FF', 'standard', 0.10, 0.30, 0.80, 0.45, 0)
  returning id into parter;

  insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, x, y, width, height, sort_order)
  values (map, 'c4242424-0000-0000-0000-000000000002', 'Balkón', '#22C55E', 'standard', 0.15, 0.78, 0.70, 0.18, 1)
  returning id into balkon;

  insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, note, x, y, width, height, sort_order)
  values (map, 'c4242424-0000-0000-0000-000000000003', 'VIP lóža ľavá', '#A855F7', 'box',
          'Vlastný vstup, obsluha pri stole', 0.02, 0.35, 0.07, 0.25, 2)
  returning id into vip_l;

  insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, note, x, y, width, height, sort_order)
  values (map, 'c4242424-0000-0000-0000-000000000003', 'VIP lóža pravá', '#A855F7', 'box',
          'Vlastný vstup, obsluha pri stole', 0.91, 0.35, 0.07, 0.25, 3)
  returning id into vip_p;

  -- Two landmarks. A hall plan without the stage on it is a grid of rectangles
  -- nobody can orient themselves in.
  insert into public.venue_sections (venue_map_id, name, colour, kind, x, y, width, height, sort_order)
  values (map, 'Pódium', '#5B6675', 'stage', 0.20, 0.04, 0.60, 0.18, -1)
  returning id into podium;

  insert into public.venue_sections (venue_map_id, name, colour, kind, note, x, y, width, height, sort_order)
  values (map, 'Bar', '#5B6675', 'bar', 'Otvorený hodinu pred začiatkom', 0.02, 0.80, 0.10, 0.14, 9)
  returning id into bar;

  -- A landmark is not a product, and the table says so rather than trusting the
  -- screen to remember.
  begin
    update public.venue_sections set ticket_type_id = 'c4242424-0000-0000-0000-000000000001'
    where id = podium;
    assert false, 'a stage must not be sellable';
  exception when check_violation then
    null;
  end;
  raise notice 'PASS pódium a bar sú orientačné body, nie tovar';

  -- 12 rows of 20, 6 of 16, and six seats in each box.
  made := public.generate_section_seats(parter, 12, 20);
  assert (made ->> 'total')::int = 240, format('parter 12x20, got %s', made ->> 'total');
  made := public.generate_section_seats(balkon, 6, 16);
  assert (made ->> 'total')::int = 96, format('balkón 6x16, got %s', made ->> 'total');
  made := public.generate_section_seats(vip_l, 1, 6);
  made := public.generate_section_seats(vip_p, 1, 6);

  select count(*) into total from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  where s.venue_map_id = map;
  assert total = 348, format('sála má 348 miest, got %s', total);
  raise notice 'PASS sála: parter 240 + balkón 96 + dve lóže po 6';

  -- What the buyer's screen gets.
  sect := (select s from jsonb_array_elements(public.seat_map_for_event(ev) -> 'sections') s
           where s ->> 'name' = 'VIP lóža ľavá');
  assert sect ->> 'kind' = 'box', 'a box says it is a box';
  assert not (sect ->> 'landmark')::boolean, 'and is for sale';
  assert (sect ->> 'price_cents')::int = 6000, 'at the VIP price';
  assert sect ->> 'note' = 'Vlastný vstup, obsluha pri stole', 'with its own line for the buyer';

  sect := (select s from jsonb_array_elements(public.seat_map_for_event(ev) -> 'sections') s
           where s ->> 'name' = 'Pódium');
  assert (sect ->> 'landmark')::boolean, 'the stage is a landmark';
  assert (sect ->> 'available')::int = 0, 'and nothing on it is available';
  assert sect -> 'ticket_type_id' = 'null'::jsonb, 'and it sells nothing';
  raise notice 'PASS VIP lóža sa na pláne číta ako VIP, pódium ako pódium';

  -- The sectors come in drawing order, so the stage is behind the seats.
  assert (select s ->> 'name' from jsonb_array_elements(public.seat_map_for_event(ev) -> 'sections')
          with ordinality t(s, i) where i = 1) = 'Pódium',
    'the stage is drawn first, so the seats sit on top of it';
  raise notice 'PASS poradie kreslenia drží pódium pod sedadlami';
end $$;


-- ============================================================================
-- 3. Hala: státie na počet a štyri číslované tribúny na jednom pláne
-- ============================================================================
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
values
  ('c4242424-0000-0000-0000-000000000011', 'e4242424-0000-0000-0000-000000000002', 'Státie', 3500, 2000, 10),
  ('c4242424-0000-0000-0000-000000000012', 'e4242424-0000-0000-0000-000000000002', 'Tribúna', 4500, 800, 10),
  ('c4242424-0000-0000-0000-000000000013', 'e4242424-0000-0000-0000-000000000002', 'VIP', 9000, 40, 6);

do $$
declare
  admin uuid := 'a4242424-0000-0000-0000-000000000001';
  ev    uuid := 'e4242424-0000-0000-0000-000000000002';
  map   uuid;
  stand uuid;
  sect  jsonb;
  made  jsonb;
  i     integer;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);

  insert into public.venue_maps (organization_id, name, image_width, image_height, created_by)
  values ('d4242424-0000-0000-0000-000000000001', 'Veľká hala', 2000, 2000, admin)
  returning id into map;

  update public.events set venue_map_id = map where id = ev;

  -- The floor sells by count: no seats, so the ticket type is the whole story.
  insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, x, y, width, height, sort_order)
  values (map, 'c4242424-0000-0000-0000-000000000011', 'Plocha', '#FF8A3D', 'standing', 0.30, 0.32, 0.40, 0.36, 1);

  insert into public.venue_sections (venue_map_id, name, colour, kind, x, y, width, height, sort_order)
  values (map, 'Pódium', '#5B6675', 'stage', 0.30, 0.06, 0.40, 0.20, 0);

  -- Four numbered stands around it, 10 rows of 20 each.
  for i in 1..4 loop
    insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, x, y, width, height, sort_order)
    values (map, 'c4242424-0000-0000-0000-000000000012', 'Tribúna ' || chr(64 + i), '#0080FF', 'standard',
            case i when 1 then 0.02 when 2 then 0.78 when 3 then 0.30 else 0.30 end,
            case i when 1 then 0.30 when 2 then 0.30 when 3 then 0.72 else 0.72 end,
            case i when 3 then 0.18 when 4 then 0.18 else 0.18 end,
            0.24, i + 1)
    returning id into stand;

    made := public.generate_section_seats(stand, 10, 20);
    assert (made ->> 'total')::int = 200, format('tribúna 10x20, got %s', made ->> 'total');
  end loop;

  insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, note, x, y, width, height, sort_order)
  values (map, 'c4242424-0000-0000-0000-000000000013', 'VIP', '#A855F7', 'vip',
          'Pri pódiu, vlastný bar', 0.30, 0.26, 0.40, 0.04, 6)
  returning id into stand;
  made := public.generate_section_seats(stand, 2, 20);

  -- Standing and numbered on one plan, each counted its own way.
  sect := (select s from jsonb_array_elements(public.seat_map_for_event(ev) -> 'sections') s
           where s ->> 'name' = 'Plocha');
  assert not (sect ->> 'numbered')::boolean, 'the floor is not numbered';
  assert (sect ->> 'available')::int = 2000, 'and counts its ticket type';
  assert sect ->> 'kind' = 'standing', 'and says it is standing';

  sect := (select s from jsonb_array_elements(public.seat_map_for_event(ev) -> 'sections') s
           where s ->> 'name' = 'Tribúna A');
  assert (sect ->> 'numbered')::boolean, 'a stand is numbered';
  assert (sect ->> 'available')::int = 200, 'and counts its seats';
  assert (sect ->> 'rows')::int = 10 and (sect ->> 'row_width')::int = 20,
    'and carries the grid the dots are laid out on';
  raise notice 'PASS hala: státie na počet a číslované tribúny vedľa seba, každé po svojom';

  sect := (select s from jsonb_array_elements(public.seat_map_for_event(ev) -> 'sections') s
           where s ->> 'name' = 'VIP');
  assert sect ->> 'kind' = 'vip' and (sect ->> 'price_cents')::int = 9000,
    'and VIP is VIP, at the VIP price';
  raise notice 'PASS VIP sektor v hale';
end $$;


-- ============================================================================
-- 4. Štadión: osem tisíc miest, a plán, ktorý sa zmestí do telefónu
-- ============================================================================
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
values ('c4242424-0000-0000-0000-000000000021', 'e4242424-0000-0000-0000-000000000003',
        'Sektor', 2200, 9000, 10);

do $$
declare
  admin uuid := 'a4242424-0000-0000-0000-000000000001';
  ev    uuid := 'e4242424-0000-0000-0000-000000000003';
  map   uuid;
  sect  uuid;
  made  jsonb;
  i     integer;
  total integer;
  payload integer;
  seats jsonb;
  picked integer;
begin
  perform set_config('request.jwt.claim.sub', admin::text, true);

  insert into public.venue_maps (organization_id, name, image_width, image_height, created_by)
  values ('d4242424-0000-0000-0000-000000000001', 'Štadión', 2400, 1600, admin)
  returning id into map;

  update public.events set venue_map_id = map where id = ev;

  insert into public.venue_sections (venue_map_id, name, colour, kind, x, y, width, height, sort_order)
  values (map, 'Hracia plocha', '#22C55E', 'other', 0.25, 0.25, 0.50, 0.50, 0);

  for i in 1..4 loop
    insert into public.venue_sections (venue_map_id, ticket_type_id, name, colour, kind, x, y, width, height, sort_order)
    values (map, 'c4242424-0000-0000-0000-000000000021', 'Sektor ' || chr(64 + i), '#0080FF', 'standard',
            case i when 1 then 0.02 when 2 then 0.80 else 0.25 end,
            case i when 3 then 0.02 when 4 then 0.80 else 0.25 end,
            case i when 1 then 0.16 when 2 then 0.16 else 0.50 end,
            case i when 1 then 0.50 when 2 then 0.50 else 0.16 end,
            i)
    returning id into sect;

    made := public.generate_section_seats(sect, 40, 50);
    assert (made ->> 'total')::int = 2000, format('sektor 40x50, got %s', made ->> 'total');
  end loop;

  select count(*) into total from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  where s.venue_map_id = map;
  assert total = 8000, format('štadión má 8000 miest, got %s', total);
  raise notice 'PASS štadión: štyri sektory po 2 000 miestach';

  -- The whole point of splitting the map from the seats. Eight thousand seat
  -- objects inline would be megabytes; the plan a phone downloads to draw the
  -- stadium is a couple of kilobytes of rectangles and counts.
  payload := length(public.seat_map_for_event(ev)::text);
  assert payload < 6000,
    format('the plan of a 8000-seat stadium must stay small; got %s bytes', payload);
  raise notice 'PASS plán štadióna má % B, nie megabajty', payload;

  -- And the sector you actually opened.
  select s.id into sect from public.venue_sections s
  where s.venue_map_id = map and s.name = 'Sektor A';
  seats := public.section_seats(ev, sect);
  assert jsonb_array_length(seats) = 2000,
    format('one sector is 2000 seats, got %s', jsonb_array_length(seats));
  raise notice 'PASS miesta chodia po sektoroch, nie naraz za celý štadión';

  -- Five together, in a stand of fifty across.
  select count(*) into picked from public.suggest_seats(sect, 5);
  assert picked = 5, format('five together in an empty stand, got %s', picked);
  assert (select count(distinct row_label) from public.suggest_seats(sect, 5)) = 1,
    'and in one row';
  raise notice 'PASS „nájdi nám päť vedľa seba" funguje aj na štadióne';
end $$;


-- ============================================================================
-- 5. Organizátor požiada, admin nakreslí
-- ============================================================================
do $$
declare
  org    uuid := 'a4242424-0000-0000-0000-000000000002';
  admin  uuid := 'a4242424-0000-0000-0000-000000000001';
  nobody uuid := 'a4242424-0000-0000-0000-000000000004';
  ev     uuid := 'e4242424-0000-0000-0000-000000000004';
  req    public.venue_plan_requests;
  n      integer;
  state  jsonb;
begin
  perform set_config('request.jwt.claim.sub', org::text, true);

  -- Too little to draw from is not a request, it is a second round of e-mails.
  begin
    req := public.request_venue_plan(ev, 'plán prosím');
    assert false, 'three words is not a brief';
  exception when others then
    assert sqlerrm = 'TELL_US_MORE', format('expected TELL_US_MORE, got %s', sqlerrm);
  end;

  req := public.request_venue_plan(ev,
    'Veľká hala, plocha na státie pred pódiom a štyri tribúny po 10 radov × 20 miest. '
    || 'Pri pódiu chceme VIP sektor na 40 miest s vlastným barom.');
  assert req.status = 'open', 'a new request is open';
  assert req.organization_id = 'd4242424-0000-0000-0000-000000000001', 'and belongs to the organization';

  -- Every admin is told. A queue nobody is shown is a queue nobody empties.
  select count(*) into n from public.notifications
  where user_id = admin and type = 'venue_plan';
  assert n = 1, format('the admin is told, got %s', n);
  raise notice 'PASS žiadosť o plán sa dostane k adminovi, nie do e-mailu, na ktorý sa zabudne';

  -- Asking twice is impatience, not a second job.
  begin
    req := public.request_venue_plan(ev, repeat('to isté ešte raz. ', 3));
    assert false, 'one open request per event';
  exception when others then
    assert sqlerrm = 'VENUE_PLAN_ALREADY_REQUESTED',
      format('expected VENUE_PLAN_ALREADY_REQUESTED, got %s', sqlerrm);
  end;
  raise notice 'PASS druhá žiadosť na ten istý event je tá istá žiadosť';

  -- Somebody with nothing to do with the event.
  perform set_config('request.jwt.claim.sub', nobody::text, true);
  begin
    req := public.request_venue_plan(ev, repeat('chcem plán do cudzieho eventu. ', 2));
    assert false, 'a stranger has no reason to ask';
  exception when others then
    assert sqlerrm = 'NOT_AUTHORIZED', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;
  begin
    perform public.venue_plan_queue();
    assert false, 'and cannot read the queue';
  exception when others then
    assert sqlerrm = 'NOT_AUTHORIZED', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;
  raise notice 'PASS frontu vidí admin, nie ktokoľvek';

  -- The admin works through it.
  perform set_config('request.jwt.claim.sub', admin::text, true);
  select count(*) into n from public.venue_plan_queue('open');
  assert n = 1, format('one open request, got %s', n);
  assert (select has_plan from public.venue_plan_queue('open') limit 1) = false,
    'and the event has no plan yet — which is why it is in the queue';

  req := public.set_venue_plan_request(req.id, 'in_progress', 'Robím na tom.');
  assert req.status = 'in_progress', 'taken';

  req := public.set_venue_plan_request(req.id, 'done', 'Hotovo, pozri sa.');
  assert req.status = 'done', 'finished';

  select count(*) into n from public.notifications
  where user_id = org and type = 'venue_plan';
  assert n = 1, format('the organizer is told when it is ready, got %s', n);
  raise notice 'PASS organizátorovi príde správa, keď je plán hotový';

  -- What their own event screen shows them.
  perform set_config('request.jwt.claim.sub', org::text, true);
  state := public.venue_plan_request_for_event(ev);
  assert state ->> 'status' = 'done', 'the organizer sees where their request got to';
  assert state ->> 'admin_note' = 'Hotovo, pozri sa.', 'including what we said about it';

  perform set_config('request.jwt.claim.sub', nobody::text, true);
  assert public.venue_plan_request_for_event(ev) is null,
    'and nobody else sees it at all';
  raise notice 'PASS stav žiadosti vidí ten, koho sa týka';
end $$;


-- ============================================================================
-- 6. Tá istá hala, o mesiac
-- ============================================================================
do $$
declare
  admin  uuid := 'a4242424-0000-0000-0000-000000000001';
  org    uuid := 'a4242424-0000-0000-0000-000000000002';
  source uuid := 'e4242424-0000-0000-0000-000000000002';
  target uuid := 'e4242424-0000-0000-0000-000000000004';
  src_map uuid;
  result  jsonb;
  new_map uuid;
  sect   record;
  n      integer;
begin
  select venue_map_id into src_map from public.events where id = source;

  -- The next night needs its own ticket types — a type belongs to one event —
  -- and they are deliberately named the same, because that is what the clone
  -- matches on.
  insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order)
  values
    (target, 'Státie', 3500, 2000, 10),
    (target, 'Tribúna', 4900, 800, 10),
    (target, 'VIP', 9500, 40, 6);

  perform set_config('request.jwt.claim.sub', org::text, true);
  begin
    result := public.clone_venue_map(src_map, target);
    assert false, 'cloning a plan is drawing a plan';
  exception when others then
    assert sqlerrm = 'VENUE_PLAN_IS_ADMIN_ONLY',
      format('expected VENUE_PLAN_IS_ADMIN_ONLY, got %s', sqlerrm);
  end;

  perform set_config('request.jwt.claim.sub', admin::text, true);
  result  := public.clone_venue_map(src_map, target, 'Veľká hala · marec');
  new_map := (result ->> 'venue_map_id')::uuid;
  assert new_map <> src_map, 'the copy is its own plan';
  assert (result ->> 'seats')::int = 840,
    format('the copy reports what it copied, got %s', result ->> 'seats');
  assert (result ->> 'unpriced')::int = 0,
    'every sector found a ticket type of the same name on the new event';
  assert (select venue_map_id from public.events where id = target) = new_map,
    'and it is attached to the new event';

  select count(*) into n from public.venue_sections where venue_map_id = new_map;
  assert n = (select count(*) from public.venue_sections where venue_map_id = src_map),
    'every sector comes across';

  select count(*) into n
  from public.venue_seats vs join public.venue_sections s on s.id = vs.venue_section_id
  where s.venue_map_id = new_map;
  assert n = 840, format('four stands of 200 and 40 VIP seats, got %s', n);

  -- Matched by name, to THIS event's types — and at this event's prices.
  select s.name, tt.name as type_name, tt.price_cents, tt.event_id into sect
  from public.venue_sections s
  join public.ticket_types tt on tt.id = s.ticket_type_id
  where s.venue_map_id = new_map and s.name = 'VIP';

  assert sect.type_name = 'VIP', 'VIP finds VIP';
  assert sect.event_id = target, 'on the new event';
  assert sect.price_cents = 9500, format('at the new price, got %s', sect.price_cents);
  raise notice 'PASS klonovanie napáruje sektory na typy vstupeniek podľa názvu, nie podľa poradia';

  -- A landmark never picks up a ticket type, whatever its name happens to be.
  assert (select ticket_type_id from public.venue_sections
          where venue_map_id = new_map and kind = 'stage') is null,
    'the stage comes across as a stage';
  raise notice 'PASS pódium sa skopíruje ako pódium, nie ako tovar';

  -- And it cannot be dropped on an event that already has one.
  begin
    result := public.clone_venue_map(src_map, target);
    assert false, 'the event already has a plan';
  exception when others then
    assert sqlerrm = 'EVENT_ALREADY_HAS_PLAN',
      format('expected EVENT_ALREADY_HAS_PLAN, got %s', sqlerrm);
  end;
  raise notice 'PASS klon neprepíše plán, ktorý na evente už je';
end $$;


-- ============================================================================
-- 7. A predať sa to dá — celou cestou, aj z VIP lóže
-- ============================================================================
do $$
declare
  buyer uuid := 'a4242424-0000-0000-0000-000000000003';
  ev    uuid := 'e4242424-0000-0000-0000-000000000001';
  vip   uuid;
  seat  uuid;
  co    public.checkouts;
  tick  public.tickets;
begin
  select s.id into vip from public.venue_sections s
  join public.venue_maps m on m.id = s.venue_map_id
  where m.id = 'f4242424-0000-0000-0000-000000000001' and s.name = 'VIP lóža ľavá';

  select vs.id into seat from public.venue_seats vs
  where vs.venue_section_id = vip and vs.row_label = 'A' and vs.seat_number = 3;

  perform set_config('request.jwt.claim.sub', buyer::text, true);
  perform public.cart_hold_seat(seat);

  co := public.create_checkout(buyer, null);
  perform public.fulfill_checkout(co.id, 'stripe', 'pi_vip_42', co.total_cents);

  select * into tick from public.tickets t where t.event_id = ev and t.buyer_id = buyer limit 1;
  assert tick.venue_seat_id = seat, 'the ticket names the VIP seat';
  assert tick.price_cents = 6000, format('at the VIP price, got %s', tick.price_cents);
  raise notice 'PASS VIP lóža sa predá za VIP cenu a miesto zostane na vstupenke';

  -- And the door list says where they are sitting, in VIP words.
  perform set_config('request.jwt.claim.sub', 'a4242424-0000-0000-0000-000000000002', true);
  assert (select h.seat_label from public.event_ticket_holders(ev) h
          where h.seat_label is not null limit 1) like 'VIP lóža ľavá · rad A, miesto 3',
    'and the door list says so';
  raise notice 'PASS pri vchode je vidno, že sedí vo VIP lóži, rad A, miesto 3';
end $$;

rollback;
