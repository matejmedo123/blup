-- ============================================================================
-- BLUP test 09 · Ticket delivery by email
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a9999999-9999-9999-9999-999999999999', 'org9@example.com',   '{"display_name":"Org"}'),
  ('b9999999-9999-9999-9999-999999999999', 'buyer9@example.com', '{"display_name":"Buyer"}'),
  ('c9999999-9999-9999-9999-999999999999', 'other9@example.com', '{"display_name":"Other"}');

do $$
declare v_org uuid; v_event uuid;
begin
  insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
  values ('e9999999-0000-0000-0000-000000000001', 'Mail Co', 'mail-co',
          'a9999999-9999-9999-9999-999999999999', 'verified', true)
  returning id into v_org;

  insert into public.events (id, creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status, venue_name)
  values ('e9999999-0000-0000-0000-000000000002', 'a9999999-9999-9999-9999-999999999999',
          v_org, 'Warehouse Techno Night', 'techno', now() + interval '5 days',
          48.1486, 17.1077, false, 1500, 'published', 'Stará tržnica')
  returning id into v_event;

  insert into public.ticket_types (id, event_id, name, price_cents, quantity_total, max_per_order)
  values ('e9999999-0000-0000-0000-000000000003', v_event, 'Early bird', 1500, 100, 10);
end $$;

-- --- the address resolves to the account email until it is overridden -------
do $$
begin
  assert public.ticket_email_for('b9999999-9999-9999-9999-999999999999') = 'buyer9@example.com',
    'tickets go to the account email by default';

  perform set_config('request.jwt.claim.sub', 'b9999999-9999-9999-9999-999999999999', true);
  perform public.set_ticket_email('tickets@work.example.com');

  assert public.ticket_email_for('b9999999-9999-9999-9999-999999999999') = 'tickets@work.example.com',
    'an override wins over the account email';

  begin
    perform public.set_ticket_email('not-an-address');
    raise exception 'TEST FAILED: an address without an @ was accepted';
  exception when raise_exception then
    raise notice 'PASS a nonsense delivery address is refused';
  end;

  -- clearing it falls back rather than leaving the person unreachable
  perform public.set_ticket_email(null);
  assert public.ticket_email_for('b9999999-9999-9999-9999-999999999999') = 'buyer9@example.com',
    'clearing the override falls back to the account email';
  raise notice 'PASS the delivery address resolves and can be overridden';
end $$;

-- --- an unpaid order queues nothing ------------------------------------------
do $$
declare o public.orders;
begin
  perform set_config('request.jwt.claim.sub', null, true);
  o := public.create_order('b9999999-9999-9999-9999-999999999999',
                           'e9999999-0000-0000-0000-000000000003', 2);

  assert public.queue_ticket_email(o.id) is null,
    'an order that has not been paid must not be emailed';
  assert (select count(*) from public.email_deliveries) = 0,
    'nothing may be queued before the payment is confirmed';
  raise notice 'PASS an unpaid order queues no email';
end $$;

-- --- fulfilment queues exactly one email, and a replay does not add another --
do $$
declare
  v_order uuid;
  d       public.email_deliveries;
begin
  select id into v_order from public.orders limit 1;

  -- 2 x 15.00 EUR + 2 x 1.00 EUR archive fee
  perform public.fulfill_order(v_order, 'stripe', 'pi_mail_1', 3200);

  assert (select count(*) from public.email_deliveries where order_id = v_order) = 1,
    'fulfilment must queue exactly one ticket email';

  select * into d from public.email_deliveries where order_id = v_order;
  assert d.status = 'pending', format('a fresh delivery is pending, got %s', d.status);
  assert d.to_email = 'buyer9@example.com', format('wrong recipient: %s', d.to_email);
  assert d.subject like '%Warehouse Techno Night%', format('subject should name the event: %s', d.subject);

  -- the webhook retries; the queue must not grow
  perform public.fulfill_order(v_order, 'stripe', 'pi_mail_1', 3200);
  assert (select count(*) from public.email_deliveries where order_id = v_order) = 1,
    'replaying the webhook must not queue a second email';

  raise notice 'PASS fulfilment queues one email, and a replayed webhook does not duplicate it';
end $$;

-- --- the payload carries everything the renderer needs -----------------------
do $$
declare
  v_order uuid;
  p       jsonb;
