-- ============================================================================
-- BLUP test 23 · Payout policy — the event anchor, the reserve, disputes
-- ============================================================================
-- The bug this file exists for: money used to become payable N days after the
-- SALE. A ticket sold months before the event was therefore payable months
-- before the event. Assertion one below fails against that behaviour.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'buyer@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'organizer@blup.test'),
  ('44444444-4444-4444-4444-444444444444', 'admin@blup.test');

update public.profiles set app_role = 'admin'
where id = '44444444-4444-4444-4444-444444444444';

-- A brand-new organizer: no history, so tier 0.
insert into public.organizations (id, slug, name, created_by, verification_status,
                                  payouts_enabled, platform_fee_bps, default_currency)
values ('bbbbbbb1-0000-0000-0000-000000000001', 'nova', 'Nova Collective',
        '22222222-2222-2222-2222-222222222222', 'verified', true, 400, 'EUR');

insert into public.organization_members (organization_id, user_id, role)
values ('bbbbbbb1-0000-0000-0000-000000000001',
        '22222222-2222-2222-2222-222222222222', 'owner')
on conflict do nothing;

-- Deliberately far out: this is the case the old code got wrong.
insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, end_at, is_free, price_cents, currency)
values ('aaaaaaa1-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
        'bbbbbbb1-0000-0000-0000-000000000001', 'Nova Open Air', 'techno',
        48.1550, 17.1200,
        now() + interval '240 days', now() + interval '240 days 8 hours',
        false, 2500, 'EUR');

insert into public.ticket_types (id, event_id, name, price_cents, currency, quantity_total, max_per_order)
values ('ccccccc1-0000-0000-0000-000000000001', 'aaaaaaa1-0000-0000-0000-000000000002',
        'Early bird', 2500, 'EUR', 50, 4);

-- --- the tier a fresh organizer gets ----------------------------------------
do $$
begin
  assert public.effective_payout_tier('bbbbbbb1-0000-0000-0000-000000000001') = 0,
    'an organizer with no completed events is tier 0';
  raise notice 'PASS a new organizer starts at tier 0';
end $$;

-- --- the money is held until after the event, not after the sale -------------
do $$
declare
  o        public.orders;
  main_row public.ledger_entries;
  res_row  public.ledger_entries;
  ev_end   timestamptz;
begin
  o := public.create_order('11111111-1111-1111-1111-111111111111',
                           'ccccccc1-0000-0000-0000-000000000001', 2);
  perform public.fulfill_order(o.id, 'stripe', 'pi_anchor_1', o.total_cents);

  select end_at into ev_end from public.events
  where id = 'aaaaaaa1-0000-0000-0000-000000000002';

  select * into main_row from public.ledger_entries
  where order_id = o.id and type = 'sale' and not is_reserve;
  select * into res_row from public.ledger_entries
  where order_id = o.id and type = 'sale' and is_reserve;

  -- The heart of it: nothing from this sale is payable any time soon.
  assert main_row.available_at > now() + interval '200 days',
    format('the main amount must wait for the event, got %s', main_row.available_at);

  -- Tier 0: main payout five days after the event.
  assert main_row.available_at = ev_end + interval '5 days',
    format('tier 0 pays T+5, got %s vs %s', main_row.available_at, ev_end + interval '5 days');

  -- Tier 0: 15 % reserve, released ninety days after the event.
  assert res_row.available_at = ev_end + interval '90 days',
    format('tier 0 releases the reserve at T+90, got %s', res_row.available_at);
  assert res_row.amount_cents = (o.net_cents * 1500) / 10000,
    format('reserve should be 15 %% of %s, got %s', o.net_cents, res_row.amount_cents);

  -- And the split loses nothing.
  assert main_row.amount_cents + res_row.amount_cents = o.net_cents,
    format('the two halves must add back to %s, got %s',
           o.net_cents, main_row.amount_cents + res_row.amount_cents);

  raise notice 'PASS the hold is anchored to the event, and the reserve splits exactly';
end $$;

