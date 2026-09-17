-- ============================================================================
-- BLUP test 41 · Dôvody prísť, a dôvod priviesť niekoho
-- ============================================================================
-- Both of these exist to produce a lot of people and a lot of e-mail, so both
-- of them are worth exactly as much as their abuse rules. What is proved here:
--
--   · a sold-out ticket takes waitlist entries, from accounts and from guests
--   · nobody is told about a ticket that is not there
--   · never more people are told than there are tickets
--   · being told and not buying puts you back in the queue, not out of it
--   · the queue is nobody's mailing list — not even the organizer's
--   · an invite pays nothing for a signup, and something for a person
--   · your own code, a second code, a late code and your own address all fail
--   · ten rewards a month, per inviter
-- ============================================================================
\set ON_ERROR_STOP on

begin;

-- citext lives in `extensions`; a test block declares variables of that type.
set local search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4141414-0000-0000-0000-000000000001', 'org41@example.com',   now(), '{"display_name":"Org"}'),
  ('a4141414-0000-0000-0000-000000000002', 'first41@example.com', now(), '{"display_name":"Prvá"}'),
  ('a4141414-0000-0000-0000-000000000003', 'secnd41@example.com', now(), '{"display_name":"Druhý"}'),
  ('a4141414-0000-0000-0000-000000000004', 'third41@example.com', now(), '{"display_name":"Tretia"}'),
  ('a4141414-0000-0000-0000-000000000005', 'unconf41@example.com', null, '{"display_name":"Nepotvrdený"}');

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values ('d4141414-0000-0000-0000-000000000001', 'Divadlo 41', 'divadlo-41',
        'a4141414-0000-0000-0000-000000000001', 'verified', true);

insert into public.events (id, creator_id, organization_id, title, category, start_at,
                           latitude, longitude, is_free, price_cents, status)
values ('d4141414-0000-0000-0000-000000000002', 'a4141414-0000-0000-0000-000000000001',
        'd4141414-0000-0000-0000-000000000001', 'Vypredané', 'theatre',
        now() + interval '15 days', 48.1486, 17.1077, false, 2000, 'published');

-- Two tickets, both sold. This is the whole reason a waitlist exists.
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, quantity_sold, max_per_order)
values ('c4141414-0000-0000-0000-000000000001', 'd4141414-0000-0000-0000-000000000002',
        'Vstup', 2000, 2, 2, 10);

-- Seven more, all sold out. Only used by the throttle test: the rule is about
-- one address joining many different queues in an hour, which is what an
-- address-existence prober looks like — joining the same one twice is just a
-- person changing their mind, and the unique index already handles that.
insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, quantity_sold, max_per_order)
select ('c4141414-0000-0000-0000-00000000001' || i)::uuid,
       'd4141414-0000-0000-0000-000000000002',
       'Vstup ' || i, 2000, 1, 1, 10
from generate_series(0, 6) i;


-- ============================================================================
-- 1. Joining, as an account and as a guest
-- ============================================================================
do $$
declare
  tt    uuid := 'c4141414-0000-0000-0000-000000000001';
  first uuid := 'a4141414-0000-0000-0000-000000000002';
  res   jsonb;
  n     integer;
begin
  perform set_config('request.jwt.claim.sub', first::text, true);
  res := public.join_waitlist(tt, 2);
  assert (res ->> 'waiting')::int = 1, 'one person waiting';

  -- Asking twice is impatience, not a second place in the queue.
  res := public.join_waitlist(tt, 3);
  select count(*) into n from public.ticket_waitlist where ticket_type_id = tt;
  assert n = 1, format('one place per person, got %s', n);
  assert (select wanted from public.ticket_waitlist where ticket_type_id = tt) = 3,
    'and the second ask updates how many they want';
  raise notice 'PASS one place in the queue per person, updated rather than duplicated';

  -- A guest. They can buy a ticket here, so they can wait for one.
  perform set_config('request.jwt.claim.sub', '', true);
  res := public.join_waitlist(tt, 1, 'hostka41@example.com');
  assert (res ->> 'waiting')::int = 2, 'a guest can wait without an account';
  assert exists (select 1 from public.email_contacts where email = 'hostka41@example.com'),
    'and gets a contact row, so the mail can carry an unsubscribe';
  raise notice 'PASS a guest can join the queue with an address and nothing else';

  begin
    res := public.join_waitlist(tt, 1);
    assert false, 'a guest with no address is nobody to write to';
  exception when others then
    assert sqlerrm = 'INVALID_EMAIL', format('expected INVALID_EMAIL, got %s', sqlerrm);
  end;

  -- Six an hour from one address. Enough for a person, useless for a script
  -- working through a list of addresses to see which ones exist.
  for i in 0..5 loop
    perform public.join_waitlist(('c4141414-0000-0000-0000-00000000001' || i)::uuid, 1,
                                 'probe41@example.com');
  end loop;

  begin
    perform public.join_waitlist('c4141414-0000-0000-0000-000000000016', 1, 'probe41@example.com');
    assert false, 'the seventh queue in an hour, from one bare address, is refused';
  exception when others then
    assert sqlerrm = 'RATE_LIMITED', format('expected RATE_LIMITED, got %s', sqlerrm);
  end;

  -- The prober's rows would otherwise sit in the queue this test then reads.
  delete from public.ticket_waitlist where email = 'probe41@example.com';

  raise notice 'PASS a bare address is throttled, so the queue is not an address checker';
