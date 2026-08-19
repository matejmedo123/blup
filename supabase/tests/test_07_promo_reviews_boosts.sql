-- ============================================================================
-- BLUP test 07 · Promo codes, post-event reviews, paid boosts
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('f6666666-6666-6666-6666-666666666666', 'org@example.com',   '{"display_name":"Org"}'),
  ('06666666-0000-0000-0000-000000000001', 'buyer@example.com', '{"display_name":"Buyer"}');

-- A verified organization with a paid event and a ticket type.
do $$
declare
  v_org   uuid;
  v_event uuid;
begin
  insert into public.organizations (name, slug, created_by, verification_status, platform_fee_bps)
  values ('Nova', 'nova', 'f6666666-6666-6666-6666-666666666666', 'verified', 500)
  returning id into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, 'f6666666-6666-6666-6666-666666666666', 'owner')
  on conflict do nothing;

  insert into public.events (creator_id, organization_id, title, category, start_at,
                             latitude, longitude, is_free, price_cents, status)
  values ('f6666666-6666-6666-6666-666666666666', v_org, 'Warehouse', 'techno',
          now() + interval '3 days', 48.1486, 17.1077, false, 2000, 'published')
  returning id into v_event;

  insert into public.ticket_types (event_id, name, price_cents, quantity_total, max_per_order)
  values (v_event, 'Early bird', 2000, 100, 10);

  insert into public.promo_codes (event_id, code, kind, value, max_uses, created_by)
  values (v_event, 'BLUP20', 'percent', 20, 3, 'f6666666-6666-6666-6666-666666666666');

  insert into public.promo_codes (event_id, code, kind, value, created_by)
  values (v_event, 'FIVEOFF', 'fixed', 500, 'f6666666-6666-6666-6666-666666666666');
end $$;

-- --- a percentage code discounts the order ----------------------------------
do $$
declare
  v_tt    uuid;
  v_order public.orders;
begin
  select id into v_tt from public.ticket_types limit 1;

  v_order := public.create_order('06666666-0000-0000-0000-000000000001', v_tt, 2, 'BLUP20');

  assert v_order.subtotal_cents = 4000,
    format('subtotal must be the list price, got %s', v_order.subtotal_cents);
  assert v_order.discount_cents = 800,
    format('20%% of 4000 is 800, got %s', v_order.discount_cents);
  assert v_order.net_cents = 3200,
    format('the ticket revenue must be the discounted total, got %s', v_order.net_cents);
  -- two tickets, 1.00 EUR archive fee each, carried by the buyer
  assert v_order.total_cents = 3400,
    format('the charge is the discounted total plus the archive fee, got %s', v_order.total_cents);

  -- This organization negotiated 5 %, so it does not follow the 4 % platform
  -- default — and the commission follows what is actually paid, not the list
  -- price, so a discount is funded by the organizer and not by BLUP's cut.
  assert v_order.commission_cents = 160,
    format('5%% of 3200 is 160, got %s', v_order.commission_cents);
  assert v_order.platform_fee_cents = 160,
    format('only the commission is deducted from the organizer, got %s', v_order.platform_fee_cents);

  raise notice 'PASS a percentage promo code discounts the order and the commission';
end $$;

-- --- a fixed code takes a flat amount off -----------------------------------
do $$
declare
  v_tt    uuid;
  v_order public.orders;
begin
  select id into v_tt from public.ticket_types limit 1;
  v_order := public.create_order('06666666-0000-0000-0000-000000000001', v_tt, 1, 'FIVEOFF');

  assert v_order.discount_cents = 500, format('expected 500 off, got %s', v_order.discount_cents);
  assert v_order.net_cents = 1500, format('expected 1500 net, got %s', v_order.net_cents);
  assert v_order.total_cents = 1600,
    format('expected 1500 + one archive fee = 1600, got %s', v_order.total_cents);
  raise notice 'PASS a fixed promo code takes a flat amount off';
end $$;

-- --- an unknown or exhausted code is refused --------------------------------
do $$
declare
  v_tt uuid;
begin
  select id into v_tt from public.ticket_types limit 1;

  begin
    perform public.create_order('06666666-0000-0000-0000-000000000001', v_tt, 1, 'NOPE');
    raise exception 'TEST FAILED: an unknown promo code was accepted';
  exception when raise_exception then
    raise notice 'PASS an unknown promo code is refused';
  end;

  -- BLUP20 allows 3 uses and one is already spent; burn the rest, then fail.
  perform public.create_order('06666666-0000-0000-0000-000000000001', v_tt, 1, 'BLUP20');
  perform public.create_order('06666666-0000-0000-0000-000000000001', v_tt, 1, 'BLUP20');

  begin
    perform public.create_order('06666666-0000-0000-0000-000000000001', v_tt, 1, 'BLUP20');
    raise exception 'TEST FAILED: an exhausted promo code was accepted';
  exception when raise_exception then
    raise notice 'PASS a promo code cannot be used more than max_uses times';
  end;
end $$;

-- --- an expired code is refused ---------------------------------------------
do $$
declare
  v_tt    uuid;
  v_event uuid;
