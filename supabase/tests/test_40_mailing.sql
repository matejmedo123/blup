-- ============================================================================
-- BLUP test 40 · Sending a lot of mail without becoming spam
-- ============================================================================
-- The whole point of this machinery is volume, and volume is exactly what makes
-- every one of these rules matter. What is proved here:
--
--   · a guest address is not on a mailing list, and an account's is
--   · one click from a mail client stops the marketing, with no session
--   · a bounce or a complaint is final, and drops what is still queued
--   · a ticket never queues behind a four-thousand-address announcement
--   · the hourly budget is a ceiling, not a suggestion
--   · an organizer writes to their own customers and to nobody else
--   · pressing send twice does not mail anybody twice
--   · an unverified organization cannot mail from our domain at all
-- ============================================================================
\set ON_ERROR_STOP on

begin;

-- citext lives in `extensions`; a test block declares variables of that type.
set local search_path = public, extensions;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a4040404-0000-0000-0000-000000000001', 'org40@example.com',     '{"display_name":"Org"}'),
  ('a4040404-0000-0000-0000-000000000002', 'buyer40@example.com',   '{"display_name":"Buyer"}'),
  ('a4040404-0000-0000-0000-000000000003', 'other40@example.com',   '{"display_name":"Other"}'),
  ('a4040404-0000-0000-0000-000000000004', 'rival40@example.com',   '{"display_name":"Rival org"}');

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values
  ('d4040404-0000-0000-0000-000000000001', 'Klub 40', 'klub-40',
   'a4040404-0000-0000-0000-000000000001', 'verified', true),
  ('d4040404-0000-0000-0000-000000000002', 'Neoverení', 'neovereni-40',
   'a4040404-0000-0000-0000-000000000004', 'pending', false);

insert into public.events (id, creator_id, organization_id, title, category, start_at,
                           latitude, longitude, is_free, price_cents, status)
values ('d4040404-0000-0000-0000-000000000003', 'a4040404-0000-0000-0000-000000000001',
        'd4040404-0000-0000-0000-000000000001', 'Klubová noc', 'music',
        now() + interval '10 days', 48.1486, 17.1077, false, 1500, 'published');

insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
values ('c4040404-0000-0000-0000-000000000001', 'd4040404-0000-0000-0000-000000000003',
        'Vstup', 1500, 4, 10);


-- ============================================================================
-- 1. Consent belongs to the address, not the account
-- ============================================================================
do $$
declare
  guest  citext := 'hostka40@example.com';
  member citext := 'buyer40@example.com';
  c      public.email_contacts;
begin
  -- Signing up made a contact row, opted in: they have an account, they agreed
  -- to the terms, and they have a screen to change their mind on.
  select * into c from public.email_contacts where email = member;
  assert found, 'an account gets a contact row at signup';
  assert c.digest_opt_in, 'and starts opted in to the digest';
  assert c.user_id = 'a4040404-0000-0000-0000-000000000002', 'linked to the account';

  -- A guest who bought a ticket has agreed to nothing.
  c := public.ensure_email_contact(guest::text, null);
  assert not c.digest_opt_in, 'a guest address is not on a mailing list';
  raise notice 'PASS an account is opted in; a guest who bought one ticket is not';

  -- But their ticket still reaches them, and so does the waitlist they joined.
  assert public.can_email(guest::text, 'ticket'), 'a ticket is not marketing';
  assert public.can_email(guest::text, 'waitlist_open'), 'nor is the thing they asked for';
  assert not public.can_email(guest::text, 'digest'), 'the digest is';
  assert public.can_email(member::text, 'digest'), 'and an account gets it';
  raise notice 'PASS transactional mail is not gated on consent; marketing is';
end $$;


-- ============================================================================
-- 2. One click, from a mail client, with no session
-- ============================================================================
do $$
declare
  token text;
  ok    boolean;
begin
  select unsubscribe_token into token
  from public.email_contacts where email = 'buyer40@example.com';

  assert char_length(token) >= 40, 'the token is a bearer token, not a guessable id';

  -- Nobody is signed in. That is the entire scenario.
  perform set_config('request.jwt.claim.sub', '', true);
  ok := public.email_unsubscribe(token);
  assert ok, 'the link works with no account and no session';

  assert not public.can_email('buyer40@example.com', 'digest'),
    'and the digest stops';
  assert not public.can_email('buyer40@example.com', 'announcement'),
    'and so does every other marketing mail, from anybody';
  assert public.can_email('buyer40@example.com', 'ticket'),
    'their tickets still arrive — unsubscribing is not closing the account';
  raise notice 'PASS one click stops the marketing and leaves the tickets alone';

  assert not public.email_unsubscribe('nonsense-token-that-is-long-enough'),
    'a token that means nothing is simply false';
  assert not public.email_unsubscribe('short'), 'and so is a short one';
  raise notice 'PASS a bad token is refused without saying which kind of bad';

  -- Turning the digest back on takes back the blanket no, or the switch lies.
  perform set_config('request.jwt.claim.sub', 'a4040404-0000-0000-0000-000000000002', true);
  perform public.set_email_preferences(true);
  assert public.can_email('buyer40@example.com', 'digest'), 'and it can be turned back on';
  raise notice 'PASS the preference switch and the unsubscribe agree with each other';
