-- ============================================================================
-- BLUP SWAP — voľná cena a odporúčanie ceny podľa trhu
-- ============================================================================
-- Doteraz platilo, že vstupenku z BLUPu nepredáš drahšie, než si za ňu dal.
-- To z burzy robí len spôsob, ako sa nepohodlnej vstupenky zbaviť — nie
-- burzu. Resell znamená, že cenu určuje predajca a trh, nie pôvodná faktúra.
--
-- Takže: strop padá. Nezmizne však z databázy, lebo v niektorých krajinách je
-- strop prirážky zákonná povinnosť (napr. limit na resell nad nominálnu
-- hodnotu) a keď sa BLUP tam dostane, nemá sa to dopisovať narýchlo. Preto
-- pribúda spínač `resale_price_cap_enabled`, ktorý je štandardne VYPNUTÝ.
-- Kým je vypnutý, `resale_max_markup_bps` sa neuplatňuje vôbec.
--
-- Namiesto zákazu príde rada. Keď predajca píše cenu, appka mu ukáže, za
-- koľko sa tá istá vstupenka na tom istom evente reálne ponúka a predáva, a
-- navrhne tri ceny: rýchly predaj, vyvážená, maximum. To je to, čo predajcovi
-- naozaj pomôže — strop mu len povie „nie".
-- ============================================================================

-- --- spínač stropu -----------------------------------------------------------

alter table public.platform_settings
  add column if not exists resale_price_cap_enabled boolean not null default false;

comment on column public.platform_settings.resale_price_cap_enabled is
  'Keď je true, create_resale_listing vynúti resale_max_markup_bps nad pôvodnou '
  'cenou BLUP vstupenky. Štandardne false — cenu si určuje predajca.';

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