begin
  select id into v_event from public.events limit 1;
  insert into public.promo_codes (event_id, code, kind, value, ends_at, created_by)
  values (v_event, 'OLD', 'percent', 50, now() - interval '1 day',
          'f6666666-6666-6666-6666-666666666666');

  select id into v_tt from public.ticket_types limit 1;
  begin
    perform public.create_order('06666666-0000-0000-0000-000000000001', v_tt, 1, 'OLD');
    raise exception 'TEST FAILED: an expired promo code was accepted';
  exception when raise_exception then
    raise notice 'PASS an expired promo code is refused';
  end;
end $$;

-- --- a buyer cannot read the code list --------------------------------------
do $$
declare v_visible integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '06666666-0000-0000-0000-000000000001', true);

  select count(*) into v_visible from public.promo_codes;
  assert v_visible = 0,
    format('a buyer must not be able to list promo codes, saw %s', v_visible);

  perform set_config('request.jwt.claim.sub', 'f6666666-6666-6666-6666-666666666666', true);
  select count(*) into v_visible from public.promo_codes;
  assert v_visible > 0, 'the organizer must see their own codes';

  reset role;
  raise notice 'PASS promo codes are visible only to the organizer';
end $$;

-- --- reviews: only attendees, only after it started -------------------------
do $$
declare
  v_event uuid;
  v_past  uuid;
begin
  set local role authenticated;
  select id into v_event from public.events limit 1;

  -- The event is in the future and the buyer is not attending.
  perform set_config('request.jwt.claim.sub', '06666666-0000-0000-0000-000000000001', true);
  begin
    perform public.review_event(v_event, 5, 'Super');
    raise exception 'TEST FAILED: a future event was reviewed';
  exception when raise_exception then
    raise notice 'PASS an event that has not started cannot be reviewed';
  end;

  reset role;
  insert into public.events (creator_id, title, category, start_at, latitude, longitude,
                             is_free, status)
  values ('f6666666-6666-6666-6666-666666666666', 'Minulý', 'coffee',
          now() - interval '2 days', 48.1486, 17.1077, true, 'published')
  returning id into v_past;
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', '06666666-0000-0000-0000-000000000001', true);
  begin
    perform public.review_event(v_past, 5, 'Bol som tam, fakt');
    raise exception 'TEST FAILED: a non-attendee reviewed an event';
  exception when raise_exception then
    raise notice 'PASS somebody who did not go cannot review';
  end;

  reset role;
  insert into public.event_attendees (event_id, user_id, status)
  values (v_past, '06666666-0000-0000-0000-000000000001', 'going');
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', '06666666-0000-0000-0000-000000000001', true);
  perform public.review_event(v_past, 4, 'Fajn kávička');

  assert (public.event_rating(v_past)->>'count')::integer = 1, 'the review must be counted';
  assert (public.event_rating(v_past)->>'average')::numeric = 4, 'the average must be 4';

  -- Reviewing again updates rather than duplicates.
  perform public.review_event(v_past, 5, 'Vlastne to bolo super');
  assert (public.event_rating(v_past)->>'count')::integer = 1, 'a person leaves one review';
  assert (public.event_rating(v_past)->>'average')::numeric = 5, 'the update must apply';

  reset role;
  raise notice 'PASS reviews require attendance and are one per person';
end $$;

-- --- reviews are not directly writable --------------------------------------
do $$
declare v_event uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '06666666-0000-0000-0000-000000000001', true);
  select id into v_event from public.events limit 1;

  begin
    insert into public.event_reviews (event_id, user_id, rating)
    values (v_event, '06666666-0000-0000-0000-000000000001', 5);
    raise exception 'TEST FAILED: a review was inserted directly';
  exception when insufficient_privilege or raise_exception then
    raise notice 'PASS reviews can only be written through review_event()';
  end;
  reset role;
end $$;

-- --- boosts lift the score and are disclosed --------------------------------
do $$
declare
  v_event uuid;
  v_row   record;
  v_boost numeric;
begin
  select id into v_event from public.events
   where creator_id = 'f6666666-6666-6666-6666-666666666666'
     and start_at > now() limit 1;

  assert public.boost_weight_for(v_event) = 0, 'an unboosted event has no boost weight';

  insert into public.event_boosts (event_id, ends_at, weight, amount_cents)
  values (v_event, now() + interval '3 days', 0.2, 1000);

  v_boost := public.boost_weight_for(v_event);
  assert v_boost = 0.2, format('the live boost must apply, got %s', v_boost);

  -- The recommendation for a viewer must carry the boost, and admit to it.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '06666666-0000-0000-0000-000000000001', true);

  select * into v_row
  from public.recommend_events('06666666-0000-0000-0000-000000000001', 48.1486, 17.1077, 50000, 10, 0)
  where id = v_event;

  assert v_row.id is not null, 'the boosted event must still be recommended';
  assert (v_row.score_breakdown->'components'->>'boost')::numeric = 0.2,
    'the breakdown must report the boost as its own component';
  assert (v_row.score_breakdown->'facts'->>'is_boosted')::boolean,
    'a boosted event must be flagged as boosted';

  reset role;
  raise notice 'PASS a boost lifts the score and is disclosed in the breakdown';
