-- ============================================================================
-- Provízia sa predajcovi strhávala dvakrát
-- ============================================================================
-- Kniha zapisovala predaj takto:
--
--   sale          +seller_net_cents     (= cena − provízia, už čistá suma)
--   platform_fee  −seller_fee_cents     (a provízia ešte raz)
--
-- Zostatok sa počíta ako súčet knihy, takže z vstupenky za 45 € pri 5 %
-- provízii dostal predajca 40,50 € namiesto 42,75 €. O 2,25 € menej — a
-- nikde na obrazovke nebolo vidieť prečo, lebo objednávka hovorila 42,75 €
-- a kniha 40,50 €.
--
-- Je to o to zákernejšie, že na malých sumách to vyzerá ako zaokrúhľovanie.
--
-- Správny tvar je ten istý, aký má kniha organizátora hneď vedľa:
--
--   sale          +hrubá suma
--   platform_fee  −provízia
--
-- Súčet potom sedí na `seller_net_cents`, ktoré je v objednávke, a obe čísla
-- si prestanú protirečiť. Odhalil to test_58, ktorý prejde celú cestu od
-- vypísania po výplatu a porovná, čo si predajca vypýta, s tým, čo mu podľa
-- objednávky patrí.
--
-- POZNÁMKA K NASADENIU: ak by už v `seller_ledger_entries` boli zápisy typu
-- `sale` z predchádzajúcej verzie, sú o províziu nižšie. Na blup.sk zatiaľ
-- žiadne nie sú — SWAP nebol nasadený — takže sa nič neopravuje spätne.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.settle_resale_orders(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  fees     jsonb := public.resale_fees();
  delay    integer := (fees->>'settlement_days')::integer;
  ord      record;
  settled  integer := 0;
  ready_at timestamptz;
begin
  for ord in
    select o.*, coalesce(e.end_at, e.start_at) as event_end
    from public.resale_orders o
    join public.events e on e.id = o.event_id
    where o.payment_status = 'succeeded'
      and o.order_status in ('ticket_delivered', 'completed')
      -- Event sa musel odohrať. Kým sa neodohral, nevieme, či sa kupujúci
      -- naozaj dostal dnu.
      and coalesce(e.end_at, e.start_at) <= now()
      and e.status <> 'cancelled'
      -- Otvorený spor drží peniaze na mieste.
      and not exists (
        select 1 from public.resale_disputes d
        where d.resale_order_id = o.id and d.status in ('open', 'investigating')
      )
      -- Externá vstupenka len s potvrdením kupujúceho. Pravosť sme overiť
      -- nemohli, takže toto je jediné, čo máme.
      and (o.source = 'blup' or o.order_status = 'completed')
      -- A hlavne: ešte na ňu nárok nevznikol. Unikátny index to poistí aj
      -- keby sa dva behy prekryli.
      and not exists (
        select 1 from public.seller_ledger_entries l
        where l.resale_order_id = o.id and l.type = 'sale'
      )
    order by o.paid_at
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
  loop
    ready_at := ord.event_end + make_interval(days => delay);

    insert into public.seller_ledger_entries
      (seller_id, resale_order_id, type, amount_cents, currency, available_at, description)
    values
      -- HRUBÁ suma, nie čistá. Provízia sa strháva až nasledujúcim zápisom;
      -- keď tu bola čistá, strhla sa dvakrát.
      (ord.seller_id, ord.id, 'sale', ord.ticket_price_cents, ord.currency, ready_at,
       'Predaj vstupenky na SWAPe'),
      (ord.seller_id, ord.id, 'platform_fee', -ord.seller_fee_cents, ord.currency, ready_at,
       'Provízia SWAPu')
    on conflict do nothing;

    if ord.order_status = 'ticket_delivered' and ord.source = 'blup' then
      update public.resale_orders
      set order_status = 'completed', completed_at = coalesce(completed_at, now())
      where id = ord.id;
    end if;

    perform public.notify_user(
      ord.seller_id, 'payout_update',
      'Peniaze za vstupenku sú na ceste',
      'Vyplatiteľné budú ' || to_char(ready_at, 'DD.MM.YYYY') || '.',
      null, ord.event_id,
      jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
    );

    perform public.log_resale(null, 'payout_accrued', 'resale_order', ord.id,
      jsonb_build_object('amount_cents', ord.seller_net_cents, 'available_at', ready_at));

    settled := settled + 1;
  end loop;

  return settled;
end;
$$;

revoke execute on function public.settle_resale_orders(integer) from public;
grant execute on function public.settle_resale_orders(integer) to service_role;