end $$;


-- ============================================================================
-- 3. A bounce is final, and takes the queue with it
-- ============================================================================
do $$
declare
  dropped integer;
  n       integer;
begin
  perform public.ensure_email_contact('dead40@example.com', null);

  insert into public.email_deliveries (kind, to_email, subject)
  select 'announcement', 'dead40@example.com', 'x' from generate_series(1, 4);

  dropped := public.mark_email_undeliverable('dead40@example.com');
  assert dropped = 4, format('everything queued for a dead address is dropped, got %s', dropped);

  assert not public.can_email('dead40@example.com', 'announcement'), 'nothing marketing again';
  assert not public.can_email('dead40@example.com', 'ticket'),
    'and not a ticket either — the address does not exist';
  raise notice 'PASS a hard bounce stops everything and clears what was waiting';

  perform public.ensure_email_contact('angry40@example.com', null);
  perform public.mark_email_undeliverable('angry40@example.com', true);
  assert not public.can_email('angry40@example.com', 'ticket'),
    'a complaint is more final than a bounce: retrying is how a domain dies';
  raise notice 'PASS a spam complaint stops us writing to them at all';

  select count(*) into n from public.email_deliveries where to_email = 'dead40@example.com' and status = 'skipped';
  assert n = 4, 'the dropped rows are marked skipped, not deleted';
end $$;


-- ============================================================================
-- 4. A ticket never queues behind a blast
-- ============================================================================
do $$
declare
  claimed public.email_deliveries;
  first_kind text;
  n integer;
begin
  delete from public.email_deliveries;

  -- Two hundred announcements, queued an hour ago.
  insert into public.email_deliveries (kind, to_email, subject, created_at, next_attempt_at)
  select 'announcement', 'blast' || i || '@example.com', 'Newsletter',
         now() - interval '1 hour', now() - interval '1 hour'
  from generate_series(1, 200) i;

  -- And one ticket, bought thirty seconds ago.
  insert into public.email_deliveries (kind, to_email, subject)
  values ('ticket', 'urgent40@example.com', 'Tvoja vstupenka');

  select kind into first_kind from public.claim_email_deliveries(1);
  assert first_kind = 'ticket',
    format('the ticket goes first, not the oldest row; got %s', first_kind);
  raise notice 'PASS a ticket does not wait behind two hundred newsletters';
end $$;


-- ============================================================================
-- 5. The hourly budget is a ceiling
-- ============================================================================
do $$
declare
  n integer;
begin
  delete from public.email_deliveries;
  update public.platform_settings set email_per_hour = 50;

  -- Forty already gone this hour.
  insert into public.email_deliveries (kind, to_email, subject, status, sent_at)
  select 'announcement', 'sent' || i || '@example.com', 'x', 'sent', now() - interval '10 minutes'
  from generate_series(1, 40) i;

  insert into public.email_deliveries (kind, to_email, subject)
  select 'announcement', 'waiting' || i || '@example.com', 'x'
  from generate_series(1, 100) i;

  select count(*) into n from public.claim_email_deliveries(100);
  assert n = 10, format('only the ten left in the budget may go, got %s', n);
  raise notice 'PASS the hour''s budget is what goes out, however much is waiting';

  select count(*) into n from public.claim_email_deliveries(100);
  assert n = 0, 'and once it is spent, nothing';
  raise notice 'PASS a spent budget sends nothing rather than a little bit more';

  update public.platform_settings set email_per_hour = 500;
  delete from public.email_deliveries;
end $$;


-- ============================================================================
-- 6. An organizer writes to their own customers
-- ============================================================================
do $$
declare
  org    uuid := 'd4040404-0000-0000-0000-000000000001';
  rival  uuid := 'd4040404-0000-0000-0000-000000000002';
  ev     uuid := 'd4040404-0000-0000-0000-000000000003';
  me     uuid := 'a4040404-0000-0000-0000-000000000001';
  other  uuid := 'a4040404-0000-0000-0000-000000000003';
  camp   public.email_campaigns;
  n      integer;
  report jsonb;
