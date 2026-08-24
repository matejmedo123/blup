-- ============================================================================
-- BLUP test 12 · Creating an event and its ticket types in one call
-- ============================================================================
-- What is actually being proved here:
--
--   · a free event needs no tickets and refuses to carry priced ones
--   · a paid event without ticket types is refused outright
--   · a paid event from an unverified organization is refused
--   · a refused call writes nothing — no orphan event is left behind
--   · a good call creates the event and every type together
--   · the event's own price becomes the cheapest ticket, for the feed card
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1212121-0000-0000-0000-000000000001', 'org12@example.com',      '{"display_name":"Org"}'),
  ('a1212121-0000-0000-0000-000000000002', 'stranger12@example.com', '{"display_name":"Stranger"}');

insert into public.organizations (id, name, slug, created_by, verification_status, payouts_enabled)
values
  ('d1212121-0000-0000-0000-000000000001', 'Verified Co', 'verified-co-12',
   'a1212121-0000-0000-0000-000000000001', 'verified', true),
  ('d1212121-0000-0000-0000-000000000002', 'Pending Co', 'pending-co-12',
   'a1212121-0000-0000-0000-000000000001', 'pending', false);

do $$
declare
  v_event   public.events;
  v_before  integer;
  v_after   integer;
  v_base    jsonb := jsonb_build_object(
    'title', 'Jednym vrzom', 'category', 'techno',
    'latitude', 48.1486, 'longitude', 17.1077,
    'start_at', (now() + interval '20 days')::text,
    'currency', 'EUR', 'status', 'published'
  );
begin
  perform set_config('request.jwt.claim.sub', 'a1212121-0000-0000-0000-000000000001', true);

  -- ---- a free event needs nothing else ------------------------------------
  v_event := public.create_event_with_tickets(v_base || jsonb_build_object('is_free', true));
  assert v_event.is_free and v_event.price_cents = 0, 'a free event is created and costs nothing';
  assert not exists (select 1 from public.ticket_types where event_id = v_event.id),
    'a free event has no ticket types';
  raise notice 'PASS a free event needs no ticket types';

  -- ---- ...and refuses to sell ---------------------------------------------
  select count(*) into v_before from public.events;
  begin
    perform public.create_event_with_tickets(
      v_base || jsonb_build_object('is_free', true),
      jsonb_build_array(jsonb_build_object('name', 'Vstup', 'price_cents', 1000, 'quantity_total', 10)));
    assert false, 'a free event must not carry priced tickets';
  exception when others then
    assert sqlerrm = 'FREE_EVENT_CANNOT_SELL', format('expected FREE_EVENT_CANNOT_SELL, got %s', sqlerrm);
  end;
  select count(*) into v_after from public.events;
  assert v_before = v_after, 'the refused call wrote no event';
  raise notice 'PASS a free event cannot carry priced tickets, and nothing is written';

  -- ---- a paid event with no ticket types is refused ------------------------
  select count(*) into v_before from public.events;
  begin
    perform public.create_event_with_tickets(v_base || jsonb_build_object(
      'is_free', false, 'organization_id', 'd1212121-0000-0000-0000-000000000001'));
    assert false, 'a paid event with nothing to sell must be refused';
  exception when others then
    assert sqlerrm = 'TICKET_TYPES_REQUIRED', format('expected TICKET_TYPES_REQUIRED, got %s', sqlerrm);
  end;
  select count(*) into v_after from public.events;
  assert v_before = v_after, 'no event was left behind';
  raise notice 'PASS a paid event with no ticket types is refused, leaving nothing behind';

  -- ---- an unverified organization cannot sell ------------------------------
  select count(*) into v_before from public.events;
  begin
    perform public.create_event_with_tickets(
      v_base || jsonb_build_object('is_free', false,
                                   'organization_id', 'd1212121-0000-0000-0000-000000000002'),
      jsonb_build_array(jsonb_build_object('name', 'Vstup', 'price_cents', 1000, 'quantity_total', 10)));
    assert false, 'an unverified organization must not sell';
  exception when others then
    assert sqlerrm = 'ORGANIZATION_NOT_VERIFIED', format('expected ORGANIZATION_NOT_VERIFIED, got %s', sqlerrm);
  end;
  select count(*) into v_after from public.events;
  assert v_before = v_after, 'no event was left behind';
  raise notice 'PASS an unverified organization is refused, leaving nothing behind';

  -- ---- somebody else's organization ----------------------------------------
  perform set_config('request.jwt.claim.sub', 'a1212121-0000-0000-0000-000000000002', true);
  begin
    perform public.create_event_with_tickets(
      v_base || jsonb_build_object('is_free', false,
                                   'organization_id', 'd1212121-0000-0000-0000-000000000001'),
      jsonb_build_array(jsonb_build_object('name', 'Vstup', 'price_cents', 1000, 'quantity_total', 10)));
    assert false, 'a stranger must not publish under an organization';
  exception when others then
    assert sqlerrm = 'NOT_AN_ORGANIZER', format('expected NOT_AN_ORGANIZER, got %s', sqlerrm);
  end;
  raise notice 'PASS a stranger cannot publish under someone else''s organization';

  -- ---- the good case -------------------------------------------------------
  perform set_config('request.jwt.claim.sub', 'a1212121-0000-0000-0000-000000000001', true);
  v_event := public.create_event_with_tickets(
    v_base || jsonb_build_object('is_free', false,
                                 'organization_id', 'd1212121-0000-0000-0000-000000000001'),
    jsonb_build_array(
      jsonb_build_object('name', 'Early bird', 'price_cents', 1200, 'quantity_total', 50, 'max_per_order', 4),
      jsonb_build_object('name', 'Standard',   'price_cents', 1800, 'quantity_total', 200),
      jsonb_build_object('name', 'VIP',        'price_cents', 4500, 'quantity_total', 20)));

  assert (select count(*) from public.ticket_types where event_id = v_event.id) = 3,
    'all three ticket types were created';
  assert v_event.price_cents = 1200,
    format('the event shows the cheapest ticket, got %s', v_event.price_cents);
  assert (select max_per_order from public.ticket_types
          where event_id = v_event.id and name = 'Early bird') = 4,
    'a per-order cap survives';
  assert (select max_per_order from public.ticket_types
          where event_id = v_event.id and name = 'Standard') = 6,
    'an omitted per-order cap defaults to six';
  assert (select bool_and(currency = 'EUR') from public.ticket_types where event_id = v_event.id),
    'ticket types inherit the event currency';
  raise notice 'PASS an event and all its ticket types are created together';
end $$;

-- ---- a guest cannot create anything ---------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.create_event_with_tickets(jsonb_build_object(
      'title', 'Guest', 'category', 'techno', 'latitude', 48.1, 'longitude', 17.1,
      'start_at', (now() + interval '5 days')::text, 'is_free', true));
    assert false, 'a guest must not create an event';
  exception when others then
    assert sqlerrm in ('UNAUTHENTICATED', 'NOT_AN_ORGANIZER'),
      format('expected UNAUTHENTICATED, got %s', sqlerrm);
  end;
  raise notice 'PASS a guest cannot create an event';
end $$;

rollback;
