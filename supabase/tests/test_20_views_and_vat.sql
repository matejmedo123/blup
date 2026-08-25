-- ============================================================================
-- BLUP test 20 · One visit is one view, and VAT adds up
-- ============================================================================
-- What is actually being proved here:
--
--   · opening an event counts one view, no matter how many times the screen
--     refetches inside the same visit
--   · a card scrolling past in the feed (an impression) counts no view at all
--   · a second person opening the same event does count
--   · the same visitor counts again once the window has passed
--   · vat_split() never loses a cent: net + vat = gross, at any rate
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a2020202-0000-0000-0000-000000000001', 'org20@example.com',  '{"display_name":"Org"}'),
  ('a2020202-0000-0000-0000-000000000002', 'goer20@example.com', '{"display_name":"Goer"}'),
  ('a2020202-0000-0000-0000-000000000003', 'pal20@example.com',  '{"display_name":"Pal"}');

insert into public.events (id, creator_id, title, category, start_at, latitude, longitude, is_free, status)
values ('e2020202-0000-0000-0000-000000000001', 'a2020202-0000-0000-0000-000000000001',
        'Jeden pohlad', 'techno', now() + interval '5 days', 48.1, 17.1, true, 'published');

-- --- one visit, however many refetches ---------------------------------------
do $$
declare v integer;
begin
  perform set_config('request.jwt.claim.sub', 'a2020202-0000-0000-0000-000000000002', true);

  perform public.record_signal('e2020202-0000-0000-0000-000000000001', 'open_detail',
                               1.0, '{"source":"detail"}'::jsonb);
  perform public.record_signal('e2020202-0000-0000-0000-000000000001', 'open_detail',
                               1.0, '{"source":"detail"}'::jsonb);
  perform public.record_signal('e2020202-0000-0000-0000-000000000001', 'open_detail',
                               1.0, '{"source":"detail"}'::jsonb);

  select view_count into v from public.events
   where id = 'e2020202-0000-0000-0000-000000000001';
  assert v = 1, format('three refetches in one visit must be one view, got %s', v);
  raise notice 'PASS opening an event three times in a visit counts once';
end $$;

-- --- an impression is not a view ---------------------------------------------
do $$
declare v integer; s integer;
begin
  perform set_config('request.jwt.claim.sub', 'a2020202-0000-0000-0000-000000000003', true);

  perform public.record_signal('e2020202-0000-0000-0000-000000000001', 'impression',
                               0.2, '{"source":"feed"}'::jsonb);

  select view_count into v from public.events
   where id = 'e2020202-0000-0000-0000-000000000001';
  assert v = 1, format('a card in the feed must not count as a view, got %s', v);

  -- but the ranker still gets to know about it
  select count(*) into s from public.user_event_signals
   where event_id = 'e2020202-0000-0000-0000-000000000001' and signal = 'impression';
  assert s = 1, 'the impression is still recorded as a signal';
  raise notice 'PASS scrolling past an event counts no view but is still a signal';
end $$;

-- --- a different person is a different view ----------------------------------
do $$
declare v integer;
begin
  perform set_config('request.jwt.claim.sub', 'a2020202-0000-0000-0000-000000000003', true);
  perform public.record_signal('e2020202-0000-0000-0000-000000000001', 'open_detail',
                               1.0, '{"source":"detail"}'::jsonb);

  select view_count into v from public.events
   where id = 'e2020202-0000-0000-0000-000000000001';
  assert v = 2, format('a second visitor must count, got %s', v);
  raise notice 'PASS a second person opening the event counts';
end $$;

-- --- and the same person counts again tomorrow -------------------------------
do $$
declare v integer;
begin
  -- Age this visitor's rows past the dedupe window.
  update public.event_views
     set created_at = now() - interval '3 hours'
   where event_id = 'e2020202-0000-0000-0000-000000000001'
     and user_id  = 'a2020202-0000-0000-0000-000000000002';

  perform set_config('request.jwt.claim.sub', 'a2020202-0000-0000-0000-000000000002', true);
  perform public.record_signal('e2020202-0000-0000-0000-000000000001', 'open_detail',
                               1.0, '{"source":"detail"}'::jsonb);

  select view_count into v from public.events
   where id = 'e2020202-0000-0000-0000-000000000001';
  assert v = 3, format('a later visit counts again, got %s', v);
  raise notice 'PASS the same person counts again after the window';
end $$;

-- --- VAT never loses a cent ---------------------------------------------------
do $$
declare split jsonb; gross integer; rate integer;
begin
  split := public.vat_split(1200, 2300);
  assert (split->>'net_cents')::int = 976,
    format('12.00 at 23%% is 9.76 net, got %s', split->>'net_cents');
  assert (split->>'vat_cents')::int = 224,
    format('12.00 at 23%% is 2.24 VAT, got %s', split->>'vat_cents');

  -- Exhaustive on the shapes that actually round badly.
  foreach gross in array array[1, 7, 99, 333, 1050, 1200, 1999, 250000] loop
    foreach rate in array array[0, 500, 1000, 1900, 2300, 10000] loop
      split := public.vat_split(gross, rate);
      assert (split->>'net_cents')::int + (split->>'vat_cents')::int = gross,
        format('net + vat must equal gross at %s / %s bps', gross, rate);
      assert (split->>'vat_cents')::int >= 0, 'VAT is never negative';
    end loop;
  end loop;
  raise notice 'PASS the VAT split always adds back up to the gross price';
end $$;

-- --- ten is the ceiling, and it is the setting that says so -------------------
do $$
declare cap integer;
begin
  cap := (public.cart_limits()->>'max_tickets_per_order')::integer;
  assert cap = 10, format('an order tops out at ten tickets, got %s', cap);
  raise notice 'PASS one order tops out at ten tickets';
end $$;

rollback;
