-- ============================================================================
-- Burza vstupeniek — spory, refundácie a zrušený event
-- ============================================================================
-- Toto je tá časť, bez ktorej je „chránená platba" prázdny sľub. Pri externej
-- vstupenke nevieme overiť pravosť; jediné, čo kupujúcemu naozaj ponúkame, je
-- že sa k peniazom dostane späť, keď vstupenka nefunguje. Ak na to nie je
-- cesta, nemali by sme to tvrdiť.
--
-- Pravidlá refundácie sú konfigurovateľné a nie sú tu zadrôtované žiadne
-- právne tvrdenia. Zadanie to hovorí priamo a má pravdu: čo presne sa komu
-- vracia pri zrušenom podujatí, je vec obchodných podmienok a tie sa menia.
-- Kód drží mechaniku, nie výklad.
-- ============================================================================
set search_path = public, extensions;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'resale_dispute_reason') then
    create type resale_dispute_reason as enum (
      'not_received',      -- vstupenka nedorazila
      'invalid',           -- nefunguje, neprešla pri vstupe
      'not_as_described',  -- iné miesto, iný sektor, iný deň
      'event_cancelled',
      'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'resale_dispute_status') then
    create type resale_dispute_status as enum (
      'open', 'investigating', 'resolved', 'rejected'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'resale_dispute_resolution') then
    create type resale_dispute_resolution as enum (
      'refunded', 'partially_refunded', 'released_to_seller', 'no_action'
    );
  end if;
end $$;

create table if not exists public.resale_disputes (
  id              uuid primary key default gen_random_uuid(),
  resale_order_id uuid not null references public.resale_orders (id) on delete cascade,
  opened_by       uuid not null references public.profiles (id) on delete restrict,
  reason          resale_dispute_reason not null,
  description     text,
  status          resale_dispute_status not null default 'open',
  resolution      resale_dispute_resolution,
  resolution_note text,
  refunded_cents  integer check (refunded_cents >= 0),
  resolved_by     uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz,

  constraint resale_disputes_desc_len check (
    description is null or char_length(description) <= 2000
  ),
  -- Uzavretý spor musí povedať, ako dopadol. Bez toho by sa nedalo zistiť,
  -- prečo peniaze šli tam, kam šli.
  constraint resale_disputes_resolved_shape check (
    status <> 'resolved' or (resolution is not null and resolved_at is not null)
  )
);

-- Jeden otvorený spor na objednávku. Druhý by len rozdelil rozhodovanie na
-- dve miesta, ktoré si môžu protirečiť.
create unique index if not exists resale_disputes_one_open
  on public.resale_disputes (resale_order_id)
  where status in ('open', 'investigating');

create index if not exists resale_disputes_order_idx
  on public.resale_disputes (resale_order_id, created_at desc);
create index if not exists resale_disputes_status_idx
  on public.resale_disputes (status, created_at desc);
create index if not exists resale_disputes_opened_by_idx
  on public.resale_disputes (opened_by);
create index if not exists resale_disputes_resolved_by_idx
  on public.resale_disputes (resolved_by);

drop trigger if exists resale_disputes_set_updated_at on public.resale_disputes;
create trigger resale_disputes_set_updated_at
  before update on public.resale_disputes
  for each row execute function public.set_updated_at();

alter table public.resale_disputes enable row level security;

-- Spor vidia obe strany objednávky a admin. Predajca ho vidieť musí — je to
-- obvinenie voči nemu a má naň právo odpovedať.
drop policy if exists resale_disputes_select on public.resale_disputes;
create policy resale_disputes_select on public.resale_disputes
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.resale_orders o
      where o.id = resale_order_id
        and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    )
  );

drop policy if exists resale_disputes_write on public.resale_disputes;
create policy resale_disputes_write on public.resale_disputes
  for all using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- Otvorenie sporu