begin
  -- One buyer with an account, one guest.
  insert into public.tickets (event_id, ticket_type_id, buyer_id, code, qr_secret, status, price_cents)
  values (ev, 'c4040404-0000-0000-0000-000000000001', 'a4040404-0000-0000-0000-000000000002',
          'BLP-C40-1', 'x1', 'valid', 1500);
  insert into public.tickets (event_id, ticket_type_id, buyer_id, guest_email, guest_name,
                              code, qr_secret, status, price_cents)
  values (ev, 'c4040404-0000-0000-0000-000000000001', null, 'hostka40@example.com', 'Hosťka',
          'BLP-C40-2', 'x2', 'valid', 1500);

  -- Somebody with an account who has nothing to do with this organizer.
  perform set_config('request.jwt.claim.sub', me::text, true);

  select count(*) into n from public.campaign_audience(org, 'ticket_holders', ev);
  assert n = 2, format('both buyers, account and guest; got %s', n);
  assert not exists (
    select 1 from public.campaign_audience(org, 'ticket_holders', ev) a
    where a.email = 'other40@example.com'
  ), 'and nobody who did not buy anything';
  raise notice 'PASS the audience is this organizer''s customers and nobody else';

  camp := public.send_campaign(org, 'ticket_holders', 'Zmena času',
    'Začíname o hodinu neskôr, o 21:00. Vstupenky platia bez zmeny.', ev);

  assert camp.recipients = 2, format('two recipients, got %s', camp.recipients);
  select count(*) into n from public.email_deliveries where campaign_id = camp.id;
  assert n = 2, 'and two deliveries';
  assert (select count(*) from public.email_deliveries
          where campaign_id = camp.id and unsubscribe_token is not null) = 2,
    'every one of them carrying an unsubscribe link';
  raise notice 'PASS the announcement goes out with a way to stop it';

  -- A second send of the same thing is the commonest mistake there is.
  camp := public.send_campaign(org, 'ticket_holders', 'Zmena času',
    'Začíname o hodinu neskôr, o 21:00. Vstupenky platia bez zmeny.', ev);
  select count(*) into n from public.email_deliveries where to_email = 'hostka40@example.com';
  assert n = 2, format('one per campaign, not four; got %s', n);
  raise notice 'PASS the same campaign cannot mail one address twice';

  report := public.campaign_report(camp.id);
  assert (report ->> 'recipients')::int = 2, 'the report counts what went out';

  -- Somebody else's organization.
  perform set_config('request.jwt.claim.sub', other::text, true);
  begin
    camp := public.send_campaign(org, 'ticket_holders', 'Ahoj', repeat('text ', 10), ev);
    assert false, 'a stranger must not mail somebody else''s customers';
  exception when others then
    assert sqlerrm = 'FORBIDDEN', format('expected FORBIDDEN, got %s', sqlerrm);
  end;
  begin
    report := public.campaign_report(camp.id);
    assert false, 'nor read their report';
  exception when others then
    assert sqlerrm = 'FORBIDDEN', format('expected FORBIDDEN, got %s', sqlerrm);
  end;
  raise notice 'PASS a campaign belongs to the organization that sent it';

  -- An unverified organization cannot mail from our domain at all.
  perform set_config('request.jwt.claim.sub', 'a4040404-0000-0000-0000-000000000004', true);
  begin
    camp := public.send_campaign(rival, 'past_attendees', 'Ahoj', repeat('text ', 10));
    assert false, 'an unverified organization must not send mail';
  exception when others then
    assert sqlerrm = 'ORGANIZATION_NOT_VERIFIED',
      format('expected ORGANIZATION_NOT_VERIFIED, got %s', sqlerrm);
  end;
  raise notice 'PASS an unverified organization cannot send from our domain';
end $$;


-- ============================================================================
-- 7. Someone who said no is not in the audience
-- ============================================================================
do $$
declare
  org uuid := 'd4040404-0000-0000-0000-000000000001';
  ev  uuid := 'd4040404-0000-0000-0000-000000000003';
  n   integer;
begin
  perform set_config('request.jwt.claim.sub', 'a4040404-0000-0000-0000-000000000001', true);

  perform public.email_unsubscribe(
    (select unsubscribe_token from public.email_contacts where email = 'hostka40@example.com'));

  select count(*) into n from public.campaign_audience(org, 'ticket_holders', ev);
  assert n = 1, format('the guest who said no is out of the audience, got %s', n);
  raise notice 'PASS an unsubscribe is honoured before the mail is written, not after';
end $$;


-- ============================================================================
-- 8. Three rozposlania a day, and then tomorrow
-- ============================================================================
do $$
declare
  org  uuid := 'd4040404-0000-0000-0000-000000000001';
  ev   uuid := 'd4040404-0000-0000-0000-000000000003';
  camp public.email_campaigns;
begin
  perform set_config('request.jwt.claim.sub', 'a4040404-0000-0000-0000-000000000001', true);

  -- Two already exist from section 6.
  camp := public.send_campaign(org, 'attendees', 'Tretie', repeat('slovo ', 10), ev);

  begin
    camp := public.send_campaign(org, 'attendees', 'Štvrté', repeat('slovo ', 10), ev);
    assert false, 'the fourth in a day is refused';
  exception when others then
    assert sqlerrm = 'TOO_MANY_CAMPAIGNS', format('expected TOO_MANY_CAMPAIGNS, got %s', sqlerrm);
  end;
  raise notice 'PASS three rozposlania a day is the limit, and it is about the reader';
end $$;

rollback;
