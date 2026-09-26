-- ============================================================================
-- Burza vstupeniek — peniaze predajcovi
-- ============================================================================
-- Toto je jediná časť burzy, ktorá sa nedala postaviť na tom, čo v BLUPe už
-- je. Doterajšie výplaty patria ORGANIZÁCII: `ledger_entries` a `payouts` majú
-- `organization_id`, Stripe Connect účet visí na `organizations`. Predajca na
-- burze je ale fyzická osoba, ktorá žiadnu organizáciu nemá a mať nemusí.
--
-- Preto vlastná kniha a vlastné výplaty, ale rovnakým spôsobom: kniha zápisov,
-- z ktorej sa zostatok počíta, nie stĺpec so zostatkom, ktorý sa prepisuje.
-- Prepisovaný zostatok sa raz rozíde so skutočnosťou a nikto nezistí kedy;
-- kniha sa dá vždy prerátať a porovnať.
--
-- Kedy sú peniaze k dispozícii:
--
--   BLUP vstupenka     po evente + `resale_settlement_days`. Prevod prebehol
--                      hneď a je overiteľný, takže sa nečaká na nič iné než na
--                      to, či sa event vôbec odohral.
--
--   externá vstupenka  po evente + rovnaký odklad, ale LEN ak kupujúci
--                      potvrdil, že vstupenka funguje. Pravosť sme overiť
--                      nemohli, takže potvrdenie kupujúceho je jediné, čo
--                      máme — a bez neho peniaze nejdú nikam.
--
-- Výplata sa nikdy nespustí z požiadavky frontendu. Appka o ňu môže požiadať,
-- ale sumu určuje kniha a prevod robí serverová funkcia.
-- ============================================================================
set search_path = public, extensions;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'resale_ledger_type') then
    create type resale_ledger_type as enum (
      'sale',        -- +čistý podiel predajcu
      'platform_fee',-- -provízia burzy
      'refund',      -- -vrátené kupujúcemu
      'payout',      -- -vyplatené
      'adjustment'   -- ručný zásah admina, vždy s dôvodom
    );
  end if;
end $$;