-- --- odporúčanie ceny --------------------------------------------------------
-- Vracia iba agregáty, nikdy nie cenu konkrétneho človeka.
--
-- Živé ponuky sú aj tak verejné (kupujúci ich vidí v zozname), takže tie sa
-- ukazujú od prvej. Predané ceny verejné NIE SÚ — `resale_orders` vidí len
-- kupujúci a predajca. Preto sa medián predajov ukáže až od troch predajov:
-- pri jednom alebo dvoch by sa z mediánu dala spätne dopočítať suma, ktorú
-- dostal konkrétny človek, a to nikomu do ruky nepatrí.
--
-- Vlastné ponuky sa z trhu vynechávajú. Odporúčanie má hovoriť o konkurencii;
-- ak si jediný predajca, nemá zmysel radiť ti podľa seba samého.
create or replace function public.resale_price_hint(
  p_event_id  uuid,
  p_ticket_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  me        uuid := auth.uid();
  fees      jsonb;
  cur       text;
  face      integer;
  ev        record;

  live_n    integer := 0;
  live_min  integer;
  live_p25  integer;
  live_mid  integer;
  live_p75  integer;
  live_max  integer;

  sold_n    integer := 0;
  sold_min  integer;
  sold_mid  integer;
  sold_max  integer;

  basis     integer;
  fast      integer;
  balanced  integer;
  top       integer;
  min_price constant integer := 50;
begin
  fees := public.resale_fees();

  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  cur := coalesce(ev.currency, fees->>'currency');

  -- Nominálna hodnota: pri vlastnej vstupenke ju poznáme presne.
  if p_ticket_id is not null then
    select t.price_cents into face
      from public.tickets t
     where t.id = p_ticket_id and t.buyer_id = me;
  end if;

  -- Živé ponuky konkurencie na tom istom evente.
  select
    count(*)::integer,
    min(l.price_cents)::integer,
    percentile_cont(0.25) within group (order by l.price_cents)::integer,
    percentile_cont(0.50) within group (order by l.price_cents)::integer,
    percentile_cont(0.75) within group (order by l.price_cents)::integer,
    max(l.price_cents)::integer
    into live_n, live_min, live_p25, live_mid, live_p75, live_max
    from public.resale_listings l
   where l.event_id = p_event_id
     and l.status in ('active', 'reserved')
     and (l.expires_at is null or l.expires_at > now())
     and (me is null or l.seller_id <> me);

  -- Čo sa naozaj predalo. Za 180 dní; kratšie okno by pri menších eventoch
  -- nevrátilo nič a odporúčanie by stálo len na ponukách, teda na prianiach.
  select
    count(*)::integer,
    min(o.ticket_price_cents)::integer,
    percentile_cont(0.50) within group (order by o.ticket_price_cents)::integer,
    max(o.ticket_price_cents)::integer
    into sold_n, sold_min, sold_mid, sold_max
    from public.resale_orders o
   where o.event_id = p_event_id
     and o.paid_at is not null
     and o.order_status not in ('cancelled', 'refunded')
     and o.paid_at > now() - interval '180 days';

  if sold_n < 3 then
    sold_min := null; sold_mid := null; sold_max := null;
  end if;

  -- Základ odporúčania: najprv to, čo ľudia naozaj zaplatili, potom to, čo
  -- ľudia pýtajú, a až nakoniec nominálna hodnota.
  basis := coalesce(sold_mid, live_mid, face);

  if basis is not null then
    -- Rýchly predaj: tesne pod najlacnejšou konkurenčnou ponukou. Keď žiadna
    -- nie je, desatinu pod základom.
    fast := case
      when live_min is not null then greatest(live_min - greatest(live_min / 100, 50), min_price)
      else greatest((basis * 90) / 100, min_price)
    end;

    balanced := greatest(basis, min_price);

    -- Maximum: horný kvartil ponúk, ak je z čoho počítať; inak o sedminu nad
    -- základom. Nie je to sľub, že sa za to predá — je to hranica, nad ktorou
    -- už ponuka z trhu vyčnieva.
    top := case
      when live_n >= 3 then greatest(live_p75, balanced)
      when sold_max is not null then greatest(sold_max, balanced)
      else (basis * 115) / 100
    end;

    -- Tri návrhy musia byť tri rôzne čísla. Keď sa predávalo drahšie, než sa
    -- teraz ponúka, horný kvartil ponúk vyjde POD mediánom predajov a
    -- „Maximum" by sa zlialo s „Vyváženou" — predajca by videl dvakrát to isté
    -- a rada by prestala byť radou. Vtedy sa maximum drží desatinu nad stredom.
    balanced := greatest(balanced, fast);
    top      := greatest(top, balanced + balanced / 10);
  end if;

  return jsonb_build_object(
    'currency',        cur,
    'seller_fee_bps',  (fees->>'seller_fee_bps')::integer,
    'min_price_cents', min_price,
    'face_value_cents', face,
    'live', jsonb_build_object(
      'count',       coalesce(live_n, 0),
      'min_cents',   live_min,
      'p25_cents',   live_p25,
      'median_cents', live_mid,
      'p75_cents',   live_p75,
      'max_cents',   live_max
    ),
    'sold', jsonb_build_object(
      'count',        case when sold_n >= 3 then sold_n else 0 end,
      'min_cents',    sold_min,
      'median_cents', sold_mid,
      'max_cents',    sold_max,
      'window_days',  180
    ),
    'suggest', case when basis is null then null else jsonb_build_object(
      'fast_cents',     fast,
      'balanced_cents', balanced,
      'top_cents',      top
    ) end
  );
end;
$$;

revoke execute on function public.resale_price_hint(uuid, uuid) from public;
grant execute on function public.resale_price_hint(uuid, uuid) to authenticated;

-- ============================================================================
-- Vypísanie vstupenky — cenu určuje predajca
-- ============================================================================
-- Oproti 20260101010600 sa menia presne dve veci:
--
--   1. Strop prirážky sa vynúti IBA keď je `resale_price_cap_enabled`.
--      Štandardne je vypnutý, takže BLUP vstupenku vypíšeš za akúkoľvek cenu
--      a pôvodná cena je už len informácia (uloží sa do `face_value_cents`,
--      nech kupujúci vidí, čo stála v predpredaji).
--   2. Pribudla spodná hranica 50 centov. Nie je to morálka, je to platobná
--      brána: platbu pod pol eura Stripe odmietne a objednávka by uviazla v
--      `payment_pending` bez toho, aby ktokoľvek vedel prečo.
create or replace function public.create_resale_listing(
  p_event_id        uuid,
  p_source          resale_source,
  p_price_cents     integer,
  p_ticket_id       uuid default null,
  p_quantity        integer default 1,
  p_delivery_method resale_delivery_method default null,
  p_section         text default null,
  p_row_label       text default null,
  p_seat_label      text default null,
  p_ticket_label    text default null,
  p_external_provider  text default null,
  p_external_reference text default null,
  p_face_value_cents   integer default null,
  p_note            text default null
)
returns public.resale_listings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me       uuid := auth.uid();
  ev       record;
  tk       record;
  fees     jsonb;
  delivery resale_delivery_method;
  face     integer;
  ceiling  integer;
  created  public.resale_listings;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  fees := public.resale_fees();
  if not (fees->>'enabled')::boolean then
    raise exception 'RESALE_DISABLED' using errcode = 'P0001';
  end if;

  if p_price_cents is null then
    raise exception 'INVALID_PRICE' using errcode = 'P0001';
  end if;
  if p_price_cents < (fees->>'min_price_cents')::integer then
    raise exception 'PRICE_TOO_LOW' using errcode = 'P0001';
  end if;

  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if ev.status = 'cancelled' then
    raise exception 'EVENT_CANCELLED' using errcode = 'P0001';
  end if;
  if ev.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE' using errcode = 'P0001';
  end if;
  if coalesce(ev.end_at, ev.start_at) <= now() then
    raise exception 'EVENT_FINISHED' using errcode = 'P0001';
  end if;

  if p_source = 'blup' then
    -- Naša vstupenka. Tu sa dá overiť všetko, tak sa aj overí.
    delivery := 'blup_transfer';

    select * into tk from public.tickets where id = p_ticket_id;
    if not found then
      raise exception 'TICKET_NOT_FOUND' using errcode = 'P0001';
    end if;
    if tk.buyer_id <> me then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
    if tk.event_id <> p_event_id then
      raise exception 'TICKET_EVENT_MISMATCH' using errcode = 'P0001';
    end if;
    if tk.status <> 'valid' then
      raise exception 'TICKET_NOT_VALID' using errcode = 'P0001';
    end if;
    if tk.checked_in_at is not null then
      raise exception 'TICKET_ALREADY_USED' using errcode = 'P0001';
    end if;

    -- Pôvodná cena sa uloží ako údaj, nie ako strop.
    face := tk.price_cents;

    if (fees->>'price_cap_enabled')::boolean then
      ceiling := face + (face * (fees->>'max_markup_bps')::integer) / 10000;
      if p_price_cents > ceiling then
        raise exception 'PRICE_ABOVE_CAP' using errcode = 'P0001';
      end if;
    end if;

    if coalesce(p_quantity, 1) <> 1 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
    end if;
  else
    -- Vstupenka odinakiaľ. Nevieme o nej nič a netvárime sa, že vieme:
    -- `face_value_cents` je údaj od predajcu, nie overená hodnota.
    delivery := coalesce(p_delivery_method, 'file');
    if delivery = 'blup_transfer' then
      raise exception 'INVALID_DELIVERY_METHOD' using errcode = 'P0001';
    end if;
    face := p_face_value_cents;
    if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
    end if;
  end if;

  insert into public.resale_listings (
    event_id, seller_id, source, ticket_id,
    external_provider, external_reference,
    ticket_label, section, row_label, seat_label,
    quantity, price_cents, currency, face_value_cents,
    delivery_method, status, note,
    expires_at
  ) values (
    p_event_id, me, p_source,
    case when p_source = 'blup' then p_ticket_id else null end,
    case when p_source = 'external' then nullif(btrim(p_external_provider), '') else null end,
    case when p_source = 'external' then nullif(btrim(p_external_reference), '') else null end,
    nullif(btrim(p_ticket_label), ''),
    nullif(btrim(p_section), ''),
    nullif(btrim(p_row_label), ''),
    nullif(btrim(p_seat_label), ''),
    coalesce(p_quantity, 1), p_price_cents,
    coalesce(ev.currency, (fees->>'currency')), face,
    delivery, 'active', nullif(btrim(p_note), ''),
    ev.start_at
  )
  returning * into created;

  return created;
end;
$$;

revoke execute on function public.create_resale_listing(
  uuid, resale_source, integer, uuid, integer, resale_delivery_method,
  text, text, text, text, text, text, integer, text) from public;
grant execute on function public.create_resale_listing(
  uuid, resale_source, integer, uuid, integer, resale_delivery_method,
  text, text, text, text, text, text, integer, text) to authenticated;