-- ============================================================================
create or replace function public.open_resale_dispute(
  p_order_id    uuid,
  p_reason      resale_dispute_reason,
  p_description text default null
)
returns public.resale_disputes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me  uuid := auth.uid();
  ord public.resale_orders;
  d   public.resale_disputes;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into ord from public.resale_orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if ord.buyer_id <> me and not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if ord.payment_status <> 'succeeded' then
    raise exception 'ORDER_NOT_PAID' using errcode = 'P0001';
  end if;
  if ord.order_status = 'refunded' then
    raise exception 'ORDER_ALREADY_REFUNDED' using errcode = 'P0001';
  end if;

  insert into public.resale_disputes (resale_order_id, opened_by, reason, description)
  values (ord.id, me, p_reason, nullif(btrim(p_description), ''))
  returning * into d;

  update public.resale_orders set order_status = 'disputed' where id = ord.id;

  -- Zadržanie peňazí. Kým je spor otvorený, `settle_resale_orders` nárok
  -- nevytvorí a už vzniknutý sa nevyplatí.
  update public.seller_payouts
  set status = 'cancelled',
      held_reason = 'Otvorený spor k objednávke'
  where seller_id = ord.seller_id and status = 'pending';

  perform public.notify_user(
    ord.seller_id, 'ticket_purchased',
    'Kupujúci otvoril spor',
    'Peniaze za túto objednávku sú zadržané, kým sa to nevyrieši.',
    null, ord.event_id,
    jsonb_build_object('resale_order_id', ord.id, 'dispute_id', d.id, 'kind', 'resale')
  );

  perform public.log_resale(me, 'dispute_opened', 'resale_order', ord.id,
    jsonb_build_object('dispute_id', d.id, 'reason', p_reason));

  return d;
end;
$$;

revoke execute on function public.open_resale_dispute(uuid, resale_dispute_reason, text) from public;
grant execute on function public.open_resale_dispute(uuid, resale_dispute_reason, text) to authenticated;

