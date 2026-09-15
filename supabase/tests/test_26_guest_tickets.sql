-- ============================================================================
-- BLUP test 26 · A ticket for somebody who is not on BLUP
-- ============================================================================
-- The case this exists for: the winner of a competition has an e-mail address
-- and no reason to have heard of us. The QR has to work at the door before they
-- ever make an account, and the ticket has to find them if they later do.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'stranger@blup.test');

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
        'Standard', 2500, 'EUR', 10, 2);

-- --- issuing to an address nobody has an account for -------------------------
do $$
declare
  issued integer;
  t      public.tickets;
  o      public.orders;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  select count(*) into issued from public.issue_comp_tickets(
    'ccccccc1-0000-0000-0000-000000000001', 'Vyherca@Example.COM', 2,
    'Výherca súťaže na Instagrame', 'Jana Nováková');
  assert issued = 2, format('expected 2 tickets, got %s', issued);

  reset role;

  select * into t from public.tickets where guest_email = 'vyherca@example.com' limit 1;
  assert t.buyer_id is null, 'nobody owns it yet';
  assert t.guest_email = 'vyherca@example.com', 'the address is stored folded to lower case';
  assert t.guest_name = 'Jana Nováková', 'and the name they will see on it';
  assert t.qr_secret is not null and t.code like 'BLP-%', 'it is a normal ticket';
  assert t.status = 'valid', 'and a valid one';

  select * into o from public.orders where id = t.order_id;
  assert o.claim_token is not null, 'a guest order carries a claim token for the e-mail';
  assert o.buyer_id is null, 'the order has no owner either';

  raise notice 'PASS a comp can go to an address with no account behind it';
end $$;

-- --- the e-mail is the only copy they have, so it must be queued -------------
do $$
declare d public.email_deliveries;
begin
  select * into d from public.email_deliveries
  where order_id = (select order_id from public.tickets
                    where guest_email = 'vyherca@example.com' limit 1);

  assert found, 'a guest ticket must be e-mailed — there is no app to open';
  assert d.to_email = 'vyherca@example.com', format('wrong address: %s', d.to_email);
  assert d.user_id is null, 'there is no user to attribute it to';

  assert (public.ticket_email_payload(d.order_id)->>'is_guest')::boolean,
    'the payload tells the template this one needs a claim link';
  assert public.ticket_email_payload(d.order_id)->>'claim_token' is not null,
    'and gives it the token';
  assert public.ticket_email_payload(d.order_id)->>'buyer_name' = 'Jana Nováková',
    'addressed to the name the organizer typed, not "Host"';

  raise notice 'PASS the ticket is e-mailed, with a claim link in it';
end $$;

-- --- it works at the door, with no account anywhere in sight ------------------
do $$
declare
  t      public.tickets;
  result jsonb;
begin
  select * into t from public.tickets where guest_email = 'vyherca@example.com' limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  result := public.check_in_ticket(t.code, t.qr_secret);
  assert (result->>'ok')::boolean, format('the scanner must accept it: %s', result->>'reason');

  -- And exactly once, like every other ticket.
  result := public.check_in_ticket(t.code, t.qr_secret);
  assert not (result->>'ok')::boolean, 'a second scan is refused';
  reset role;

  raise notice 'PASS the QR works at the door before any account exists';
end $$;

-- --- a stranger cannot see somebody else's guest ticket ----------------------
do $$
declare visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);

  select count(*) into visible from public.tickets where guest_email = 'vyherca@example.com';
  assert visible = 0, 'a guest ticket is not readable by just anyone signed in';

  reset role;
  raise notice 'PASS a guest ticket is not public just because it has no owner';
end $$;

-- --- signing up with that address collects it --------------------------------
do $$
declare mine integer;
begin
  insert into auth.users (id, email)
  values ('55555555-5555-5555-5555-555555555555', 'vyherca@example.com');

  select count(*) into mine from public.tickets
  where buyer_id = '55555555-5555-5555-5555-555555555555';
  assert mine = 2, format('both tickets should have moved across, got %s', mine);

  assert (select count(*) from public.tickets
          where guest_email = 'vyherca@example.com') = 0,
    'and stop being guest tickets';
  assert (select buyer_id from public.orders
          where event_id = 'aaaaaaa1-0000-0000-0000-000000000002'
            and provider = 'manual' limit 1)
         = '55555555-5555-5555-5555-555555555555',
    'the order moves with them';
  assert exists (select 1 from public.event_attendees
                 where event_id = 'aaaaaaa1-0000-0000-0000-000000000002'
                   and user_id = '55555555-5555-5555-5555-555555555555'),
    'and they are marked as going';

  raise notice 'PASS signing up with that address hands the ticket over';
end $$;

-- --- the claim link, for somebody who signed up with a different address ------
do $$
declare
  o      public.orders;
  result jsonb;
  token  text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform public.issue_comp_tickets(
    'ccccccc1-0000-0000-0000-000000000001', 'druhy@example.com', 1, null, 'Peter');
  reset role;

  select * into o from public.orders where guest_email = 'druhy@example.com';
  token := o.claim_token;
  assert token is not null, 'there is a token to use';

  -- Somebody signed in under a completely different address follows the link.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  result := public.claim_tickets_with_token(token);
  assert (result->>'ok')::boolean, format('the token should work: %s', result->>'reason');
  assert (result->>'tickets')::int = 1, 'one ticket moved';

  assert (select buyer_id from public.orders where id = o.id)
         = '33333333-3333-3333-3333-333333333333',
    'the order is theirs now';

  -- A forwarded e-mail must not hand the same ticket to a second person.
  assert (select claim_token from public.orders where id = o.id) is null,
    'the token is spent once it is used';

  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.claim_tickets_with_token(token);
    raise exception 'a spent token should not work again';
  exception when others then
    assert sqlerrm like '%CLAIM_TOKEN_INVALID%', format('expected CLAIM_TOKEN_INVALID, got %s', sqlerrm);
  end;
  reset role;

  raise notice 'PASS the claim link works once, for whoever holds the e-mail';
end $$;

-- --- claiming after the fact, by address --------------------------------------
do $$
declare moved integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform public.issue_comp_tickets(
    'ccccccc1-0000-0000-0000-000000000001', 'organizer@blup.test', 1);
  reset role;

  -- That address does have an account, so it was never a guest ticket at all.
  assert (select count(*) from public.tickets where guest_email = 'organizer@blup.test') = 0,
    'an address we recognise gets an owned ticket, not a claim link';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  moved := public.claim_my_guest_tickets();
  assert moved = 0, 'there is nothing waiting for this address';
  reset role;

  raise notice 'PASS an address we already know skips the guest path entirely';
end $$;

rollback;
