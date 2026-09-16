-- ============================================================================
-- BLUP test 30 · Switching a ticket off, and the list behind the numbers
-- ============================================================================
-- What must hold: an organizer can void one ticket and the door then refuses
-- it; they can switch it back on; a stranger can do neither and cannot see the
-- names, addresses and codes of the people who are coming.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'navstevnik@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@blup.test');

update public.profiles set username = 'navstevnik', display_name = 'Jana Nováková'
where id = '11111111-1111-1111-1111-111111111111';

insert into public.organizations (id, slug, name, created_by, verification_status)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'verified');

insert into public.organization_members (organization_id, user_id, role)
values ('bbbbbbb1-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'owner')
on conflict do nothing;

insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, end_at, is_free, price_cents)
values ('aaaaaaa1-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
        'bbbbbbb1-0000-0000-0000-000000000001', 'Nova Warehouse', 'techno',
        48.1550, 17.1200, now() + interval '10 days', now() + interval '10 days 6 hours',
        false, 2500);

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total, max_per_order)
values ('ccccccc1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000002',
        'Standard', 2500, 'EUR', 10, 4);

-- One ticket to an account, one to an address nobody has registered yet.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform public.issue_comp_tickets('ccccccc1-0000-0000-0000-000000000001', '@navstevnik', 1, null);
  perform public.issue_comp_tickets('ccccccc1-0000-0000-0000-000000000001',
                                    'host@blup.test', 1, null, 'Peter Hosť');
  reset role;
end $$;

-- --- the list shows who is actually coming -----------------------------------
do $$
declare
  rows_seen integer;
  r         record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select count(*) into rows_seen
  from public.event_ticket_holders('aaaaaaa1-0000-0000-0000-000000000002');
  assert rows_seen = 2, format('expected 2 holders, got %s', rows_seen);

  select * into r from public.event_ticket_holders('aaaaaaa1-0000-0000-0000-000000000002')
  where not is_guest;
  assert r.holder_name = 'Jana Nováková', format('real name, got %s', r.holder_name);
  assert r.email = 'navstevnik@blup.test', format('the address it went to, got %s', r.email);
  assert r.code like 'BLP-%', 'and the code on the ticket';
  assert r.ticket_type = 'Standard', 'with the ticket type it belongs to';

  select * into r from public.event_ticket_holders('aaaaaaa1-0000-0000-0000-000000000002')
  where is_guest;
  assert r.holder_name = 'Peter Hosť', format('guest name, got %s', r.holder_name);
  assert r.email = 'host@blup.test', format('guest address, got %s', r.email);

  -- and the search finds a person by the address, not only by name
  select count(*) into rows_seen
  from public.event_ticket_holders('aaaaaaa1-0000-0000-0000-000000000002', 'host@');
  assert rows_seen = 1, format('search by address, got %s', rows_seen);

  reset role;
  raise notice 'PASS the door list carries names, addresses and codes';
end $$;

-- --- and nobody else may read it --------------------------------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.event_ticket_holders('aaaaaaa1-0000-0000-0000-000000000002');
  exception when others then failed := true;
  end;
  assert failed, 'a stranger must not read other people''s names and addresses';
  reset role;
  raise notice 'PASS the list is closed to everybody but the organizer';
end $$;

-- --- switching a ticket off actually closes the door -------------------------
do $$
declare
  t      public.tickets;
  result jsonb;
  before integer;
begin
  select * into t from public.tickets
  where buyer_id = '11111111-1111-1111-1111-111111111111' limit 1;
  before := (select tickets_sold from public.events
             where id = 'aaaaaaa1-0000-0000-0000-000000000002');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select * into t from public.set_ticket_active(t.id, false, 'Vstupenka bola preposlaná ďalej');
  assert t.status = 'cancelled', format('expected cancelled, got %s', t.status);
  assert t.deactivated_at is not null, 'when it happened is recorded';
  assert t.deactivated_by = '22222222-2222-2222-2222-222222222222', 'and by whom';
  assert t.deactivation_reason = 'Vstupenka bola preposlaná ďalej', 'and why';

  -- the real test: the scanner refuses it
  select public.check_in_ticket(t.code, t.qr_secret) into result;
  assert (result ->> 'ok')::boolean is false,
    format('a deactivated ticket must not scan, got %s', result);
  assert result ->> 'reason' = 'CANCELLED', format('got reason %s', result ->> 'reason');

  reset role;

  assert (select tickets_sold from public.events
          where id = 'aaaaaaa1-0000-0000-0000-000000000002') = before - 1,
    'a ticket that cannot be used is not a person in the room';

  raise notice 'PASS deactivating a ticket stops it at the door';
end $$;

-- --- and switching it back on re-opens it ------------------------------------
do $$
declare
  t      public.tickets;
  result jsonb;
begin
  select * into t from public.tickets
  where buyer_id = '11111111-1111-1111-1111-111111111111' limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select * into t from public.set_ticket_active(t.id, true);
  assert t.status = 'valid', format('expected valid, got %s', t.status);
  assert t.deactivated_at is null and t.deactivation_reason is null,
    'the deactivation is cleared, not left hanging';

  select public.check_in_ticket(t.code, t.qr_secret) into result;
  assert (result ->> 'ok')::boolean, format('it must scan again, got %s', result);

  -- scanned once, refused the second time — reactivation did not break that
  select public.check_in_ticket(t.code, t.qr_secret) into result;
  assert result ->> 'reason' = 'ALREADY_USED', format('got %s', result ->> 'reason');

  reset role;
  raise notice 'PASS reactivating a ticket makes it work again, once';
end $$;

-- --- a stranger cannot void somebody's ticket --------------------------------
do $$
declare
  t      public.tickets;
  failed boolean := false;
begin
  select * into t from public.tickets
  where guest_email = 'host@blup.test' limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.set_ticket_active(t.id, false, 'lebo môžem');
  exception when others then failed := true;
  end;
  assert failed, 'only the people running the event may switch a ticket off';
  reset role;

  assert (select status from public.tickets where id = t.id) = 'valid',
    'and the ticket is untouched';
  raise notice 'PASS only the organizer may switch a ticket off';
end $$;

-- --- the optional reason must not swallow the authorization check ------------
-- The STRICT trap: a function declared STRICT returns null the moment any
-- argument is null, body and all. Called without a reason by a stranger, that
-- would look like success.
do $$
declare
  t      public.tickets;
  failed boolean := false;
begin
  select * into t from public.tickets where guest_email = 'host@blup.test' limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.set_ticket_active(t.id, false);
  exception when others then failed := true;
  end;
  assert failed, 'omitting the reason must not skip the check';
  reset role;
  raise notice 'PASS the optional reason does not bypass authorization';
end $$;

-- --- the summary above the list ----------------------------------------------
do $$
declare s jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select public.event_ticket_summary('aaaaaaa1-0000-0000-0000-000000000002') into s;
  assert (s ->> 'total')::int = 2, format('total, got %s', s ->> 'total');
  assert (s ->> 'used')::int = 1, format('used, got %s', s ->> 'used');
  assert (s ->> 'guests')::int = 1, format('guests, got %s', s ->> 'guests');
  assert (s ->> 'complimentary')::int = 2, format('comps, got %s', s ->> 'complimentary');

  reset role;
  raise notice 'PASS the summary counts what the list shows';
end $$;

rollback;