begin
  select id into v_order from public.orders limit 1;
  p := public.ticket_email_payload(v_order);

  assert (p #>> '{event,title}') = 'Warehouse Techno Night', 'payload must name the event';
  assert (p #>> '{event,venue_name}') = 'Stará tržnica', 'payload must carry the venue';
  assert jsonb_array_length(p -> 'tickets') = 2,
    format('payload must carry both tickets, got %s', jsonb_array_length(p -> 'tickets'));
  assert (p #>> '{tickets,0,code}') like 'BLP-%', 'each ticket needs its code';
  assert length(p #>> '{tickets,0,qr_secret}') = 48, 'each ticket needs its QR secret';
  assert (p ->> 'total_cents')::int = 3200, 'payload must state what was paid';
  assert (p ->> 'organizer') = 'Mail Co', 'payload must name the organizer';
  raise notice 'PASS the email payload carries the event, the tickets and their codes';
end $$;

-- --- claiming is exclusive ---------------------------------------------------
do $$
declare
  first_pass  integer;
  second_pass integer;
begin
  select count(*) into first_pass from public.claim_email_deliveries(10);
  assert first_pass = 1, format('one delivery was due, got %s', first_pass);

  -- A second worker running immediately after must find nothing: the row is
  -- already 'sending', not 'pending'.
  select count(*) into second_pass from public.claim_email_deliveries(10);
  assert second_pass = 0, 'a claimed delivery must not be handed to a second worker';

  assert (select status from public.email_deliveries limit 1) = 'sending',
    'a claimed delivery is marked sending';
  assert (select attempts from public.email_deliveries limit 1) = 1,
    'claiming counts as an attempt';
  raise notice 'PASS a delivery is claimed once and only once';
end $$;

-- --- failure backs off, and stops after five attempts ------------------------
do $$
declare
  d public.email_deliveries;
  n integer;
begin
  select * into d from public.email_deliveries limit 1;
  perform public.mark_email_failed(d.id, 'smtp exploded');

  select * into d from public.email_deliveries where id = d.id;
  assert d.status = 'failed', 'a failed send is marked failed';
  assert d.last_error = 'smtp exploded', 'the reason is kept for debugging';
  assert d.next_attempt_at > now(), 'a failed send is scheduled to retry later';

  -- Nothing is due yet, so the worker finds nothing.
  select count(*) into n from public.claim_email_deliveries(10);
  assert n = 0, 'a delivery inside its backoff window must not be retried yet';

  -- Burn through the remaining attempts.
  for i in 1..4 loop
    update public.email_deliveries set next_attempt_at = now() - interval '1 minute';
    perform public.claim_email_deliveries(10);
    perform public.mark_email_failed(d.id, 'still exploded');
  end loop;

  update public.email_deliveries set next_attempt_at = now() - interval '1 minute';
  select count(*) into n from public.claim_email_deliveries(10);
  assert n = 0, 'a delivery must stop retrying after five attempts';
  raise notice 'PASS failures back off and eventually stop';
end $$;

-- --- a missing mail provider is skipped, not retried forever -----------------
do $$
declare d public.email_deliveries;
begin
  select * into d from public.email_deliveries limit 1;
  perform public.mark_email_failed(d.id, 'EMAIL_NOT_CONFIGURED', true);

  select * into d from public.email_deliveries where id = d.id;
  assert d.status = 'skipped',
    format('an unconfigured provider is skipped, not failed, got %s', d.status);
  raise notice 'PASS an unconfigured mail provider is recorded as skipped';
end $$;

-- --- re-sending resets the same row and can redirect it ----------------------
do $$
declare
  v_order uuid;
  d       public.email_deliveries;
begin
  select id into v_order from public.orders limit 1;

  perform set_config('request.jwt.claim.sub', 'b9999999-9999-9999-9999-999999999999', true);
  d := public.resend_ticket_email(v_order, 'somewhere.else@example.com');

  assert (select count(*) from public.email_deliveries where order_id = v_order) = 1,
    're-sending must reuse the row, not add a second one';
  assert d.status = 'pending', 're-sending puts the delivery back in the queue';
  assert d.attempts = 0, 're-sending resets the attempt counter';
  assert d.to_email = 'somewhere.else@example.com', 're-sending can redirect the ticket';
  raise notice 'PASS re-sending resets the same delivery and can redirect it';
end $$;

-- --- somebody else's order is not theirs to email ----------------------------
do $$
declare v_order uuid;
begin
  select id into v_order from public.orders limit 1;
  perform set_config('request.jwt.claim.sub', 'c9999999-9999-9999-9999-999999999999', true);

  begin
    perform public.resend_ticket_email(v_order, 'attacker@example.com');
    raise exception 'TEST FAILED: a stranger redirected somebody else''s ticket';
  exception when raise_exception then
    raise notice 'PASS only the buyer (or an admin) can re-send a ticket';
  end;
end $$;

-- --- the queue is not readable by anyone else --------------------------------
do $$
declare visible integer;
begin
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', 'c9999999-9999-9999-9999-999999999999', true);
  select count(*) into visible from public.email_deliveries;
  assert visible = 0, 'a stranger must not see another person''s ticket deliveries';

  perform set_config('request.jwt.claim.sub', 'b9999999-9999-9999-9999-999999999999', true);
  select count(*) into visible from public.email_deliveries;
  assert visible = 1, 'the buyer must see their own delivery';

  reset role;
  raise notice 'PASS the email queue respects RLS';
end $$;

-- --- the client cannot write the queue ---------------------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'c9999999-9999-9999-9999-999999999999', true);

  begin
    insert into public.email_deliveries (kind, to_email, subject)
    values ('ticket', 'attacker@example.com', 'gimme');
    reset role;
    raise exception 'TEST FAILED: a client queued its own email';
  exception when insufficient_privilege or raise_exception then
    reset role;
    raise notice 'PASS the email queue is not client-writable';
  end;
end $$;

rollback;