-- --- none of it is available yet --------------------------------------------
do $$
declare b record;
begin
  select * into b from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';

  assert b.available_cents <= 0,
    format('nothing may be available before the event, got %s', b.available_cents);
  assert b.pending_cents > 0, 'the sale must show as pending';
  assert b.reserve_cents = 750, format('reserve of 5000 net at 15 %% is 750, got %s', b.reserve_cents);
  raise notice 'PASS the balance shows the money as pending, with the reserve broken out';
end $$;

-- --- a tier-0 organizer cannot be advanced anything --------------------------
do $$
declare q jsonb;
begin
  set local role postgres;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

  q := public.advance_quote('bbbbbbb1-0000-0000-0000-000000000001',
                            'aaaaaaa1-0000-0000-0000-000000000002');

  assert not (q->>'eligible')::boolean, 'tier 0 gets no advance';
  assert q->>'reason' = 'TIER_NO_ADVANCE',
    format('expected TIER_NO_ADVANCE, got %s', q->>'reason');
  raise notice 'PASS a new organizer cannot be advanced money at all';
end $$;

-- --- an admin cannot force one either, because the cap is zero ---------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  begin
    perform public.approve_payout_advance('bbbbbbb1-0000-0000-0000-000000000001',
                                          'aaaaaaa1-0000-0000-0000-000000000002', 100);
    raise exception 'an advance at tier 0 should have been refused';
  exception when others then
    assert sqlerrm like '%ADVANCE_NOT_ELIGIBLE%',
      format('expected ADVANCE_NOT_ELIGIBLE, got %s', sqlerrm);
  end;
  raise notice 'PASS not even an admin can advance against a tier-0 organizer';
end $$;

-- --- tier 2: three finished events, no incidents -----------------------------
insert into public.events (id, creator_id, organization_id, title, category,
                           latitude, longitude, start_at, end_at, status, is_free)
values
  ('aaaaaaa1-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Past one', 'techno', 48.1, 17.1,
   now() - interval '60 days', now() - interval '60 days' + interval '5 hours', 'completed', true),
  ('aaaaaaa1-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Past two', 'techno', 48.1, 17.1,
   now() - interval '40 days', now() - interval '40 days' + interval '5 hours', 'completed', true),
  ('aaaaaaa1-0000-0000-0000-00000000000c', '22222222-2222-2222-2222-222222222222',
   'bbbbbbb1-0000-0000-0000-000000000001', 'Past three', 'techno', 48.1, 17.1,
   now() - interval '20 days', now() - interval '20 days' + interval '5 hours', 'completed', true);

do $$
begin
  assert public.effective_payout_tier('bbbbbbb1-0000-0000-0000-000000000001') = 2,
    format('three clean events should reach tier 2, got %s',
           public.effective_payout_tier('bbbbbbb1-0000-0000-0000-000000000001'));
  raise notice 'PASS three completed events without incident reach tier 2';
end $$;

-- --- a tier-2 sale is held on the tier-2 schedule ----------------------------
do $$
declare
  o        public.orders;
  main_row public.ledger_entries;
  res_row  public.ledger_entries;
  ev_end   timestamptz;
begin
  o := public.create_order('11111111-1111-1111-1111-111111111111',
                           'ccccccc1-0000-0000-0000-000000000001', 2);
  perform public.fulfill_order(o.id, 'stripe', 'pi_anchor_2', o.total_cents);

  select end_at into ev_end from public.events
  where id = 'aaaaaaa1-0000-0000-0000-000000000002';

  select * into main_row from public.ledger_entries
  where order_id = o.id and type = 'sale' and not is_reserve;
  select * into res_row from public.ledger_entries
  where order_id = o.id and type = 'sale' and is_reserve;

  assert main_row.available_at = ev_end + interval '2 days',
    format('tier 2 pays T+2, got %s', main_row.available_at);
  assert res_row.available_at = ev_end + interval '45 days',
    format('tier 2 releases the reserve at T+45, got %s', res_row.available_at);
  assert res_row.amount_cents = (o.net_cents * 1000) / 10000,
    format('tier 2 holds 10 %%, got %s of %s', res_row.amount_cents, o.net_cents);
  raise notice 'PASS tier 2 is paid sooner and holds less back';
