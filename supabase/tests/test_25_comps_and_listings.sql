-- ============================================================================
-- BLUP test 25 · Complimentary tickets, and events listed on somebody's behalf
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'vyherca@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@blup.test'),
  ('44444444-4444-4444-4444-444444444444', 'admin@blup.test');

update public.profiles set username = 'vyherca'
where id = '11111111-1111-1111-1111-111111111111';
update public.profiles set app_role = 'admin'
where id = '44444444-4444-4444-4444-444444444444';

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
        'Standard', 2500, 'EUR', 4, 2);

-- --- a comp is a real ticket that cost nothing -------------------------------
do $$
declare
  issued integer;
  t      public.tickets;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select count(*) into issued from public.issue_comp_tickets(
    'ccccccc1-0000-0000-0000-000000000001', '@vyherca', 2, 'Výherca súťaže');
  assert issued = 2, format('expected 2 tickets, got %s', issued);

  select * into t from public.tickets
  where buyer_id = '11111111-1111-1111-1111-111111111111' limit 1;

  assert t.price_cents = 0, 'a comp is worth nothing';
  assert t.is_complimentary, 'and is marked as such';
  assert t.status = 'valid', 'it works at the door like any other';
  assert t.qr_secret is not null and t.code like 'BLP-%', 'same QR, same code shape';
  assert t.issued_by = '22222222-2222-2222-2222-222222222222', 'who gave it away is recorded';

  reset role;
  raise notice 'PASS a comp is a real ticket priced at zero';
end $$;

-- --- it takes a seat ---------------------------------------------------------
do $$
begin
  assert (select quantity_sold from public.ticket_types
          where id = 'ccccccc1-0000-0000-0000-000000000001') = 2,
    'a free ticket still occupies a place';
  assert (select tickets_sold from public.events
          where id = 'aaaaaaa1-0000-0000-0000-000000000002') = 2,
    'and shows in the event total';
  raise notice 'PASS a comp occupies a seat like any other ticket';
end $$;

-- --- but it is not revenue ---------------------------------------------------
-- The thing that must never happen: a giveaway quietly inflating the takings.
do $$
declare b record;
begin
  select * into b from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';

  assert b.gross_sales_cents = 0, format('comps are not sales, got %s', b.gross_sales_cents);
  assert b.balance_cents = 0, format('comps move no money, got %s', b.balance_cents);
  assert not exists (select 1 from public.ledger_entries
                     where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001'),
    'a comp writes nothing to the ledger';

  assert ((select public.event_comp_summary('aaaaaaa1-0000-0000-0000-000000000002'))->>'issued')::int = 2,
    'but they are counted, separately';
  raise notice 'PASS comps are counted separately and never as revenue';
end $$;

-- --- a comp cannot oversell the room -----------------------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    -- Four seats, two already given away.
    perform public.issue_comp_tickets('ccccccc1-0000-0000-0000-000000000001', '@vyherca', 3);
    raise exception 'issuing past capacity should have been refused';
  exception when others then
    assert sqlerrm like '%SOLD_OUT%', format('expected SOLD_OUT, got %s', sqlerrm);
  end;
  reset role;
  raise notice 'PASS a giveaway cannot oversell the room';
end $$;

-- --- by e-mail works too, and an unknown recipient says so --------------------
do $$
declare issued integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select count(*) into issued from public.issue_comp_tickets(
    'ccccccc1-0000-0000-0000-000000000001', 'vyherca@blup.test', 1);
  assert issued = 1, 'the sign-up address finds them too';

  -- Neither a username nor an address is not a recipient at all.
  begin
    perform public.issue_comp_tickets(
      'ccccccc1-0000-0000-0000-000000000001', 'nikto', 1);
    raise exception 'a recipient that is neither should have been refused';
  exception when others then
    assert sqlerrm like '%RECIPIENT_NOT_FOUND%', format('expected RECIPIENT_NOT_FOUND, got %s', sqlerrm);
  end;

  reset role;
  raise notice 'PASS a comp goes by @username or sign-up e-mail, and refuses what is neither';
end $$;

-- --- a stranger cannot give away somebody else's tickets ---------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.issue_comp_tickets('ccccccc1-0000-0000-0000-000000000001', '@vyherca', 1);
    raise exception 'a stranger issuing comps should have been refused';
  exception when others then
    assert sqlerrm like '%NOT_AUTHORIZED%', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;
  reset role;
  raise notice 'PASS only the organizer can give tickets away';
end $$;

-- --- listings ----------------------------------------------------------------
do $$
begin
  -- A user cannot dress their own event up as one BLUP added.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    insert into public.events (creator_id, title, category, latitude, longitude,
                               start_at, is_free, listed_by_platform, external_organizer_name)
    values ('22222222-2222-2222-2222-222222222222', 'Podvrh', 'techno', 48.1, 17.1,
            now() + interval '5 days', true, true, 'Niekto iný');
    raise exception 'a user marking their own event as BLUP-listed should have been refused';
  exception when others then
    assert sqlerrm like '%NOT_AUTHORIZED%', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;
  reset role;
  raise notice 'PASS only staff can list an event on somebody else''s behalf';
end $$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);

  -- A listing must name whose event it is. Anonymous would read as BLUP's own.
  begin
    insert into public.events (creator_id, title, category, latitude, longitude,
                               start_at, is_free, listed_by_platform)
    values ('44444444-4444-4444-4444-444444444444', 'Bez mena', 'techno', 48.1, 17.1,
            now() + interval '5 days', true, true);
    raise exception 'a nameless listing should have been refused';
  exception when others then
    assert sqlerrm like '%events_listing_names_organizer%',
      format('expected the naming constraint, got %s', sqlerrm);
  end;

  insert into public.events (id, creator_id, title, category, latitude, longitude,
                             start_at, end_at, is_free, listed_by_platform,
                             external_organizer_name, external_source_url)
  values ('aaaaaaa1-0000-0000-0000-00000000ab01', '44444444-4444-4444-4444-444444444444',
          'Koncert v Nitre', 'koncert', 48.3, 18.08,
          now() + interval '20 days', now() + interval '20 days 4 hours', true, true,
          'Kultúrne centrum Nitra', 'https://example.sk/koncert');

  reset role;
  raise notice 'PASS a listing has to say whose event it is';
