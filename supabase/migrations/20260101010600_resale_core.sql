-- ============================================================================
-- Burza vstupeniek — jadro
-- ============================================================================
-- Ďalší predaj vstupenky medzi dvoma ľuďmi. Platforma stojí medzi nimi: drží
-- peniaze, pozná obe strany a vie, čo sa predalo.
--
-- Dva druhy vstupeniek a je medzi nimi zásadný rozdiel, ktorý sa nesmie
-- rozmazať:
--
--   'blup'      vydali sme ju my. Riadok v `tickets` je náš, takže pri predaji
--               prepíšeme vlastníka, vygenerujeme nový QR kód a starý
--               zneplatníme. Pôvodný majiteľ sa s ňou dnu nedostane. Toto je
--               skutočné overenie pravosti a dá sa podložiť.
--
--   'external'  z Ticketportalu, Predpredaja, odkiaľkoľvek. Do ich databázy
--               nevidíme, takže pravosť overiť NEVIEME a appka to ani tvrdiť
--               nesmie. PDF môže byť dokonalý falzifikát, alebo pravé, ale už
--               predané trom ďalším ľuďom. Čo vieme ponúknuť je ochrana peňazí:
--               držíme ich, kým kupujúci nepotvrdí vstup.
--
-- Preto `source` nie je len informatívny údaj. Rozhoduje o tom, čo sa človeku
-- zobrazí, kedy predajca dostane peniaze a aké prísne je risk pravidlo.
--
-- Peniaze sú všade v centoch, ako inde v projekte. Cena sa počíta na serveri
-- (`quote_resale`) a z frontendu sa neberie nikdy — rovnako ako pri
-- `quote_order` pre primárny predaj.
-- ============================================================================
set search_path = public, extensions;

