-- ============================================================================
-- Burza vstupeniek — platba, prevod a doručenie
-- ============================================================================
-- Tu sa z rezervácie stane objednávka, z objednávky zaplatená objednávka a zo
-- zaplatenej objednávky vstupenka v rukách kupujúceho.
--
-- Dve veci, ktoré sa nesmú stratiť:
--
--   Cena sa berie z `quote_resale`, nie z toho, čo poslal frontend. Keby
--   checkout prijal sumu z prehliadača, dala by sa poslať jednotka.
--
--   Objednávka sa označí ako zaplatená výhradne zvonku, cez `service_role` —
--   teda z overeného webhooku poskytovateľa platby. Nie z appky, nie z
--   návratovej stránky. „Payment successful" na fronte nie je dôkaz, že
--   peniaze dorazili.
--
-- A prevod vlastníctva BLUP vstupenky je to, čo celej burze dáva zmysel:
-- prepíše sa `buyer_id`, vygeneruje sa nový kód aj nový QR a pôvodný prestane
-- platiť. Pôvodný majiteľ sa s tým, čo má v telefóne, dnu nedostane.
-- ============================================================================
set search_path = public, extensions;

-- --- stopa burzy -------------------------------------------------------------
--
-- Vlastná tabuľka a nie `admin_audit_log`: tá je na zásahy administrátora a má
-- stĺpec `admin_id`. Tu je aktérom bežný človek — kupujúci, predajca, alebo
-- systém po prijatí platby — a zapísať ho do stĺpca menom `admin_id` by bola
-- lož v schéme, ktorá by neskôr niekoho pomýlila pri vyšetrovaní sporu.
create table if not exists public.resale_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists resale_audit_log_idx
  on public.resale_audit_log (created_at desc);
create index if not exists resale_audit_log_target_idx
  on public.resale_audit_log (target_type, target_id, created_at desc);
create index if not exists resale_audit_log_actor_idx
  on public.resale_audit_log (actor_id, created_at desc);

alter table public.resale_audit_log enable row level security;

-- Stopu číta len admin. Pre obe strany sporu je určený stav objednávky, nie
-- surový log.
drop policy if exists resale_audit_log_select on public.resale_audit_log;
create policy resale_audit_log_select on public.resale_audit_log
  for select using (public.is_admin());

create or replace function public.log_resale(
  p_actor    uuid,
  p_action   text,
  p_type     text,
  p_target   uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.resale_audit_log (actor_id, action, target_type, target_id, metadata)
  values (p_actor, p_action, p_type, p_target, coalesce(p_metadata, '{}'::jsonb));
$$;

revoke execute on function public.log_resale(uuid, text, text, uuid, jsonb) from public;

-- --- doručenie externej vstupenky -------------------------------------------
create table if not exists public.resale_deliveries (
  id              uuid primary key default gen_random_uuid(),
  resale_order_id uuid not null references public.resale_orders (id) on delete cascade,
  -- Cesta v súkromnom úložisku. Nikdy sa neservuje priamo — appka si vypýta
  -- podpísanú adresu s krátkou platnosťou a smie to len kupujúci.
  file_path       text,
  -- Pri prevode v appke inej platformy: čo predajca uviedol, že spravil.
  -- Zámerne bez prihlasovacích údajov a bez odkazov na cudzie účty.
  transfer_note   text,
  delivered_by    uuid not null references public.profiles (id) on delete restrict,
  delivered_at    timestamptz not null default now(),
  -- Potvrdenie kupujúceho, že vstupenka naozaj funguje. Toto je to, čo
  -- uvoľňuje peniaze predajcovi.
  confirmed_at    timestamptz,
  constraint resale_deliveries_something check (
    file_path is not null or transfer_note is not null
  ),
  constraint resale_deliveries_note_len check (
    transfer_note is null or char_length(transfer_note) <= 1000
  )
);

create index if not exists resale_deliveries_order_idx
  on public.resale_deliveries (resale_order_id, delivered_at desc);
-- Bez tohto by zmazanie profilu muselo prejsť celú tabuľku, aby zistilo, či
-- po ňom niečo zostalo. Audit indexov v db:verify to odchytil.
create index if not exists resale_deliveries_by_idx
  on public.resale_deliveries (delivered_by);

alter table public.resale_deliveries enable row level security;

drop policy if exists resale_deliveries_select on public.resale_deliveries;
create policy resale_deliveries_select on public.resale_deliveries
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.resale_orders o
      where o.id = resale_order_id
        and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
    )
  );