end $$;

-- --- an expired boost stops counting ----------------------------------------
do $$
declare v_event uuid;
begin
  select id into v_event from public.events
   where creator_id = 'f6666666-6666-6666-6666-666666666666'
     and start_at > now() limit 1;

  -- Move the whole window into the past; ends_at > starts_at still has to hold.
  update public.event_boosts
     set starts_at = now() - interval '2 days',
         ends_at = now() - interval '1 hour'
   where event_id = v_event;

  assert public.boost_weight_for(v_event) = 0, 'an expired boost must not count';
  raise notice 'PASS an expired boost stops counting';
end $$;

-- --- abandoned checkouts release their promo reservation --------------------
do $$
declare
  v_before integer;
  v_after  integer;
begin
  select used_count into v_before from public.promo_codes where code = 'BLUP20';

  update public.orders set expires_at = now() - interval '1 hour'
   where payment_status = 'requires_payment';

  perform public.release_expired_promos();

  select used_count into v_after from public.promo_codes where code = 'BLUP20';
  assert v_after < v_before,
    format('expired orders must release their promo uses (%s → %s)', v_before, v_after);

  raise notice 'PASS an abandoned checkout releases the promo code';
end $$;

-- --- buying a boost: inert until the webhook confirms ------------------------
do $$
declare
  v_event uuid;
  v_boost public.event_boosts;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'f6666666-6666-6666-6666-666666666666', true);

  select id into v_event from public.events
   where creator_id = 'f6666666-6666-6666-6666-666666666666'
     and start_at > now() limit 1;

  -- Clear the boost 0018's test left behind so this starts from nothing.
  reset role;
  delete from public.event_boosts where event_id = v_event;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'f6666666-6666-6666-6666-666666666666', true);

  v_boost := public.create_boost_order(v_event, 'boost_48');

  assert v_boost.amount_cents = 1200,
    format('the package price comes from the catalogue, got %s', v_boost.amount_cents);
  assert v_boost.weight = 0.15, format('the package weight applies, got %s', v_boost.weight);
  assert v_boost.payment_status = 'requires_payment', 'a new boost starts unpaid';

  -- Unpaid, so it must not promote anything yet.
  assert public.boost_weight_for(v_event) = 0,
    'an unpaid boost must not lift the score';

  raise notice 'PASS a bought boost is inert until it is paid';
end $$;

-- --- the client cannot price its own boost ----------------------------------
do $$
declare v_event uuid;
begin
  select id into v_event from public.events
   where creator_id = 'f6666666-6666-6666-6666-666666666666' and start_at > now() limit 1;

  perform set_config('request.jwt.claim.sub', 'f6666666-6666-6666-6666-666666666666', true);

  begin
    perform public.create_boost_order(v_event, 'boost_free_lol');
    raise exception 'TEST FAILED: an unknown boost package was accepted';
  exception when raise_exception then
    raise notice 'PASS an unknown boost package is refused';
  end;

  -- Somebody else's event cannot be promoted by you.
  perform set_config('request.jwt.claim.sub', '06666666-0000-0000-0000-000000000001', true);
  begin
    perform public.create_boost_order(v_event, 'boost_48');
    raise exception 'TEST FAILED: a stranger boosted an event';
  exception when raise_exception then
    raise notice 'PASS only the host or their organization can buy a boost';
  end;
end $$;

-- --- the webhook activates it, and only for the right amount ----------------
do $$
declare
  v_event uuid;
  v_boost public.event_boosts;
  v_again public.event_boosts;
begin
  reset role;
  select id into v_event from public.events
   where creator_id = 'f6666666-6666-6666-6666-666666666666' and start_at > now() limit 1;
  select * into v_boost from public.event_boosts where event_id = v_event limit 1;

  -- A wrong amount must not activate it.
  begin
    perform public.activate_boost(v_boost.id, 'stripe', 'pi_wrong', 100);
    raise exception 'TEST FAILED: a mismatched amount activated the boost';
  exception when raise_exception then
    null;
  end;

  assert (select payment_status from public.event_boosts where id = v_boost.id)
         <> 'succeeded',
    'a mismatched amount must never mark the boost paid';
  assert public.boost_weight_for(v_event) = 0, 'an unconfirmed boost must not promote';

  update public.event_boosts set payment_status = 'processing' where id = v_boost.id;

  v_boost := public.activate_boost(v_boost.id, 'stripe', 'pi_ok', 1200);
  assert v_boost.payment_status = 'succeeded', 'the correct amount must activate the boost';
  assert public.boost_weight_for(v_event) = 0.15,
    format('a paid boost must promote, got %s', public.boost_weight_for(v_event));

  -- A replayed webhook is not an error and does not extend the window.
  v_again := public.activate_boost(v_boost.id, 'stripe', 'pi_ok', 1200);
  assert v_again.ends_at = v_boost.ends_at, 'a replayed webhook must not extend the boost';

  raise notice 'PASS the webhook activates a boost, and only for the right amount';
end $$;

reset role;
rollback;