end $$;

-- --- an advance at tier 2, and its ceiling ----------------------------------
do $$
declare q jsonb; cap bigint;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  q := public.advance_quote('bbbbbbb1-0000-0000-0000-000000000001',
                            'aaaaaaa1-0000-0000-0000-000000000002');

  -- The event is 240 days out and tier 2 opens 14 days before it.
  assert not (q->>'eligible')::boolean, 'an advance 240 days before the event is too early';
  assert q->>'reason' = 'TOO_EARLY', format('expected TOO_EARLY, got %s', q->>'reason');
  raise notice 'PASS an advance cannot be taken earlier than the tier allows';
end $$;

-- Move the event inside the advance window and try again.
update public.events
set start_at = now() + interval '3 days',
    end_at   = now() + interval '3 days 8 hours'
where id = 'aaaaaaa1-0000-0000-0000-000000000002';

do $$
declare q jsonb; pending_main bigint; p public.payouts;
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  q := public.advance_quote('bbbbbbb1-0000-0000-0000-000000000001',
                            'aaaaaaa1-0000-0000-0000-000000000002');

  select coalesce(sum(amount_cents), 0) into pending_main
  from public.ledger_entries
  where event_id = 'aaaaaaa1-0000-0000-0000-000000000002'
    and type = 'sale' and not is_reserve and available_at > now();

  assert (q->>'eligible')::boolean, format('should be eligible now, got %s', q->>'reason');
  -- 50 % of the non-reserve pending amount, and not a cent of the reserve.
  assert (q->>'max_cents')::bigint = (pending_main * 5000) / 10000,
    format('cap should be half of %s, got %s', pending_main, q->>'max_cents');

  -- Over the cap is refused.
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
  begin
    perform public.approve_payout_advance('bbbbbbb1-0000-0000-0000-000000000001',
                                          'aaaaaaa1-0000-0000-0000-000000000002',
                                          ((q->>'max_cents')::bigint + 1)::integer);
    raise exception 'an advance over the cap should have been refused';
  exception when others then
    assert sqlerrm like '%ADVANCE_OVER_CAP%', format('expected ADVANCE_OVER_CAP, got %s', sqlerrm);
  end;

  -- At the cap it goes through, and the balance records it immediately.
  p := public.approve_payout_advance('bbbbbbb1-0000-0000-0000-000000000001',
                                     'aaaaaaa1-0000-0000-0000-000000000002',
                                     (q->>'max_cents')::bigint::integer);
  assert p.is_advance, 'the payout must be marked as an advance';
  assert exists (select 1 from public.ledger_entries
                 where payout_id = p.id and type = 'payout' and available_at <= now()),
    'an advance must hit the ledger the moment it is granted';
  raise notice 'PASS an advance is capped at the tier percentage and never touches the reserve';
end $$;

-- --- the organizer cannot grant themselves one -------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.approve_payout_advance('bbbbbbb1-0000-0000-0000-000000000001',
                                          'aaaaaaa1-0000-0000-0000-000000000002', 100);
    raise exception 'an organizer granting their own advance should have been refused';
  exception when others then
    assert sqlerrm like '%NOT_AUTHORIZED%', format('expected NOT_AUTHORIZED, got %s', sqlerrm);
  end;
  raise notice 'PASS an advance is never something the organizer can take';
end $$;

-- --- an open dispute freezes payouts -----------------------------------------
do $$
declare
  o public.orders;
  d public.payment_disputes;