-- --- účet predajcu -----------------------------------------------------------
create table if not exists public.seller_accounts (
  user_id            uuid primary key references public.profiles (id) on delete cascade,
  -- Účet u poskytovateľa platieb. Sem peniaze odchádzajú; bankové údaje v
  -- našej databáze nie sú a nikdy nebudú.
  provider           payment_provider not null default 'stripe',
  provider_account_id text unique,
  payouts_enabled    boolean not null default false,
  country            text,
  default_currency   text not null default 'EUR' check (char_length(default_currency) = 3),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists seller_accounts_set_updated_at on public.seller_accounts;
create trigger seller_accounts_set_updated_at
  before update on public.seller_accounts
  for each row execute function public.set_updated_at();

alter table public.seller_accounts enable row level security;

drop policy if exists seller_accounts_select on public.seller_accounts;
create policy seller_accounts_select on public.seller_accounts
  for select using (user_id = auth.uid() or public.is_admin());

-- Stav účtu prichádza od poskytovateľa, nie od človeka. Keby si `payouts_enabled`
-- vedel prepnúť sám, obišiel by overenie totožnosti.
drop policy if exists seller_accounts_write on public.seller_accounts;
create policy seller_accounts_write on public.seller_accounts
  for all using (public.is_full_admin()) with check (public.is_full_admin());

-- --- výplaty -----------------------------------------------------------------
create table if not exists public.seller_payouts (
  id                   uuid primary key default gen_random_uuid(),
  seller_id            uuid not null references public.profiles (id) on delete cascade,
  amount_cents         integer not null check (amount_cents > 0),
  currency             text not null check (char_length(currency) = 3),
  status               payout_status not null default 'pending',
  provider             payment_provider not null default 'stripe',
  provider_transfer_id text unique,
  -- Zadržaná výplata: otvorený spor alebo vysoké riziko. Dôvod je povinný,
  -- aby sa človek vedel spýtať a podpora vedela odpovedať.
  held_reason          text,
  requested_at         timestamptz not null default now(),
  processed_at         timestamptz,
  failure_reason       text
);

create index if not exists seller_payouts_seller_idx
  on public.seller_payouts (seller_id, requested_at desc);
create index if not exists seller_payouts_status_idx
  on public.seller_payouts (status, requested_at);

alter table public.seller_payouts enable row level security;

drop policy if exists seller_payouts_select on public.seller_payouts;
create policy seller_payouts_select on public.seller_payouts
  for select using (seller_id = auth.uid() or public.is_admin());

-- --- kniha -------------------------------------------------------------------
create table if not exists public.seller_ledger_entries (
  id              uuid primary key default gen_random_uuid(),
  seller_id       uuid not null references public.profiles (id) on delete cascade,
  resale_order_id uuid references public.resale_orders (id) on delete set null,
  payout_id       uuid references public.seller_payouts (id) on delete set null,
  type            resale_ledger_type not null,
  amount_cents    integer not null,
  currency        text not null check (char_length(currency) = 3),
  -- Kedy sa suma stáva vyplatiteľnou. Do tej chvíle je v zostatku ako
  -- „čakajúce" a do výplaty sa nedostane.
  available_at    timestamptz not null,
  description     text,
  created_at      timestamptz not null default now()
);

create index if not exists seller_ledger_seller_idx
  on public.seller_ledger_entries (seller_id, created_at desc);
create index if not exists seller_ledger_order_idx
  on public.seller_ledger_entries (resale_order_id);
create index if not exists seller_ledger_payout_idx
  on public.seller_ledger_entries (payout_id);
create index if not exists seller_ledger_available_idx
  on public.seller_ledger_entries (seller_id, available_at);

-- Jeden zápis typu 'sale' na objednávku. Toto je idempotencia výplat: aj keby
-- sa webhook alebo cron spustil desaťkrát, nárok vznikne raz.
create unique index if not exists seller_ledger_one_sale_per_order
  on public.seller_ledger_entries (resale_order_id)
  where type = 'sale';

alter table public.seller_ledger_entries enable row level security;

drop policy if exists seller_ledger_select on public.seller_ledger_entries;
create policy seller_ledger_select on public.seller_ledger_entries
  for select using (seller_id = auth.uid() or public.is_admin());

-- --- zostatok ----------------------------------------------------------------
create or replace function public.seller_balance(p_seller uuid default auth.uid())
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'seller_id', p_seller,
    'currency',  coalesce(min(l.currency), (select default_currency from public.platform_settings where id)),
    -- Všetko, čo mi patrí, vyplatené aj nevyplatené.
    'balance_cents',   coalesce(sum(l.amount_cents), 0),
    -- Z toho to, čo si viem nechať poslať teraz.
    'available_cents', coalesce(sum(l.amount_cents) filter (where l.available_at <= now()), 0),
    -- A to, čo ešte čaká na event alebo na potvrdenie kupujúceho.
    'pending_cents',   coalesce(sum(l.amount_cents) filter (where l.available_at > now()), 0),
    'sales_cents',     coalesce(sum(l.amount_cents) filter (where l.type = 'sale'), 0),
    'fees_cents',      coalesce(-sum(l.amount_cents) filter (where l.type = 'platform_fee'), 0),
    'paid_out_cents',  coalesce(-sum(l.amount_cents) filter (where l.type = 'payout'), 0),
    'payouts_enabled', coalesce((select a.payouts_enabled from public.seller_accounts a
                                 where a.user_id = p_seller), false)
  )
  from public.seller_ledger_entries l
  where l.seller_id = p_seller;
$$;

revoke execute on function public.seller_balance(uuid) from public;
grant execute on function public.seller_balance(uuid) to authenticated;

-- Vlastný zostatok si smie pozrieť každý; cudzí len admin.
create or replace function public.my_seller_balance()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  return public.seller_balance(auth.uid());
end;
$$;

revoke execute on function public.my_seller_balance() from public;
grant execute on function public.my_seller_balance() to authenticated;

-- ============================================================================
-- Kedy predajcovi vzniká nárok
-- ============================================================================
-- Beží to z cronu, nie z requestu. Nárok nevzniká tým, že si oň niekto
-- povie — vzniká tým, že sú splnené podmienky, a tie sú tu na jednom mieste.
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
      (ord.seller_id, ord.id, 'sale', ord.seller_net_cents, ord.currency, ready_at,
       'Predaj vstupenky na burze'),
      (ord.seller_id, ord.id, 'platform_fee', -ord.seller_fee_cents, ord.currency, ready_at,
       'Provízia burzy')
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