-- --- typy --------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'resale_source') then
    create type resale_source as enum ('blup', 'external');
  end if;

  if not exists (select 1 from pg_type where typname = 'resale_listing_status') then
    create type resale_listing_status as enum (
      'draft', 'active', 'reserved', 'sold', 'cancelled', 'expired'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'resale_delivery_method') then
    create type resale_delivery_method as enum (
      -- Prevod v BLUPe: nič sa neposiela, prepíše sa vlastník. Jediná možnosť
      -- pre naše vstupenky a jediná, ktorú vieme naozaj zaručiť.
      'blup_transfer',
      'file',            -- PDF alebo obrázok do súkromného úložiska
      'mobile_transfer', -- prevod v appke pôvodnej platformy
      'other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'resale_order_status') then
    create type resale_order_status as enum (
      'created',
      'payment_pending',
      'paid',
      'waiting_for_ticket',
      'ticket_delivered',
      'completed',
      'disputed',
      'cancelled',
      'refunded'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'resale_reservation_status') then
    create type resale_reservation_status as enum (
      'active', 'expired', 'converted', 'cancelled'
    );
  end if;
end $$;

-- --- nastavenia burzy --------------------------------------------------------
--
-- Do `platform_settings`, lebo tam už žijú poplatky primárneho predaja a
-- admin ich vie meniť bez zásahu do kódu (§43 zadania: pravidlá sa musia dať
-- meniť bez prerábania appky).
alter table public.platform_settings
  add column if not exists resale_enabled boolean not null default true,
  -- Poplatky burzy sú oddelené od primárneho predaja. Kupujúci platí navrch,
  -- predajcovi sa strháva z jeho podielu — obe strany vidia svoje číslo.
  add column if not exists resale_buyer_fee_bps integer not null default 500
    check (resale_buyer_fee_bps between 0 and 3000),
  add column if not exists resale_seller_fee_bps integer not null default 500
    check (resale_seller_fee_bps between 0 and 3000),
  -- Strop na prirážku voči pôvodnej cene. Platí len na BLUP vstupenky, lebo
  -- len pri nich pôvodnú cenu poznáme. 0 = predaj najviac za toľko, za koľko
  -- sa kúpila. Toto je zámerne prísny východzí stav; admin ho vie zmeniť.
  add column if not exists resale_max_markup_bps integer not null default 0
    check (resale_max_markup_bps between 0 and 100000),
  -- Ako dlho drží rezervácia listing, kým kupujúci platí.
  add column if not exists resale_hold_minutes integer not null default 15
    check (resale_hold_minutes between 2 and 120),
  -- Po koľkých dňoch OD KONCA EVENTU sú peniaze predajcu k dispozícii.
  -- Zámerne po evente, nie po platbe: kým sa event neodohrá, nevieme, či sa
  -- kupujúci naozaj dostal dnu.
  add column if not exists resale_settlement_days integer not null default 2
    check (resale_settlement_days between 0 and 90);

-- --- listing -----------------------------------------------------------------
create table if not exists public.resale_listings (
  id                 uuid primary key default gen_random_uuid(),
  event_id           uuid not null references public.events (id) on delete cascade,
  seller_id          uuid not null references public.profiles (id) on delete cascade,
  source             resale_source not null,

  -- Len pre source='blup'. `restrict` zámerne: vstupenka, na ktorú je
  -- vypísaný listing, sa nesmie stratiť spod neho.
  ticket_id          uuid references public.tickets (id) on delete restrict,

  -- Len pre source='external'. Referencia je pre predajcu a pre podporu, nie
  -- dôkaz čohokoľvek — nič z toho nevieme overiť.
  external_provider  text,
  external_reference text,

  ticket_label       text,
  section            text,
  row_label          text,
  seat_label         text,

  quantity           integer not null check (quantity between 1 and 20),
  price_cents        integer not null check (price_cents >= 0),
  currency           text not null default 'EUR' check (char_length(currency) = 3),
  -- Pôvodná cena, ak ju poznáme. Pri BLUP vstupenke ju poznáme vždy a používa
  -- sa na strop prirážky; pri externej je to údaj od predajcu.
  face_value_cents   integer check (face_value_cents >= 0),

  delivery_method    resale_delivery_method not null,
  status             resale_listing_status not null default 'draft',
  note               text,

  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint resale_listings_note_len check (note is null or char_length(note) <= 500),
  -- BLUP vstupenka musí ukazovať na konkrétny riadok a prevádza sa u nás.
  -- Externá naň ukazovať nesmie a prevádzať sa u nás nedá.
  constraint resale_listings_source_shape check (
    (source = 'blup'
      and ticket_id is not null
      and delivery_method = 'blup_transfer')
    or
    (source = 'external'
      and ticket_id is null
      and delivery_method <> 'blup_transfer')
  ),
  -- Jedna BLUP vstupenka je jeden kus. Množstvo nad jeden má zmysel len tam,
  -- kde predajca drží viac kusov mimo BLUPu.
  constraint resale_listings_blup_single check (source <> 'blup' or quantity = 1)
);

-- Tá istá vstupenka nesmie visieť na dvoch živých listingoch naraz.
create unique index if not exists resale_listings_ticket_live_key
  on public.resale_listings (ticket_id)
  where ticket_id is not null and status in ('draft', 'active', 'reserved');

create index if not exists resale_listings_event_idx
  on public.resale_listings (event_id, status, price_cents);
create index if not exists resale_listings_seller_idx
  on public.resale_listings (seller_id, created_at desc);
create index if not exists resale_listings_live_idx
  on public.resale_listings (status, expires_at)
  where status in ('active', 'reserved');

drop trigger if exists resale_listings_set_updated_at on public.resale_listings;
create trigger resale_listings_set_updated_at
  before update on public.resale_listings
  for each row execute function public.set_updated_at();

-- --- rezervácia --------------------------------------------------------------
--
-- Toto je ochrana proti tomu, aby dvaja ľudia kúpili ten istý listing. Držanie
-- je v databáze, nie v odpočte na fronte: prehliadač sa dá zavrieť, obnoviť aj
-- podvrhnúť, a rezervácia, ktorej platnosť stráži len on, nestráži nič.
create table if not exists public.resale_reservations (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.resale_listings (id) on delete cascade,
  buyer_id   uuid not null references public.profiles (id) on delete cascade,
  quantity   integer not null check (quantity >= 1),
  status     resale_reservation_status not null default 'active',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Jadro ochrany: na jeden listing smie existovať najviac jedna živá rezervácia.
-- Nie je to kontrola v kóde, ktorú sa dá pretekom obísť — je to obmedzenie
-- databázy, takže druhý súbežný pokus dostane chybu unikátneho indexu.
create unique index if not exists resale_reservations_one_live
  on public.resale_reservations (listing_id)
  where status = 'active';

create index if not exists resale_reservations_buyer_idx
  on public.resale_reservations (buyer_id, created_at desc);
create index if not exists resale_reservations_expiry_idx
  on public.resale_reservations (expires_at)
  where status = 'active';

-- --- objednávka --------------------------------------------------------------
create table if not exists public.resale_orders (
  id                  uuid primary key default gen_random_uuid(),
  listing_id          uuid not null references public.resale_listings (id) on delete restrict,
  event_id            uuid not null references public.events (id) on delete restrict,
  buyer_id            uuid not null references public.profiles (id) on delete restrict,
  seller_id           uuid not null references public.profiles (id) on delete restrict,
  source              resale_source not null,
  quantity            integer not null check (quantity >= 1),

  -- Čo platí kupujúci
  ticket_price_cents  integer not null check (ticket_price_cents >= 0),
  buyer_fee_cents     integer not null default 0 check (buyer_fee_cents >= 0),
  delivery_fee_cents  integer not null default 0 check (delivery_fee_cents >= 0),
  total_cents         integer not null check (total_cents >= 0),

  -- Čo dostane predajca
  seller_fee_cents    integer not null default 0 check (seller_fee_cents >= 0),
  seller_net_cents    integer not null check (seller_net_cents >= 0),

  currency            text not null check (char_length(currency) = 3),

  payment_status      payment_status not null default 'requires_payment',
  order_status        resale_order_status not null default 'created',
  provider            payment_provider not null default 'stripe',
  provider_reference  text,

  expires_at          timestamptz not null default now() + interval '30 minutes',
  paid_at             timestamptz,
  delivered_at        timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  refunded_at         timestamptz,
  failure_reason      text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Súčet musí sedieť na cent. Toto nie je poistka proti útoku, ale proti
  -- vlastnej chybe: keby niekde pribudol poplatok a zabudlo sa na súčet,
  -- databáza to nepustí ďalej.
  constraint resale_orders_total_adds_up check (
    total_cents = ticket_price_cents + buyer_fee_cents + delivery_fee_cents
  ),
  constraint resale_orders_seller_adds_up check (
    seller_net_cents = ticket_price_cents - seller_fee_cents
  ),
  -- Človek nesmie kúpiť sám od seba. Bol by to spôsob, ako si vyrobiť
  -- históriu predajov, a pri poplatkoch aj ako prať peniaze.
  constraint resale_orders_not_self check (buyer_id <> seller_id)
);

-- Ten istý PaymentIntent nesmie založiť dve objednávky, nech webhook príde
-- koľkokrát chce.
create unique index if not exists resale_orders_provider_reference_key
  on public.resale_orders (provider, provider_reference)
  where provider_reference is not null;

create index if not exists resale_orders_buyer_idx  on public.resale_orders (buyer_id, created_at desc);
create index if not exists resale_orders_seller_idx on public.resale_orders (seller_id, created_at desc);
create index if not exists resale_orders_event_idx  on public.resale_orders (event_id, created_at desc);
create index if not exists resale_orders_listing_idx on public.resale_orders (listing_id);
create index if not exists resale_orders_open_idx
  on public.resale_orders (order_status, expires_at)
  where order_status in ('created', 'payment_pending');

drop trigger if exists resale_orders_set_updated_at on public.resale_orders;
create trigger resale_orders_set_updated_at
  before update on public.resale_orders
  for each row execute function public.set_updated_at();

-- --- platby zdieľajú tabuľku s primárnym predajom ----------------------------
--
-- Rovnaká tabuľka zámerne: `payments` už má unikátnu dvojicu
-- (provider, provider_reference), čiže idempotenciu webhooku, a admin má jedno
-- miesto, kde vidí všetky pohyby. Druhá tabuľka by znamenala druhú
-- implementáciu toho istého — a jedna z nich by sa časom rozišla.
alter table public.payments
  add column if not exists resale_order_id uuid references public.resale_orders (id) on delete set null;

create index if not exists payments_resale_order_idx on public.payments (resale_order_id);

alter table public.payments drop constraint if exists payments_one_order;
alter table public.payments add constraint payments_one_order check (
  order_id is null or resale_order_id is null
);

-- ============================================================================
-- Cena. Jedno miesto, server, a frontend ju iba zobrazuje.
-- ============================================================================
-- Rovnaký tvar ako `quote_order` pre primárny predaj: vráti `valid` a pri
-- neplatnom stave `reason` s kódom, ktorý appka vie preložiť. Keby si cenu
-- rátal frontend, stačilo by poslať iné číslo — preto ju neposiela vôbec a
-- checkout si ju vypýta tu.
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
    'hold_minutes',       s.resale_hold_minutes,
    'settlement_days',    s.resale_settlement_days,
    'currency',           s.default_currency
  )
  from public.platform_settings s
  where s.id;
$$;

revoke execute on function public.resale_fees() from public;
grant execute on function public.resale_fees() to anon, authenticated;

create or replace function public.quote_resale(
  p_listing_id uuid,
  p_quantity   integer default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  l        record;
  ev       record;
  fees     jsonb;
  me       uuid := auth.uid();
  ticket   integer;
  buyer_fee integer;
  seller_fee integer;
  reason   text;
  live_res integer;
begin
  fees := public.resale_fees();

  if not (fees->>'enabled')::boolean then
    return jsonb_build_object('valid', false, 'reason', 'RESALE_DISABLED');
  end if;

  if p_quantity is null or p_quantity < 1 then
    return jsonb_build_object('valid', false, 'reason', 'INVALID_QUANTITY');
  end if;

  select * into l from public.resale_listings where id = p_listing_id;
  if not found then
    return jsonb_build_object('valid', false, 'reason', 'LISTING_NOT_FOUND');
  end if;

  select * into ev from public.events where id = l.event_id;

  -- Rezervácia, ktorej už vypršal čas, listing nedrží — aj keď ju ešte
  -- neupratal cron. Čas sa číta tu, nie dôveruje sa stĺpcu `status`.
  select count(*) into live_res
  from public.resale_reservations r
  where r.listing_id = l.id
    and r.status = 'active'
    and r.expires_at > now()
    and r.buyer_id is distinct from me;

  if l.status = 'sold' then
    reason := 'LISTING_SOLD';
  elsif l.status in ('cancelled', 'expired') then
    reason := 'LISTING_NOT_AVAILABLE';
  elsif l.status = 'draft' then
    reason := 'LISTING_NOT_PUBLISHED';
  elsif live_res > 0 then
    reason := 'LISTING_RESERVED';
  elsif l.expires_at is not null and l.expires_at <= now() then
    reason := 'LISTING_EXPIRED';
  elsif p_quantity > l.quantity then
    reason := 'QUANTITY_ABOVE_LIMIT';
  elsif ev.status = 'cancelled' then
    reason := 'EVENT_CANCELLED';
  elsif ev.status <> 'published' then
    reason := 'EVENT_NOT_AVAILABLE';
  elsif coalesce(ev.end_at, ev.start_at) <= now() then
    reason := 'EVENT_FINISHED';
  elsif me is not null and me = l.seller_id then
    reason := 'OWN_LISTING';
  end if;

  ticket     := l.price_cents * p_quantity;
  buyer_fee  := (ticket * (fees->>'buyer_fee_bps')::integer) / 10000;
  seller_fee := (ticket * (fees->>'seller_fee_bps')::integer) / 10000;

  return jsonb_build_object(
    'valid',              reason is null,
    'reason',             reason,
    'listing_id',         l.id,
    'event_id',           l.event_id,
    'source',             l.source,
    -- Toto je to, čo appka ukáže ako štítok, a je to jediný údaj, z ktorého
    -- sa smie odvodiť tvrdenie o pravosti.
    'authenticity',       case when l.source = 'blup' then 'verified' else 'protected' end,
    'quantity',           p_quantity,
    'unit_price_cents',   l.price_cents,
    'ticket_price_cents', ticket,
    'buyer_fee_cents',    buyer_fee,
    'delivery_fee_cents', 0,
    'total_cents',        ticket + buyer_fee,
    'seller_fee_cents',   seller_fee,
    'seller_net_cents',   ticket - seller_fee,
    'currency',           l.currency,
    'hold_minutes',       (fees->>'hold_minutes')::integer
  );
end;
$$;

revoke execute on function public.quote_resale(uuid, integer) from public;
grant execute on function public.quote_resale(uuid, integer) to anon, authenticated;

-- ============================================================================
-- Vypísanie vstupenky
-- ============================================================================
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

  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'INVALID_PRICE' using errcode = 'P0001';
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

    -- Pôvodnú cenu poznáme, takže strop prirážky vieme naozaj vynútiť.
    face    := tk.price_cents;
    ceiling := face + (face * (fees->>'max_markup_bps')::integer) / 10000;
    if p_price_cents > ceiling then
      raise exception 'PRICE_ABOVE_CAP' using errcode = 'P0001';
    end if;

    if coalesce(p_quantity, 1) <> 1 then
      raise exception 'INVALID_QUANTITY' using errcode = 'P0001';
    end if;
  else
    -- Vstupenka odinakiaľ. Nevieme o nej nič a netvárime sa, že vieme:
    -- `face_value_cents` je údaj od predajcu, nie overená hodnota, a strop
    -- prirážky sa tu vynútiť nedá.
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
    -- Listing prestáva platiť, keď sa event začne. Predávať vstupenku na
    -- koncert, ktorý práve hrá, nemá komu pomôcť.
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

-- ============================================================================
-- Rezervácia — jediný kupujúci naraz
-- ============================================================================
-- Toto je najcitlivejšie miesto celej burzy. Dvaja ľudia klikajú „Kúpiť" v tej
-- istej sekunde na ten istý listing; jeden ho dostať musí a druhý nesmie.
--
-- Nerieši sa to čítaním stavu a následným zápisom — medzi tie dva kroky sa
-- druhá transakcia zmestí a obaja odídu s pocitom, že vstupenku majú. Riešia
-- to dve veci naraz:
--
--   1. `select ... for update` na riadku listingu. Druhá transakcia na ňom
--      počká a keď sa dostane k slovu, vidí už zmenený stav.
--   2. Unikátny index `resale_reservations_one_live`. Aj keby sa prvá poistka
--      obišla, databáza druhý živý záznam jednoducho nepustí.
--
-- Prvé je rýchlosť, druhé je záruka. Samotný zámok by stačil len dovtedy, kým
-- niekto nepridá druhú cestu k tej istej tabuľke.
create or replace function public.reserve_resale_listing(
  p_listing_id uuid,
  p_quantity   integer default 1
)
returns public.resale_reservations
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me      uuid := auth.uid();
  l       record;
  fees    jsonb;
  quote   jsonb;
  mine    public.resale_reservations;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  fees := public.resale_fees();

  -- Zámok na listingu. Od tejto chvíle je v tejto transakcii náš.
  select * into l from public.resale_listings where id = p_listing_id for update;
  if not found then
    raise exception 'LISTING_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Rezervácie, ktorým vypršal čas, sa upratú TU a nie až cronom. Cron beží
  -- raz za pár minút; kupujúci, ktorý sa díva na listing uvoľnený pred
  -- desiatimi sekundami, by dovtedy videl „rezervované" bez dôvodu.
  update public.resale_reservations
  set status = 'expired'
  where listing_id = l.id and status = 'active' and expires_at <= now();

  -- Ak si už rezerváciu držím ja, predĺži sa namiesto toho, aby druhý pokus
  -- spadol na vlastnom zázname.
  select * into mine
  from public.resale_reservations
  where listing_id = l.id and status = 'active' and buyer_id = me;

  if found then
    update public.resale_reservations
    set expires_at = now() + make_interval(mins => (fees->>'hold_minutes')::integer)
    where id = mine.id
    returning * into mine;
    return mine;
  end if;

  -- Až teraz sa pýtame na cenu a platnosť — po zámku, aby odpoveď nemohla
  -- zastarať medzi kontrolou a zápisom.
  quote := public.quote_resale(p_listing_id, p_quantity);
  if not (quote->>'valid')::boolean then
    raise exception '%', coalesce(quote->>'reason', 'LISTING_NOT_AVAILABLE')
      using errcode = 'P0001';
  end if;

  insert into public.resale_reservations (listing_id, buyer_id, quantity, expires_at)
  values (
    l.id, me, p_quantity,
    now() + make_interval(mins => (fees->>'hold_minutes')::integer)
  )
  returning * into mine;

  update public.resale_listings
  set status = 'reserved'
  where id = l.id and status = 'active';

  return mine;
end;
$$;

revoke execute on function public.reserve_resale_listing(uuid, integer) from public;
grant execute on function public.reserve_resale_listing(uuid, integer) to authenticated;

-- Pustenie rezervácie, keď kupujúci odíde z checkoutu.
create or replace function public.release_resale_reservation(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me  uuid := auth.uid();
  res record;
begin
  select * into res from public.resale_reservations where id = p_reservation_id;
  if not found then
    return false;
  end if;
  if res.buyer_id <> me and not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if res.status <> 'active' then
    return false;
  end if;

  update public.resale_reservations set status = 'cancelled' where id = res.id;
  update public.resale_listings
  set status = 'active'
  where id = res.listing_id and status = 'reserved';

  return true;
end;
$$;

revoke execute on function public.release_resale_reservation(uuid) from public;
grant execute on function public.release_resale_reservation(uuid) to authenticated;

-- Upratovanie pre cron. Vracia počet uvoľnených listingov, nech je v logu
-- vidieť, či job vôbec niečo robí.
create or replace function public.expire_resale_reservations()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  freed integer;
begin
  with dead as (
    update public.resale_reservations
    set status = 'expired'
    where status = 'active' and expires_at <= now()
    returning listing_id
  ),
  back as (
    update public.resale_listings l
    set status = 'active'
    where l.id in (select listing_id from dead)
      and l.status = 'reserved'
      -- Nie, ak medzitým pribudla iná živá rezervácia.
      and not exists (
        select 1 from public.resale_reservations r
        where r.listing_id = l.id and r.status = 'active' and r.expires_at > now()
      )
    returning 1
  )
  select count(*)::integer into freed from back;

  -- A listingy na eventy, ktoré sa medzitým začali alebo boli zrušené.
  update public.resale_listings l
  set status = 'expired'
  where l.status in ('active', 'reserved')
    and (
      (l.expires_at is not null and l.expires_at <= now())
      or exists (
        select 1 from public.events e
        where e.id = l.event_id
          and (e.status = 'cancelled' or coalesce(e.end_at, e.start_at) <= now())
      )
    );

  return coalesce(freed, 0);
end;
$$;

revoke execute on function public.expire_resale_reservations() from public;
grant execute on function public.expire_resale_reservations() to service_role;

-- Stiahnutie listingu predajcom.
create or replace function public.cancel_resale_listing(p_listing_id uuid)
returns public.resale_listings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
  l  public.resale_listings;
begin
  select * into l from public.resale_listings where id = p_listing_id for update;
  if not found then
    raise exception 'LISTING_NOT_FOUND' using errcode = 'P0001';
  end if;
  if l.seller_id <> me and not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if l.status = 'sold' then
    -- Predané sa stiahnuť nedá. Kupujúci už zaplatil a stiahnutie listingu by
    -- z jeho objednávky spravilo objednávku bez predmetu.
    raise exception 'LISTING_SOLD' using errcode = 'P0001';
  end if;

  update public.resale_reservations
  set status = 'cancelled'
  where listing_id = l.id and status = 'active';

  update public.resale_listings
  set status = 'cancelled'
  where id = l.id
  returning * into l;

  return l;
end;
$$;

revoke execute on function public.cancel_resale_listing(uuid) from public;
grant execute on function public.cancel_resale_listing(uuid) to authenticated;

-- ============================================================================
-- Kto čo vidí
-- ============================================================================
alter table public.resale_listings     enable row level security;
alter table public.resale_reservations enable row level security;
alter table public.resale_orders       enable row level security;

-- Listing je ponuka, takže ho vidí ktokoľvek — vrátane neprihláseného, ktorý
-- si prezerá event. Ale len ten živý: koncept a stiahnutý listing sú vec
-- predajcu.
drop policy if exists resale_listings_select on public.resale_listings;
create policy resale_listings_select on public.resale_listings
  for select using (
    status in ('active', 'reserved', 'sold')
    or seller_id = auth.uid()
    or public.is_admin()
  );

-- Zápis ide výhradne cez funkcie vyššie. Priamy insert by obišiel kontrolu
-- vlastníctva vstupenky aj strop ceny, takže tu žiadna insert politika nie je.
drop policy if exists resale_listings_update on public.resale_listings;
create policy resale_listings_update on public.resale_listings
  for update using (public.is_admin()) with check (public.is_admin());

-- Rezerváciu vidí ten, koho sa týka: kupujúci a predajca listingu.
drop policy if exists resale_reservations_select on public.resale_reservations;
create policy resale_reservations_select on public.resale_reservations
  for select using (
    buyer_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.resale_listings l
      where l.id = listing_id and l.seller_id = auth.uid()
    )
  );

-- Objednávku vidia obe strany a admin. Nikto iný — ani cez event, ani cez
-- listing.
drop policy if exists resale_orders_select on public.resale_orders;
create policy resale_orders_select on public.resale_orders
  for select using (
    buyer_id = auth.uid() or seller_id = auth.uid() or public.is_admin()
  );

drop policy if exists resale_orders_update on public.resale_orders;
create policy resale_orders_update on public.resale_orders
  for update using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- Čítanie pre appku
-- ============================================================================
-- Ponuky na evente, zoradené a s menom predajcu. Zámerne ako funkcia a nie
-- pohľad: appka potrebuje radenie a filtre a robiť to nad celou tabuľkou v
-- prehliadači znamená stiahnuť ju celú.
create or replace function public.event_resale_listings(
  p_event_id  uuid,
  p_sort      text default 'price_asc',
  p_max_price integer default null,
  p_quantity  integer default null,
  p_source    resale_source default null,
  p_limit     integer default 50
)
returns table (
  id              uuid,
  seller_id       uuid,
  seller_name     text,
  seller_username text,
  seller_avatar   text,
  source          resale_source,
  authenticity    text,
  section         text,
  row_label       text,
  seat_label      text,
  ticket_label    text,
  quantity        integer,
  price_cents     integer,
  face_value_cents integer,
  currency        text,
  delivery_method resale_delivery_method,
  note            text,
  status          resale_listing_status,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    l.id, l.seller_id, p.display_name, p.username, p.avatar_url,
    l.source,
    -- Jediné miesto, odkiaľ sa smie brať tvrdenie o pravosti. „verified" len
    -- pre naše vstupenky, lebo len tie vieme naozaj overiť.
    case when l.source = 'blup' then 'verified' else 'protected' end,
    l.section, l.row_label, l.seat_label, l.ticket_label,
    l.quantity, l.price_cents, l.face_value_cents, l.currency,
    l.delivery_method, l.note, l.status, l.created_at
  from public.resale_listings l
  join public.profiles p on p.id = l.seller_id
  where l.event_id = p_event_id
    and l.status = 'active'
    and (l.expires_at is null or l.expires_at > now())
    and not p.is_suspended
    and (p_max_price is null or l.price_cents <= p_max_price)
    and (p_quantity is null or l.quantity >= p_quantity)
    and (p_source is null or l.source = p_source)
    -- Listing s cudzou živou rezerváciou sa neponúka: klik na „Kúpiť" by
    -- skončil chybou a to je horšie než ho nevidieť.
    and not exists (
      select 1 from public.resale_reservations r
      where r.listing_id = l.id
        and r.status = 'active'
        and r.expires_at > now()
        and r.buyer_id is distinct from auth.uid()
    )
  order by
    case when p_sort = 'price_asc'  then l.price_cents end asc,
    case when p_sort = 'price_desc' then l.price_cents end desc,
    case when p_sort = 'newest'     then extract(epoch from l.created_at) end desc,
    l.price_cents asc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke execute on function public.event_resale_listings(
  uuid, text, integer, integer, resale_source, integer) from public;
grant execute on function public.event_resale_listings(
  uuid, text, integer, integer, resale_source, integer) to anon, authenticated;

-- Koľko sa na evente ponúka a za koľko — pre štítok „na burze od 25 €".
create or replace function public.event_resale_summary(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'listings',       count(*),
    'tickets',        coalesce(sum(l.quantity), 0),
    'from_cents',     min(l.price_cents),
    'verified_count', count(*) filter (where l.source = 'blup'),
    'currency',       min(l.currency)
  )
  from public.resale_listings l
  join public.profiles p on p.id = l.seller_id
  where l.event_id = p_event_id
    and l.status = 'active'
    and (l.expires_at is null or l.expires_at > now())
    and not p.is_suspended;
$$;

revoke execute on function public.event_resale_summary(uuid) from public;
grant execute on function public.event_resale_summary(uuid) to anon, authenticated;

-- Moje listingy — pre predajcov prehľad.
create or replace function public.my_resale_listings(p_limit integer default 50)
returns table (
  id            uuid,
  event_id      uuid,
  event_title   text,
  event_start_at timestamptz,
  source        resale_source,
  section       text,
  row_label     text,
  seat_label    text,
  quantity      integer,
  price_cents   integer,
  currency      text,
  status        resale_listing_status,
  order_id      uuid,
  order_status  resale_order_status,
  seller_net_cents integer,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    l.id, l.event_id, e.title, e.start_at, l.source,
    l.section, l.row_label, l.seat_label, l.quantity, l.price_cents, l.currency,
    l.status, o.id, o.order_status, o.seller_net_cents, l.created_at
  from public.resale_listings l
  join public.events e on e.id = l.event_id
  left join lateral (
    select ro.* from public.resale_orders ro
    where ro.listing_id = l.id and ro.order_status <> 'cancelled'
    order by ro.created_at desc
    limit 1
  ) o on true
  where l.seller_id = auth.uid()
  order by l.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke execute on function public.my_resale_listings(integer) from public;
grant execute on function public.my_resale_listings(integer) to authenticated;
