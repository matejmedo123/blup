-- ============================================================================
-- SWAP: z provízie ide podiel organizátorovi
-- ============================================================================
-- Doteraz si BLUP bral 10 % a organizátor eventu z ďalšieho predaja svojej
-- vstupenky nemal nič. To je pre organizátora dôvod burzu nenávidieť: jeho
-- vstupenka sa predá druhýkrát, zarobí na tom niekto iný a jemu z toho
-- zostane len práca pri dverách.
--
-- Nový model:
--
--   BLUP vstupenka na BLUP evente   15 %  =  10 % BLUP + 5 % organizátorovi
--   vstupenka odinakiaľ             15 %  =  15 % BLUP
--
-- Z pohľadu predajcu je to rovnaké číslo v oboch prípadoch — 15 % — a to je
-- zámer. Keby sa provízia líšila podľa pôvodu vstupenky, tlačilo by to ľudí
-- vypisovať naše vstupenky ako cudzie, a práve tie naše sú jediné, ktorých
-- pravosť vieme zaručiť.
--
-- Podiel organizátora sa zapíše do JEHO knihy (`ledger_entries`) ako
-- `adjustment`, nie ako `sale`. Nebol to predaj jeho vstupenky — tú predal
-- niekto iný — a keby to bol `sale`, rozišli by sa mu tržby s počtom predaných
-- vstupeniek a účtovníctvo by prestalo sedieť.
-- ============================================================================

-- --- nastavenia --------------------------------------------------------------

alter table public.platform_settings
  add column if not exists resale_organizer_share_bps integer not null default 500
    check (resale_organizer_share_bps between 0 and 10000);

comment on column public.platform_settings.resale_organizer_share_bps is
  'Koľko z ceny ďalšieho predaja dostane organizátor eventu. Len pri BLUP '
  'vstupenke na evente, ktorý má organizáciu. Platí sa z provízie, nie navyše.';

-- Provízia 15 %. Mení sa aj existujúcemu riadku, nielen východzia hodnota —
-- `alter column set default` na už existujúci riadok nesiahne.
alter table public.platform_settings
  alter column resale_seller_fee_bps set default 1500;

update public.platform_settings set resale_seller_fee_bps = 1500 where id;

create or replace function public.resale_fees()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'enabled',            s.resale_enabled,
    'buyer_fee_bps',      s.resale_buyer_fee_bps,
    'seller_fee_bps',     s.resale_seller_fee_bps,
    'organizer_share_bps', s.resale_organizer_share_bps,
    'max_markup_bps',     s.resale_max_markup_bps,
    'price_cap_enabled',  s.resale_price_cap_enabled,
    'min_price_cents',    50,
    'hold_minutes',       s.resale_hold_minutes,
    'settlement_days',    s.resale_settlement_days,
    'currency',           s.default_currency
  )
  from public.platform_settings s
  where s.id;
$$;

revoke execute on function public.resale_fees() from public;
grant execute on function public.resale_fees() to anon, authenticated;

-- --- kniha organizátora ------------------------------------------------------
-- Väzba na objednávku z burzy, aby sa podiel nedal pripísať dvakrát. Rovnaká
-- poistka ako `seller_ledger_one_sale_per_order` na strane predajcu: cron môže
-- bežať dvakrát, dva behy sa môžu prekryť, a peniaze sa nesmú zdvojiť ani
-- vtedy.
alter table public.ledger_entries
  add column if not exists resale_order_id uuid references public.resale_orders (id) on delete set null;

create unique index if not exists ledger_one_resale_share
  on public.ledger_entries (resale_order_id)
  where resale_order_id is not null;

create index if not exists ledger_resale_order_idx
  on public.ledger_entries (resale_order_id);

-- --- vyrovnanie --------------------------------------------------------------

create or replace function public.settle_resale_orders(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  fees      jsonb := public.resale_fees();
  delay     integer := (fees->>'settlement_days')::integer;
  share_bps integer := (fees->>'organizer_share_bps')::integer;
  ord       record;
  settled   integer := 0;
  ready_at  timestamptz;
  share     integer;
begin
  for ord in
    select o.*, coalesce(e.end_at, e.start_at) as event_end, e.organization_id
    from public.resale_orders o
    join public.events e on e.id = o.event_id
    where o.payment_status = 'succeeded'
      and o.order_status in ('ticket_delivered', 'completed')
      and coalesce(e.end_at, e.start_at) <= now()
      and e.status <> 'cancelled'
      and not exists (
        select 1 from public.resale_disputes d
        where d.resale_order_id = o.id and d.status in ('open', 'investigating')
      )
      and (o.source = 'blup' or o.order_status = 'completed')
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

    -- Podiel organizátora. Len pri NAŠEJ vstupenke a len keď je za eventom
    -- organizácia — pri vstupenke odinakiaľ organizátor o predaji nevie a
    -- vstupenku nevydal, takže by to bol dar z cudzieho.
    if ord.source = 'blup' and ord.organization_id is not null and share_bps > 0 then
      share := (ord.ticket_price_cents * share_bps) / 10000;
      -- Podiel nikdy nesmie byť väčší než provízia — inak by BLUP doplácal na
      -- vlastnú burzu. Pri drobných sumách to vyjde na nulu a vtedy sa
      -- nezapisuje nič; riadok na 0 € je len šum v účtovníctve.
      share := least(share, ord.seller_fee_cents);
      if share > 0 then
        insert into public.ledger_entries
          (organization_id, event_id, resale_order_id, type, amount_cents,
           currency, available_at, description)
        values
          (ord.organization_id, ord.event_id, ord.id, 'adjustment', share,
           ord.currency, ready_at, 'Podiel z ďalšieho predaja na SWAPe')
        on conflict do nothing;
      end if;
    end if;

    if ord.order_status = 'ticket_delivered' and ord.source = 'blup' then
      update public.resale_orders
      set order_status = 'completed', completed_at = coalesce(completed_at, now())
      where id = ord.id;
    end if;

    -- Poradie parametrov je `(user, type, title, body, actor, event, data)` —
    -- `actor` a `event` sú medzi telom a dátami. Vynechať ich a poslať jsonb
    -- ako piaty parameter znamená, že funkcia s takou signatúrou neexistuje a
    -- celé vyrovnanie spadne.
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