-- ============================================================================
-- Rozhodnutie sporu — len admin
-- ============================================================================
-- Vracia sumu, o ktorú sa má požiadať poskytovateľa platby. Samotný prevod
-- peňazí robí serverová funkcia, ktorá má kľúč; databáza vie, KOĽKO a PREČO,
-- ale peniaze nehýbe.
create or replace function public.resolve_resale_dispute(
  p_dispute_id     uuid,
  p_resolution     resale_dispute_resolution,
  p_refund_cents   integer default null,
  p_note           text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me     uuid := auth.uid();
  d      public.resale_disputes;
  ord    public.resale_orders;
  refund integer := 0;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into d from public.resale_disputes where id = p_dispute_id for update;
  if not found then
    raise exception 'DISPUTE_NOT_FOUND' using errcode = 'P0001';
  end if;
  if d.status in ('resolved', 'rejected') then
    -- Už rozhodnuté. Druhé rozhodnutie by mohlo vrátiť peniaze dvakrát.
    return jsonb_build_object('already_resolved', true, 'dispute_id', d.id,
                              'resolution', d.resolution, 'refund_cents', d.refunded_cents);
  end if;

  select * into ord from public.resale_orders where id = d.resale_order_id for update;

  if p_resolution = 'refunded' then
    refund := ord.total_cents;
  elsif p_resolution = 'partially_refunded' then
    if p_refund_cents is null or p_refund_cents <= 0 or p_refund_cents > ord.total_cents then
      raise exception 'INVALID_REFUND_AMOUNT' using errcode = 'P0001';
    end if;
    refund := p_refund_cents;
  end if;

  update public.resale_disputes
  set status = case when p_resolution = 'no_action'
                 then 'rejected'::resale_dispute_status
                 else 'resolved'::resale_dispute_status end,
      resolution = p_resolution,
      resolution_note = nullif(btrim(p_note), ''),
      refunded_cents = refund,
      resolved_by = me,
      resolved_at = now()
  where id = d.id
  returning * into d;

  if refund > 0 then
    update public.resale_orders
    set order_status = case when refund >= total_cents
                            then 'refunded'::resale_order_status
                            else 'completed'::resale_order_status end,
        payment_status = case when refund >= total_cents
                              then 'refunded'::payment_status
                              else payment_status end,
        refunded_at = now()
    where id = ord.id;

    -- Predajcovi sa strhne to, čo sa vrátilo kupujúcemu. Ak mu nárok ešte
    -- nevznikol, zostane v knihe ako mínus a započíta sa pri ďalšom predaji —
    -- nezmizne.
    insert into public.seller_ledger_entries
      (seller_id, resale_order_id, type, amount_cents, currency, available_at, description)
    values
      (ord.seller_id, ord.id, 'refund', -least(refund, ord.seller_net_cents),
       ord.currency, now(), 'Vrátené kupujúcemu po spore');

    perform public.notify_user(
      ord.buyer_id, 'ticket_confirmed', 'Spor vyriešený',
      'Vraciame ti ' || to_char(refund / 100.0, 'FM999990.00') || ' ' || ord.currency || '.',
      null, ord.event_id,
      jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
    );
  else
    update public.resale_orders
    set order_status = case when delivered_at is not null
                            then 'completed'::resale_order_status
                            else 'paid'::resale_order_status end
    where id = ord.id;

    perform public.notify_user(
      ord.seller_id, 'payout_update', 'Spor uzavretý',
      'Peniaze za objednávku sa uvoľnia podľa pravidiel platformy.',
      null, ord.event_id,
      jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
    );
  end if;

  perform public.log_resale(me, 'dispute_resolved', 'resale_order', ord.id,
    jsonb_build_object('dispute_id', d.id, 'resolution', p_resolution, 'refund_cents', refund));

  return jsonb_build_object(
    'dispute_id', d.id,
    'resale_order_id', ord.id,
    'resolution', p_resolution,
    -- Toto je suma, o ktorú má serverová funkcia požiadať poskytovateľa.
    'refund_cents', refund,
    'provider_reference', ord.provider_reference,
    'currency', ord.currency
  );
end;
$$;

revoke execute on function public.resolve_resale_dispute(
  uuid, resale_dispute_resolution, integer, text) from public;
grant execute on function public.resolve_resale_dispute(
  uuid, resale_dispute_resolution, integer, text) to authenticated;

-- ============================================================================
-- Zrušený event
-- ============================================================================
-- Keď organizátor event zruší, burza musí zareagovať sama. Čakať, kým si to
-- niekto všimne, znamená predávať vstupenky na niečo, čo sa neodohrá.
create or replace function public.cancel_resale_for_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  killed integer;
  opened integer := 0;
  ord    record;
begin
  -- 1. Žiadne nové nákupy.
  with dead as (
    update public.resale_listings
    set status = 'expired'
    where event_id = p_event_id and status in ('draft', 'active', 'reserved')
    returning 1
  )
  select count(*)::integer into killed from dead;

  update public.resale_reservations r
  set status = 'cancelled'
  where r.status = 'active'
    and exists (select 1 from public.resale_listings l
                where l.id = r.listing_id and l.event_id = p_event_id);

  -- 2. Zaplatené objednávky idú do sporu, nie do automatickej refundácie.
  --    Koľko presne sa komu vracia pri zrušenom podujatí je vec obchodných
  --    podmienok — kód to nevykladá, iba na to upozorní a pripraví rozhodnutie.
  for ord in
    select * from public.resale_orders
    where event_id = p_event_id
      and payment_status = 'succeeded'
      and order_status not in ('refunded', 'cancelled', 'disputed')
  loop
    insert into public.resale_disputes (resale_order_id, opened_by, reason, description)
    values (ord.id, ord.buyer_id, 'event_cancelled',
            'Automaticky otvorené: organizátor event zrušil.')
    on conflict do nothing;

    update public.resale_orders set order_status = 'disputed' where id = ord.id;

    perform public.notify_user(
      ord.buyer_id, 'event_cancelled', 'Event bol zrušený',
      'Tvoju objednávku z burzy riešime — ozveme sa s postupom.',
      null, p_event_id,
      jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
    );
    opened := opened + 1;
  end loop;

  -- 3. Zadržať všetko, čo ešte nebolo vyplatené.
  update public.seller_payouts p
  set status = 'cancelled', held_reason = 'Zrušený event'
  where p.status = 'pending'
    and exists (
      select 1 from public.resale_orders o
      where o.seller_id = p.seller_id and o.event_id = p_event_id
    );

  perform public.log_resale(null, 'event_cancelled', 'event', p_event_id,
    jsonb_build_object('listings_stopped', killed, 'orders_flagged', opened));

  return jsonb_build_object('listings_stopped', killed, 'orders_flagged', opened);
end;
$$;

revoke execute on function public.cancel_resale_for_event(uuid) from public;
grant execute on function public.cancel_resale_for_event(uuid) to service_role;

-- A nech sa na to nezabudne: zrušenie eventu to spustí samo.
create or replace function public.resale_on_event_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.status = 'cancelled' and coalesce(old.status, 'draft') <> 'cancelled' then
    perform public.cancel_resale_for_event(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists events_resale_cancel on public.events;
create trigger events_resale_cancel
  after update of status on public.events
  for each row execute function public.resale_on_event_cancelled();