-- --- súkromné úložisko na vstupenky -----------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'resale-tickets', 'resale-tickets',
      -- NIE verejné. Vstupenka je cenina: verejná adresa znamená, že kto ju
      -- uhádne alebo dostane preposlanú, má vstupenku.
      false,
      15 * 1024 * 1024,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
    )
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;

    -- Nahrávať smie predajca, do priečinka svojej objednávky.
    execute 'drop policy if exists "resale tickets upload" on storage.objects';
    execute $pol$
      create policy "resale tickets upload" on storage.objects
        for insert to authenticated
        with check (
          bucket_id = 'resale-tickets'
          and exists (
            select 1 from public.resale_orders o
            where o.id::text = (storage.foldername(name))[1]
              and o.seller_id = auth.uid()
          )
        )
    $pol$;

    -- Čítať smie kupujúci tej objednávky, predajca a admin. Nikto iný, ani s
    -- adresou v ruke.
    execute 'drop policy if exists "resale tickets read" on storage.objects';
    execute $pol$
      create policy "resale tickets read" on storage.objects
        for select to authenticated
        using (
          bucket_id = 'resale-tickets'
          and (
            public.is_admin()
            or exists (
              select 1 from public.resale_orders o
              where o.id::text = (storage.foldername(name))[1]
                and (o.buyer_id = auth.uid() or o.seller_id = auth.uid())
            )
          )
        )
    $pol$;
  end if;
end $$;

-- ============================================================================
-- Z rezervácie objednávka
-- ============================================================================
create or replace function public.create_resale_order(p_reservation_id uuid)
returns public.resale_orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me    uuid := auth.uid();
  res   record;
  l     record;
  quote jsonb;
  ord   public.resale_orders;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into res from public.resale_reservations where id = p_reservation_id for update;
  if not found then
    raise exception 'RESERVATION_NOT_FOUND' using errcode = 'P0001';
  end if;
  if res.buyer_id <> me then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if res.status <> 'active' then
    raise exception 'RESERVATION_NOT_ACTIVE' using errcode = 'P0001';
  end if;
  if res.expires_at <= now() then
    raise exception 'RESERVATION_EXPIRED' using errcode = 'P0001';
  end if;

  -- Ak už objednávka z tejto rezervácie existuje a čaká na platbu, vráti sa
  -- tá istá. Dvakrát kliknuté „Zaplatiť" nesmie založiť dve objednávky.
  select * into ord
  from public.resale_orders
  where listing_id = res.listing_id
    and buyer_id = me
    and order_status in ('created', 'payment_pending')
    and expires_at > now();
  if found then
    return ord;
  end if;

  select * into l from public.resale_listings where id = res.listing_id for update;

  -- Cena zo servera. Nie z argumentu, nie z frontendu.
  quote := public.quote_resale(res.listing_id, res.quantity);
  if not (quote->>'valid')::boolean then
    raise exception '%', coalesce(quote->>'reason', 'LISTING_NOT_AVAILABLE')
      using errcode = 'P0001';
  end if;

  insert into public.resale_orders (
    listing_id, event_id, buyer_id, seller_id, source, quantity,
    ticket_price_cents, buyer_fee_cents, delivery_fee_cents, total_cents,
    seller_fee_cents, seller_net_cents, currency,
    order_status, expires_at
  ) values (
    l.id, l.event_id, me, l.seller_id, l.source, res.quantity,
    (quote->>'ticket_price_cents')::integer,
    (quote->>'buyer_fee_cents')::integer,
    (quote->>'delivery_fee_cents')::integer,
    (quote->>'total_cents')::integer,
    (quote->>'seller_fee_cents')::integer,
    (quote->>'seller_net_cents')::integer,
    quote->>'currency',
    'payment_pending',
    -- Objednávka nesmie prežiť rezerváciu, ktorá ju drží.
    res.expires_at
  )
  returning * into ord;

  return ord;
end;
$$;

revoke execute on function public.create_resale_order(uuid) from public;
grant execute on function public.create_resale_order(uuid) to authenticated;

-- ============================================================================
-- Prevod BLUP vstupenky — to, čo z pravosti robí overiteľný fakt
-- ============================================================================
create or replace function public.transfer_blup_ticket(
  p_ticket_id uuid,
  p_to_user   uuid,
  p_order_id  uuid
)
returns public.tickets
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t public.tickets;
begin
  select * into t from public.tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'TICKET_NOT_FOUND' using errcode = 'P0001';
  end if;
  if t.status <> 'valid' then
    raise exception 'TICKET_NOT_VALID' using errcode = 'P0001';
  end if;
  if t.checked_in_at is not null then
    raise exception 'TICKET_ALREADY_USED' using errcode = 'P0001';
  end if;

  -- Nový majiteľ, nový kód, nový QR. Všetky tri naraz, v jednom zápise:
  -- vstupenka, ktorá by zmenila majiteľa a nechala si kód, by sa dala použiť
  -- zo snímky obrazovky, ktorú si predajca spravil pred predajom.
  update public.tickets
  set buyer_id    = p_to_user,
      code        = 'BLP-' || public.blup_short_code(10),
      qr_secret   = encode(gen_random_bytes(24), 'hex'),
      holder_name = null
  where id = t.id
  returning * into t;

  -- Do stopy burzy, lebo prevod vlastníctva ceniny je presne to, čo musí byť
  -- spätne dohľadateľné.
  perform public.log_resale(
    p_to_user, 'ticket_transferred', 'ticket', t.id,
    jsonb_build_object('resale_order_id', p_order_id, 'event_id', t.event_id)
  );

  return t;