end $$;


-- ============================================================================
-- 2. Nobody is told about a ticket that is not there
-- ============================================================================
do $$
declare
  tt  uuid := 'c4141414-0000-0000-0000-000000000001';
  res jsonb;
  n   integer;
begin
  delete from public.email_deliveries;

  res := public.notify_waitlists();
  assert (res ->> 'queued')::int = 0,
    format('a sold-out ticket type mails nobody, got %s', res ->> 'queued');
  raise notice 'PASS a full house sends no "it is available!" mail';

  -- now() is the transaction's clock, so every row this test wrote carries the
  -- same instant. In life each join is its own transaction and the order is
  -- real; here it has to be said out loud.
  update public.ticket_waitlist set created_at = now() - interval '10 minutes'
  where ticket_type_id = tt and user_id is not null;
  update public.ticket_waitlist set created_at = now() - interval '5 minutes'
  where ticket_type_id = tt and user_id is null;

  -- One ticket comes back — a refund, a cancelled order.
  update public.ticket_types set quantity_sold = 1 where id = tt;

  res := public.notify_waitlists();
  assert (res ->> 'queued')::int = 1,
    format('one ticket, one person told; got %s', res ->> 'queued');

  select count(*) into n from public.email_deliveries where kind = 'waitlist_open';
  assert n = 1, 'and exactly one mail is queued';
  assert (select to_email from public.email_deliveries where kind = 'waitlist_open')
         = 'first41@example.com',
    'and it goes to whoever asked first';
  raise notice 'PASS one free ticket tells one person, and it is the one who asked first';

  -- Running it again changes nothing: they have already been told.
  res := public.notify_waitlists();
  assert (res ->> 'queued')::int = 0, 'nobody is told twice about the same ticket';
  raise notice 'PASS the cron can run every minute without mailing anybody twice';
end $$;


-- ============================================================================
-- 3. Told and did not buy: back in the queue, not out of it
-- ============================================================================
do $$
declare
  tt  uuid := 'c4141414-0000-0000-0000-000000000001';
  res jsonb;
begin
  delete from public.email_deliveries;

  -- Six hours later, and they never came back.
  update public.ticket_waitlist
  set notified_at = now() - interval '7 hours'
  where email is null or user_id is not null;

  res := public.notify_waitlists();
  assert (res ->> 'queued')::int >= 1,
    'a person who missed one release is still in the queue';
  raise notice 'PASS missing one mail is not being removed from the list';
end $$;


-- ============================================================================
-- 4. The queue is nobody's mailing list
-- ============================================================================
do $$
declare
  org   uuid := 'a4141414-0000-0000-0000-000000000001';
  first uuid := 'a4141414-0000-0000-0000-000000000002';
  n     integer;
begin
  perform set_config('request.jwt.claim.sub', org::text, true);
  perform set_config('role', 'authenticated', true);

  select count(*) into n from public.ticket_waitlist;
  assert n = 0,
    format('not even the organizer reads the queue through RLS, got %s rows', n);

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', first::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.ticket_waitlist;
  assert n = 1, format('you see your own place and nothing else, got %s', n);

  perform set_config('role', 'postgres', true);
  raise notice 'PASS the waiting list is not readable by the organizer or anybody else';

  -- The public number is a count, not a list.
  assert public.waitlist_size('c4141414-0000-0000-0000-000000000001') >= 2,
    'the count is public, because it is what makes somebody join';
  raise notice 'PASS "40 people want this" is public; who they are is not';
end $$;


-- ============================================================================
-- 5. An invite pays for a person, not for a signup
-- ============================================================================
do $$
declare
  first  uuid := 'a4141414-0000-0000-0000-000000000002';
  secnd  uuid := 'a4141414-0000-0000-0000-000000000003';
  third  uuid := 'a4141414-0000-0000-0000-000000000004';
  unconf uuid := 'a4141414-0000-0000-0000-000000000005';
  ev     uuid := 'd4141414-0000-0000-0000-000000000002';
  code   text;
  res    jsonb;
  xp_before integer;