end $$;

-- --- claiming ----------------------------------------------------------------
do $$
declare c public.event_claims;
begin
  set local role authenticated;

  -- A stranger with no organization cannot claim it.
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  begin
    perform public.claim_event('aaaaaaa1-0000-0000-0000-00000000ab01',
                               'bbbbbbb1-0000-0000-0000-000000000001');
    raise exception 'claiming for an organization you do not run should have been refused';
  exception when others then
    assert sqlerrm like '%NOT_AUTHORIZED%', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;

  -- The organizer claims it. Nothing moves yet.
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  c := public.claim_event('aaaaaaa1-0000-0000-0000-00000000ab01',
                          'bbbbbbb1-0000-0000-0000-000000000001', 'Je to naša akcia');
  assert c.status = 'pending', 'a claim is a request, not a transfer';
  assert (select organization_id from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000ab01') is null,
    'the event has not moved on the strength of somebody clicking a button';

  -- Clicking twice does not open a second claim.
  perform public.claim_event('aaaaaaa1-0000-0000-0000-00000000ab01',
                             'bbbbbbb1-0000-0000-0000-000000000001');
  assert (select count(*) from public.event_claims
          where event_id = 'aaaaaaa1-0000-0000-0000-00000000ab01') = 1,
    'a second click does not open a second claim';

  -- Only an admin decides.
  begin
    perform public.decide_event_claim(c.id, true);
    raise exception 'an organizer approving their own claim should have been refused';
  exception when others then
    assert sqlerrm like '%NOT_AUTHORIZED%', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;

  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  perform public.decide_event_claim(c.id, true, 'Overené telefonicky');

  reset role;

  assert (select organization_id from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000ab01')
         = 'bbbbbbb1-0000-0000-0000-000000000001',
    'approving hands the event over';
  assert not (select listed_by_platform from public.events
              where id = 'aaaaaaa1-0000-0000-0000-00000000ab01'),
    'and it stops being a BLUP listing';
  assert (select external_organizer_name from public.events
          where id = 'aaaaaaa1-0000-0000-0000-00000000ab01') is null,
    'the stand-in attribution goes with it';

  raise notice 'PASS an event is claimed by request and handed over by a human';
end $$;

rollback;