begin
  select * into o from public.orders
  where provider_reference = 'pi_anchor_1';

  d := public.record_dispute_opened('dp_test_1', 'ch_test_1', o.id, 2500, 'EUR',
                                    'product_not_received');
  assert d.status = 'open', 'a new dispute is open';
  assert d.organization_id = 'bbbbbbb1-0000-0000-0000-000000000001',
    'the dispute must attach to the organizer, not just the order';

  -- Replay: webhooks arrive more than once and must not open a second dispute.
  perform public.record_dispute_opened('dp_test_1', 'ch_test_1', o.id, 2500, 'EUR',
                                       'product_not_received');
  assert (select count(*) from public.payment_disputes where provider_reference = 'dp_test_1') = 1,
    'a replayed webhook must not open a second dispute';

  assert public.organization_payouts_frozen('bbbbbbb1-0000-0000-0000-000000000001'),
    'an open dispute freezes payouts';
  raise notice 'PASS a dispute is recorded once and freezes payouts';
end $$;

-- --- and the freeze actually blocks a payout request --------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  begin
    perform public.request_payout('bbbbbbb1-0000-0000-0000-000000000001', 100);
    raise exception 'a payout during an open dispute should have been refused';
  exception when others then
    assert sqlerrm like '%PAYOUTS_FROZEN_DISPUTE%' or sqlerrm like '%INSUFFICIENT%',
      format('expected the freeze to bite, got %s', sqlerrm);
    assert sqlerrm like '%PAYOUTS_FROZEN_DISPUTE%',
      format('the freeze must be checked before the balance, got %s', sqlerrm);
  end;
  raise notice 'PASS the freeze is checked before anything else';
end $$;

-- --- an open dispute also knocks the tier back down --------------------------
do $$
begin
  assert public.earned_payout_tier('bbbbbbb1-0000-0000-0000-000000000001') = 0,
    'an incident takes an organizer back to tier 0';
  raise notice 'PASS an incident resets the earned tier';
end $$;

-- --- losing it takes the money back; winning it does not ---------------------
do $$
declare
  before_bal bigint;
  after_bal  bigint;
  d          public.payment_disputes;
begin
  select balance_cents into before_bal from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';

  d := public.record_dispute_closed('dp_test_1', 'lost');
  assert d.status = 'lost', 'the dispute closes as lost';

  select balance_cents into after_bal from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';

  assert after_bal = before_bal - 2500,
    format('a lost dispute must debit 2500, went from %s to %s', before_bal, after_bal);

  assert not public.organization_payouts_frozen('bbbbbbb1-0000-0000-0000-000000000001'),
    'closing the last open dispute lifts the freeze';

  -- Closing twice must not debit twice.
  perform public.record_dispute_closed('dp_test_1', 'lost');
  select balance_cents into after_bal from public.organization_balances
  where organization_id = 'bbbbbbb1-0000-0000-0000-000000000001';
  assert after_bal = before_bal - 2500,
    'a replayed close webhook must not debit the organizer twice';

  raise notice 'PASS a lost dispute debits once, and closing lifts the freeze';
end $$;

-- --- a failed payout puts the money back -------------------------------------
do $$
declare
  p     public.payouts;
  moved bigint;
begin
  select * into p from public.payouts where is_advance limit 1;
  select coalesce(sum(amount_cents), 0) into moved from public.ledger_entries where payout_id = p.id;

  perform public.mark_payout_settled(p.id, 'failed', 'po_failed_1');

  assert (select coalesce(sum(amount_cents), 0) from public.ledger_entries where payout_id = p.id) = 0,
    'a failed payout must net back to zero on the ledger';
  raise notice 'PASS a failed payout returns the money to the balance';
end $$;

-- --- an admin can pin a tier, and clear it again ------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);

  perform public.admin_set_payout_tier('bbbbbbb1-0000-0000-0000-000000000001', 2::smallint,
                                       'Known promoter, vouched for');
  assert public.effective_payout_tier('bbbbbbb1-0000-0000-0000-000000000001') = 2,
    'an override beats the earned tier';

  perform public.admin_set_payout_tier('bbbbbbb1-0000-0000-0000-000000000001', null, null);
  assert public.effective_payout_tier('bbbbbbb1-0000-0000-0000-000000000001')
         = public.earned_payout_tier('bbbbbbb1-0000-0000-0000-000000000001'),
    'clearing the override goes back to the history';
  raise notice 'PASS an admin can pin a tier and release it again';
end $$;

rollback;