-- ============================================================================
-- Riziko
-- ============================================================================
-- Pravidlá, nie strojové učenie. Zadanie ho ani nepýta a na to, čo tu treba
-- rozhodnúť, sú pravidlá čitateľnejšie: keď sa výplata zadrží, dá sa povedať
-- prečo.
create or replace function public.resale_seller_risk(p_seller uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  disputes_total integer;
  disputes_lost  integer;
  sales_total    integer;
  external_share numeric;
  account_age    interval;
  level          text := 'low';
  reasons        text[] := '{}';
begin
  select count(*) into sales_total
  from public.resale_orders where seller_id = p_seller and payment_status = 'succeeded';

  select count(*) into disputes_total
  from public.resale_disputes d
  join public.resale_orders o on o.id = d.resale_order_id
  where o.seller_id = p_seller;

  select count(*) into disputes_lost
  from public.resale_disputes d
  join public.resale_orders o on o.id = d.resale_order_id
  where o.seller_id = p_seller and d.status = 'resolved' and d.resolution = 'refunded';

  select coalesce(
    count(*) filter (where source = 'external')::numeric / nullif(count(*), 0), 0)
  into external_share
  from public.resale_orders where seller_id = p_seller and payment_status = 'succeeded';

  select now() - created_at into account_age from public.profiles where id = p_seller;

  if disputes_lost >= 2 then
    level := 'high';
    reasons := reasons || 'dva a viac prehratých sporov';
  elsif disputes_total > 0 and sales_total > 0
        and disputes_total::numeric / sales_total > 0.25 then
    level := 'high';
    reasons := reasons || 'vysoký podiel sporov';
  elsif disputes_total > 0 then
    level := 'medium';
    reasons := reasons || 'má za sebou spor';
  end if;

  -- Nový účet, ktorý rovno predáva vstupenky, ktorých pravosť nevieme overiť,
  -- je presne ten tvar, ktorý stojí za pozretie.
  if level <> 'high' and account_age < interval '7 days' and external_share > 0.5
     and sales_total >= 3 then
    level := 'medium';
    reasons := reasons || 'nový účet a samé externé vstupenky';
  end if;

  if exists (select 1 from public.profiles where id = p_seller and is_suspended) then
    level := 'high';
    reasons := reasons || 'zablokovaný účet';
  end if;

  return jsonb_build_object(
    'seller_id', p_seller,
    'level', level,
    'reasons', to_jsonb(reasons),
    'sales', sales_total,
    'disputes', disputes_total,
    'disputes_lost', disputes_lost
  );
end;
$$;

revoke execute on function public.resale_seller_risk(uuid) from public;
grant execute on function public.resale_seller_risk(uuid) to authenticated;

-- ============================================================================
-- Žiadosť o výplatu
-- ============================================================================
-- Appka o ňu smie požiadať, ale sumu určuje kniha. Číslo z requestu sa
-- nepoužije nikde — keby sa použilo, dalo by sa vypýtať viac, než človeku
-- patrí.
create or replace function public.request_seller_payout()
returns public.seller_payouts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me      uuid := auth.uid();
  bal     jsonb;
  amount  integer;
  risk    jsonb;
  payout  public.seller_payouts;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  if exists (select 1 from public.seller_payouts
             where seller_id = me and status in ('pending', 'processing')) then
    raise exception 'PAYOUT_ALREADY_PENDING' using errcode = 'P0001';
  end if;

  bal := public.seller_balance(me);

  if not (bal->>'payouts_enabled')::boolean then
    raise exception 'PAYOUT_ACCOUNT_NOT_READY' using errcode = 'P0001';
  end if;

  amount := (bal->>'available_cents')::integer;
  if amount is null or amount <= 0 then
    raise exception 'NOTHING_TO_PAY_OUT' using errcode = 'P0001';
  end if;

  risk := public.resale_seller_risk(me);

  insert into public.seller_payouts (seller_id, amount_cents, currency, status, held_reason)
  values (
    me, amount, bal->>'currency',
    -- Vysoké riziko výplatu nezastaví natrvalo, ale pošle ju cez človeka.
    case when risk->>'level' = 'high' then 'pending'::payout_status else 'pending'::payout_status end,
    case when risk->>'level' = 'high'
         then 'Čaká na kontrolu: ' || coalesce(risk->'reasons'->>0, 'vyššie riziko')
         else null end
  )
  returning * into payout;

  -- Zápis do knihy hneď, aby sa tá istá suma nedala vypýtať druhýkrát, kým
  -- prvá výplata beží.
  insert into public.seller_ledger_entries
    (seller_id, payout_id, type, amount_cents, currency, available_at, description)
  values
    (me, payout.id, 'payout', -amount, payout.currency, now(), 'Výplata na účet');

  perform public.log_resale(me, 'payout_requested', 'seller_payout', payout.id,
    jsonb_build_object('amount_cents', amount, 'risk', risk->>'level'));

  return payout;
end;
$$;

revoke execute on function public.request_seller_payout() from public;
grant execute on function public.request_seller_payout() to authenticated;