begin
  perform set_config('request.jwt.claim.sub', first::text, true);
  code := public.my_invite_code();
  assert char_length(code) = 8, format('a short, readable code; got %s', code);
  assert public.my_invite_code() = code, 'and the same one every time';

  -- Your own code.
  begin
    res := public.claim_invite(code);
    assert false, 'inviting yourself is not a referral';
  exception when others then
    assert sqlerrm = 'INVITE_SELF', format('expected INVITE_SELF, got %s', sqlerrm);
  end;

  perform set_config('request.jwt.claim.sub', secnd::text, true);
  res := public.claim_invite(code);
  assert res ->> 'inviter' = 'Prvá', 'the code names who invited them';

  -- A second code, after the first.
  begin
    res := public.claim_invite(code);
    assert false, 'one invite per person, ever';
  exception when others then
    assert sqlerrm = 'INVITE_ALREADY_USED', format('expected INVITE_ALREADY_USED, got %s', sqlerrm);
  end;
  raise notice 'PASS a code cannot invite you twice, and cannot invite you to yourself';

  -- Nothing is paid for the signup itself.
  res := public.qualify_invites();
  assert (res ->> 'rewarded')::int = 0,
    format('a signup on its own is worth nothing, got %s', res ->> 'rewarded');
  raise notice 'PASS making an account earns the inviter nothing at all';

  -- Now they actually buy a ticket.
  select coalesce(sum(amount), 0) into xp_before from public.xp_awards where user_id = first;

  insert into public.tickets (event_id, ticket_type_id, buyer_id, code, qr_secret, status, price_cents)
  values (ev, 'c4141414-0000-0000-0000-000000000001', secnd, 'BLP-INV-41', 'z', 'valid', 2000);

  res := public.qualify_invites();
  assert (res ->> 'rewarded')::int = 1,
    format('a person who turned up is worth something, got %s', res ->> 'rewarded');

  assert (select coalesce(sum(amount), 0) from public.xp_awards where user_id = first) > xp_before,
    'and the inviter is paid';
  assert exists (select 1 from public.xp_awards where user_id = secnd and kind = 'friend_invited'),
    'and so is the person who came';
  raise notice 'PASS the reward lands when somebody real arrives, and both sides get it';

  -- And only once.
  res := public.qualify_invites();
  assert (res ->> 'rewarded')::int = 0, 'an invite is paid once';
  raise notice 'PASS an invite cannot be paid twice';

  -- A late code.
  perform set_config('request.jwt.claim.sub', third::text, true);
  update public.profiles set created_at = now() - interval '30 days' where id = third;
  begin
    res := public.claim_invite(code);
    assert false, 'a month-old account is not a referral';
  exception when others then
    assert sqlerrm = 'INVITE_TOO_LATE', format('expected INVITE_TOO_LATE, got %s', sqlerrm);
  end;
  raise notice 'PASS a code is for somebody arriving, not for somebody already here';

  -- Unconfirmed address: invited, but not paid for.
  update public.profiles set created_at = now() where id = unconf;
  perform set_config('request.jwt.claim.sub', unconf::text, true);
  res := public.claim_invite(code);
  insert into public.tickets (event_id, ticket_type_id, buyer_id, code, qr_secret, status, price_cents)
  values (ev, 'c4141414-0000-0000-0000-000000000001', unconf, 'BLP-INV-42', 'y', 'valid', 2000);

  res := public.qualify_invites();
  assert (res ->> 'rewarded')::int = 0,
    'an address nobody has confirmed is an address nobody has';
  raise notice 'PASS an unconfirmed address earns nothing, however much it buys';
end $$;


-- ============================================================================
-- 6. Ten a month, per inviter
-- ============================================================================
do $$
declare
  first uuid := 'a4141414-0000-0000-0000-000000000002';
  ev    uuid := 'd4141414-0000-0000-0000-000000000002';
  code  text;
  new_id uuid;
  res   jsonb;
  paid  integer;
begin
  perform set_config('request.jwt.claim.sub', first::text, true);
  select invite_code into code from public.profiles where id = first;

  -- Room for the tickets the farm is about to buy. The house being sold out is
  -- what sections 1 to 3 were about; this section is about the invite ceiling.
  update public.ticket_types set quantity_total = 100
  where id = 'c4141414-0000-0000-0000-000000000001';

  -- Twelve more accounts, all of which buy something. A script's best day.
  for i in 1..12 loop
    new_id := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
    values (new_id, 'farm' || i || '41@example.com', now(),
            ('{"display_name":"Farm ' || i || '"}')::jsonb);

    perform set_config('request.jwt.claim.sub', new_id::text, true);
    perform public.claim_invite(code);

    insert into public.tickets (event_id, ticket_type_id, buyer_id, code, qr_secret, status, price_cents)
    values (ev, 'c4141414-0000-0000-0000-000000000001', new_id,
            'BLP-FARM-' || i, 'q' || i, 'valid', 2000);
  end loop;

  res := public.qualify_invites();

  select count(*) into paid
  from public.invites
  where inviter_id = first and rewarded_at > now() - interval '30 days';

  assert paid = 10, format('ten rewards in thirty days, got %s', paid);
  raise notice 'PASS a script hits the monthly ceiling on its first morning';

  -- The invites themselves are kept: the people are real even when the reward
  -- is spent, and deleting them would let the same trick run again tomorrow.
  assert (select count(*) from public.invites where inviter_id = first) = 14,
    'the unpaid invites are kept, not thrown away';
  raise notice 'PASS what is capped is the reward, not the record';
end $$;

rollback;