end;
$$;

revoke execute on function public.transfer_blup_ticket(uuid, uuid, uuid) from public;
-- Nikto ju nevolá priamo. Len `mark_resale_order_paid` nižšie, po platbe.
grant execute on function public.transfer_blup_ticket(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- Zaplatené — a čo sa tým spustí
-- ============================================================================
-- Volá to výhradne `stripe-webhook`, teda kód, ktorý si najprv overil podpis
-- poskytovateľa. Grant je len pre `service_role`, takže z appky sa to zavolať
-- nedá ani omylom.
--
-- Celá funkcia je idempotentná. Ten istý webhook smie doraziť trikrát —
-- Stripe ich pri pochybnosti naozaj opakuje — a nesmie z toho byť trojitý
-- prevod, tri notifikácie ani trojitý nárok na výplatu.
create or replace function public.mark_resale_order_paid(
  p_order_id  uuid,
  p_reference text
)
returns public.resale_orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ord public.resale_orders;
  l   record;
  ev  record;
  fees jsonb;
begin
  select * into ord from public.resale_orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Už spracované. Vrátiť stav a nerobiť nič — toto je celá idempotencia.
  if ord.payment_status = 'succeeded' then
    return ord;
  end if;

  if ord.order_status in ('cancelled', 'refunded') then
    raise exception 'ORDER_NOT_PAYABLE' using errcode = 'P0001';
  end if;

  fees := public.resale_fees();
  select * into l from public.resale_listings where id = ord.listing_id for update;
  select * into ev from public.events where id = ord.event_id;

  update public.resale_orders
  set payment_status     = 'succeeded',
      provider_reference = coalesce(provider_reference, p_reference),
      paid_at            = now(),
      order_status       = case
        -- Naša vstupenka je doručená v tej istej sekunde: prevod je zápis v
        -- databáze, nie niečo, na čo sa čaká.
        when ord.source = 'blup' then 'ticket_delivered'::resale_order_status
        else 'waiting_for_ticket'::resale_order_status
      end,
      delivered_at       = case when ord.source = 'blup' then now() else null end
  where id = ord.id
  returning * into ord;

  update public.resale_listings set status = 'sold' where id = l.id;
  update public.resale_reservations
  set status = 'converted'
  where listing_id = l.id and status = 'active';

  if ord.source = 'blup' then
    perform public.transfer_blup_ticket(l.ticket_id, ord.buyer_id, ord.id);

    perform public.notify_user(
      ord.buyer_id, 'ticket_confirmed',
      'Vstupenka je tvoja',
      coalesce(ev.title, 'Event') || ' — prevedená na tvoje meno, starý kód už neplatí.',
      null, ord.event_id,
      jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
    );
  else
    perform public.notify_user(
      ord.buyer_id, 'ticket_purchased',
      'Zaplatené — čaká sa na vstupenku',
      'Predajca ju má doručiť. Peniaze držíme, kým nepotvrdíš, že funguje.',
      null, ord.event_id,
      jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
    );
  end if;

  perform public.notify_user(
    ord.seller_id, 'ticket_purchased',
    'Vstupenka sa predala',
    case when ord.source = 'blup'
      then 'Prevod prebehol automaticky. Peniaze dostaneš po evente.'
      else 'Doruč vstupenku kupujúcemu — bez toho sa platba neuvoľní.'
    end,
    null, ord.event_id,
    jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
  );

  perform public.log_resale(
    ord.buyer_id, 'order_paid', 'resale_order', ord.id,
    jsonb_build_object(
      'total_cents', ord.total_cents,
      'seller_net_cents', ord.seller_net_cents,
      'source', ord.source,
      'reference', p_reference
    )
  );

  return ord;
end;
$$;

revoke execute on function public.mark_resale_order_paid(uuid, text) from public;
grant execute on function public.mark_resale_order_paid(uuid, text) to service_role;

-- ============================================================================
-- Doručenie externej vstupenky a potvrdenie kupujúcim
-- ============================================================================
create or replace function public.deliver_resale_ticket(
  p_order_id  uuid,
  p_file_path text default null,
  p_note      text default null
)
returns public.resale_orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me  uuid := auth.uid();
  ord public.resale_orders;
  ev  record;
begin
  select * into ord from public.resale_orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if ord.seller_id <> me then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if ord.payment_status <> 'succeeded' then
    raise exception 'ORDER_NOT_PAID' using errcode = 'P0001';
  end if;
  if ord.source = 'blup' then
    -- Naša vstupenka je prevedená automaticky. Nahrávať k nej súbor by
    -- znamenalo tváriť sa, že prevod ešte neprebehol.
    raise exception 'DELIVERY_NOT_REQUIRED' using errcode = 'P0001';
  end if;
  if p_file_path is null and nullif(btrim(p_note), '') is null then
    raise exception 'INVALID_TICKET_DATA' using errcode = 'P0001';
  end if;
  -- Súbor musí ležať v priečinku tejto objednávky, inak by sa dal „doručiť"
  -- súbor z cudzej objednávky.
  if p_file_path is not null and p_file_path not like (ord.id::text || '/%') then
    raise exception 'INVALID_TICKET_DATA' using errcode = 'P0001';
  end if;

  select * into ev from public.events where id = ord.event_id;

  insert into public.resale_deliveries (resale_order_id, file_path, transfer_note, delivered_by)
  values (ord.id, p_file_path, nullif(btrim(p_note), ''), me);

  update public.resale_orders
  set order_status = 'ticket_delivered',
      delivered_at = coalesce(delivered_at, now())
  where id = ord.id
  returning * into ord;

  perform public.notify_user(
    ord.buyer_id, 'ticket_confirmed',
    'Vstupenka dorazila',
    coalesce(ev.title, 'Event') || ' — pozri si ju a potvrď, že funguje.',
    null, ord.event_id,
    jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
  );

  perform public.log_resale(me, 'ticket_delivered', 'resale_order', ord.id,
    jsonb_build_object('has_file', p_file_path is not null));

  return ord;
end;
$$;

revoke execute on function public.deliver_resale_ticket(uuid, text, text) from public;
grant execute on function public.deliver_resale_ticket(uuid, text, text) to authenticated;

-- Potvrdenie kupujúcim. Toto je to, čo odomkne peniaze predajcovi — preto to
-- nesmie spraviť nikto iný.
create or replace function public.confirm_resale_ticket(p_order_id uuid)
returns public.resale_orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me  uuid := auth.uid();
  ord public.resale_orders;
begin
  select * into ord from public.resale_orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if ord.buyer_id <> me then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if ord.order_status = 'completed' then
    return ord;                      -- druhé kliknutie nie je chyba
  end if;
  if ord.order_status <> 'ticket_delivered' then
    raise exception 'TICKET_NOT_AVAILABLE' using errcode = 'P0001';
  end if;

  update public.resale_deliveries
  set confirmed_at = now()
  where resale_order_id = ord.id and confirmed_at is null;

  update public.resale_orders
  set order_status = 'completed', completed_at = now()
  where id = ord.id
  returning * into ord;

  perform public.notify_user(
    ord.seller_id, 'payout_update',
    'Kupujúci potvrdil vstupenku',
    'Peniaze sa uvoľnia podľa pravidiel platformy.',
    null, ord.event_id,
    jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
  );

  perform public.log_resale(me, 'ticket_confirmed', 'resale_order', ord.id, '{}'::jsonb);

  return ord;
end;
$$;

revoke execute on function public.confirm_resale_ticket(uuid) from public;
grant execute on function public.confirm_resale_ticket(uuid) to authenticated;

-- Objednávky, ktoré nikto nezaplatil, pustia listing späť do predaja.
create or replace function public.expire_resale_orders()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  gone integer;
begin
  with dead as (
    update public.resale_orders
    set order_status = 'cancelled',
        cancelled_at = now(),
        failure_reason = 'EXPIRED'
    where order_status in ('created', 'payment_pending')
      and payment_status <> 'succeeded'
      and expires_at <= now()
    returning listing_id
  )
  select count(*)::integer into gone from dead;

  update public.resale_listings l
  set status = 'active'
  where l.status = 'reserved'
    and not exists (
      select 1 from public.resale_reservations r
      where r.listing_id = l.id and r.status = 'active' and r.expires_at > now()
    )
    and not exists (
      select 1 from public.resale_orders o
      where o.listing_id = l.id and o.payment_status = 'succeeded'
    );

  return coalesce(gone, 0);
end;
$$;

revoke execute on function public.expire_resale_orders() from public;
grant execute on function public.expire_resale_orders() to service_role;
