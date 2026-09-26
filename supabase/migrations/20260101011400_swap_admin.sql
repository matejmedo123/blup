-- ============================================================================
-- BLUP SWAP — čo vidí a čo smie admin
-- ============================================================================
-- Spor medzi dvoma ľuďmi o peniaze musí niekto rozhodnúť a musí na to mať
-- podklady. „Otvorený spor" bez toho, čo sa predalo, za koľko, či vstupenka
-- dorazila a čo obe strany napísali, je len položka v zozname.
--
-- Funkcie sú zámerne dve: prehľad čísel a zoznam sporov. Jedna, ktorá by
-- vrátila oboje, by sa musela volať aj vtedy, keď admin chce len vidieť, či
-- je vôbec čo riešiť — a to je dotaz cez celú tabuľku objednávok kvôli
-- jednému číslu.
-- ============================================================================
set search_path = public, extensions;

-- --- čísla na prehľad --------------------------------------------------------
create or replace function public.swap_admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'live_listings',    (select count(*) from public.swap_live_listings),
    'open_disputes',    (select count(*) from public.resale_disputes
                          where status in ('open', 'investigating')),
    -- Predané a zaplatené, ale vstupenka ešte nie je u kupujúceho. Toto je
    -- číslo, ktoré má admin sledovať: každý deň tu je niekto, kto zaplatil a
    -- nič nedostal.
    'awaiting_delivery',(select count(*) from public.resale_orders
                          where payment_status = 'succeeded'
                            and order_status = 'waiting_for_ticket'),
    'held_payouts',     (select count(*) from public.seller_payouts
                          where status = 'pending' and held_reason is not null),
    'pending_payouts',  (select count(*) from public.seller_payouts
                          where status in ('pending', 'processing')),
    -- Obrat a príjem platformy, oboje len zo zaplatených objednávok.
    'gmv_cents',        (select coalesce(sum(total_cents), 0) from public.resale_orders
                          where payment_status = 'succeeded'),
    'revenue_cents',    (select coalesce(sum(buyer_fee_cents + seller_fee_cents), 0)
                          from public.resale_orders where payment_status = 'succeeded'),
    'refunded_cents',   (select coalesce(sum(refunded_cents), 0)
                          from public.resale_disputes where status = 'resolved'),
    'currency',         (select default_currency from public.platform_settings where id)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.swap_admin_overview() from public;
grant execute on function public.swap_admin_overview() to authenticated;

-- --- spory s podkladmi -------------------------------------------------------
create or replace function public.swap_admin_disputes(
  p_status text default 'open',
  p_limit  integer default 50
)
returns table (
  dispute_id      uuid,
  resale_order_id uuid,
  status          resale_dispute_status,
  reason          resale_dispute_reason,
  description     text,
  opened_at       timestamptz,
  resolution      resale_dispute_resolution,
  refunded_cents  integer,

  -- Podklady, bez ktorých sa rozhodnúť nedá
  event_title     text,
  event_start_at  timestamptz,
  source          resale_source,
  total_cents     integer,
  seller_net_cents integer,
  currency        text,
  paid_at         timestamptz,
  delivered_at    timestamptz,
  has_file        boolean,
  transfer_note   text,

  buyer_id        uuid,
  buyer_name      text,
  seller_id       uuid,
  seller_name     text,
  -- Riziko predajcu je tu preto, aby sa druhý a tretí spor toho istého
  -- človeka nerozhodoval, akoby bol prvý.
  seller_risk     text,
  seller_disputes integer
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return query
  select
    d.id, d.resale_order_id, d.status, d.reason, d.description, d.created_at,
    d.resolution, d.refunded_cents,
    e.title, e.start_at, o.source, o.total_cents, o.seller_net_cents, o.currency,
    o.paid_at, o.delivered_at,
    exists (select 1 from public.resale_deliveries dd
            where dd.resale_order_id = o.id and dd.file_path is not null),
    (select dd.transfer_note from public.resale_deliveries dd
     where dd.resale_order_id = o.id order by dd.delivered_at desc limit 1),
    o.buyer_id, bp.display_name, o.seller_id, sp.display_name,
    (public.resale_seller_risk(o.seller_id)->>'level'),
    (public.resale_seller_risk(o.seller_id)->>'disputes')::integer
  from public.resale_disputes d
  join public.resale_orders o on o.id = d.resale_order_id
  join public.events e on e.id = o.event_id
  join public.profiles bp on bp.id = o.buyer_id
  join public.profiles sp on sp.id = o.seller_id
  where case p_status
    when 'open'     then d.status in ('open', 'investigating')
    when 'resolved' then d.status in ('resolved', 'rejected')
    else true
  end
  order by d.created_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

revoke execute on function public.swap_admin_disputes(text, integer) from public;
grant execute on function public.swap_admin_disputes(text, integer) to authenticated;

-- --- zadržané výplaty --------------------------------------------------------
create or replace function public.swap_admin_payouts(p_limit integer default 50)
returns table (
  payout_id      uuid,
  seller_id      uuid,
  seller_name    text,
  amount_cents   integer,
  currency       text,
  status         payout_status,
  held_reason    text,
  requested_at   timestamptz,
  seller_risk    text,
  open_disputes  integer
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return query
  select
    p.id, p.seller_id, pr.display_name, p.amount_cents, p.currency,
    p.status, p.held_reason, p.requested_at,
    (public.resale_seller_risk(p.seller_id)->>'level'),
    (select count(*)::integer from public.resale_disputes d
     join public.resale_orders o on o.id = d.resale_order_id
     where o.seller_id = p.seller_id and d.status in ('open', 'investigating'))
  from public.seller_payouts p
  join public.profiles pr on pr.id = p.seller_id
  where p.status in ('pending', 'processing')
  order by (p.held_reason is not null) desc, p.requested_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

revoke execute on function public.swap_admin_payouts(integer) from public;
grant execute on function public.swap_admin_payouts(integer) to authenticated;

-- --- uvoľnenie zadržanej výplaty --------------------------------------------
-- Zadržanie nastavuje systém (spor, zrušený event, riziko); uvoľniť ho smie
-- len človek, a zapíše sa to do stopy aj s dôvodom.
create or replace function public.release_seller_payout(
  p_payout_id uuid,
  p_note      text default null
)
returns public.seller_payouts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  p  public.seller_payouts;
begin
  if not public.is_full_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into p from public.seller_payouts where id = p_payout_id for update;
  if not found then
    raise exception 'PAYOUT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p.status <> 'pending' then
    raise exception 'PAYOUT_NOT_HELD' using errcode = 'P0001';
  end if;

  -- Uvoľniť výplatu človeku, ktorý má otvorený spor, je takmer vždy chyba —
  -- peniaze odídu a nie je ich odkiaľ vrátiť. Nie je to zakázané (admin môže
  -- vedieť viac), ale musí to vedome napísať.
  if exists (
    select 1 from public.resale_disputes d
    join public.resale_orders o on o.id = d.resale_order_id
    where o.seller_id = p.seller_id and d.status in ('open', 'investigating')
  ) and coalesce(btrim(p_note), '') = '' then
    raise exception 'OPEN_DISPUTE_NEEDS_NOTE' using errcode = 'P0001';
  end if;

  update public.seller_payouts
  set held_reason = null, failure_reason = null
  where id = p.id
  returning * into p;

  perform public.log_resale(me, 'payout_released', 'seller_payout', p.id,
    jsonb_build_object('amount_cents', p.amount_cents, 'note', nullif(btrim(p_note), '')));

  return p;
end;
$$;

revoke execute on function public.release_seller_payout(uuid, text) from public;
grant execute on function public.release_seller_payout(uuid, text) to authenticated;
