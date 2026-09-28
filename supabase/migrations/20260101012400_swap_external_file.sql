-- ============================================================================
-- SWAP — vstupenka odinakiaľ je inzerát so súborom, nie prísľub
-- ============================================================================
-- Doteraz to fungovalo takto: predajca vypísal ponuku, niekto zaplatil, a až
-- POTOM mal predajca nahrať PDF. Objednávka medzitým visela v stave „čaká sa
-- na predajcu" a kupujúci mal v ruke účtenku a nič iné.
--
-- To je zle postavené. Kupujúci nemá dôvod veriť, že súbor, ktorý ešte
-- neexistuje, niekedy príde, a predajca nemá dôvod sa ponáhľať. Otočíme to:
--
--   PDF sa nahráva pri VYPISOVANÍ ponuky. Bez neho ponuka so spôsobom
--   doručenia „súbor" vôbec nevznikne.
--
--   Po zaplatení sa vstupenka doručí v tej istej sekunde — presne ako pri
--   našej vstupenke, len namiesto prevodu vlastníctva sa kupujúcemu sprístupní
--   súbor, ktorý už dávno leží v súkromnom úložisku.
--
-- Čo sa tým NEMENÍ, a nesmie zmeniť: peniaze predajca dostane až po evente.
-- Súbor nahratý dopredu nie je dôkaz pravosti — je to len dôkaz, že niečo
-- existuje. Pravosť sa ukáže pri vstupe a preto sa dovtedy platba drží.
-- Rovnako sa nemení provízia: pri vstupenke odinakiaľ si berieme celých 15 %,
-- lebo tam nesieme celé riziko sami.
--
-- Prevod v cudzej appke (`mobile_transfer`) zostáva ako bol — tam sa súbor
-- nahrať nedá, lebo žiadny nie je, a doručenie ostáva ručný krok predajcu.
-- ============================================================================
set search_path = public, extensions;

-- --- súbor visí na ponuke, nie na objednávke ---------------------------------
--
-- Cesta do bucketu `resale-tickets`. Pri vypisovaní ponuky ešte žiadna
-- objednávka neexistuje, takže sa nedá použiť pôvodné delenie po objednávkach:
-- súbor ide do priečinka predajcu (`sellers/<uid>/…`) a ponuka naň ukazuje.
alter table public.resale_listings
  add column if not exists ticket_file_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'resale_listings_file_shape'
  ) then
    alter table public.resale_listings
      add constraint resale_listings_file_shape check (
        ticket_file_path is null
        or (source = 'external' and delivery_method = 'file')
      );
  end if;
end $$;

-- --- kto smie na ten súbor ---------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'storage' and table_name = 'buckets') then

    -- Nahrávanie. Dve legitímne miesta a nič medzi tým:
    --   <order_id>/…        doručenie k existujúcej objednávke (pôvodná cesta)
    --   sellers/<uid>/…     príloha k ponuke, ešte pred akoukoľvek objednávkou
    execute 'drop policy if exists "resale tickets upload" on storage.objects';
    execute $pol$
      create policy "resale tickets upload" on storage.objects
        for insert to authenticated
        with check (
          bucket_id = 'resale-tickets'
          and (
            (
              (storage.foldername(name))[1] = 'sellers'
              and (storage.foldername(name))[2] = auth.uid()::text
            )
            or exists (
              select 1 from public.resale_orders o
              where o.id::text = (storage.foldername(name))[1]
                and o.seller_id = auth.uid()
            )
          )
        )
    $pol$;

    -- Predajca smie svoj vlastný súbor vymeniť alebo zmazať, kým na ňom
    -- nevisí zaplatená objednávka. Po predaji už nie: kupujúci si kúpil TEN
    -- súbor a nesmie mu spod rúk zmiznúť ani sa zmeniť na iný.
    execute 'drop policy if exists "resale tickets manage" on storage.objects';
    execute $pol$
      create policy "resale tickets manage" on storage.objects
        for delete to authenticated
        using (
          bucket_id = 'resale-tickets'
          and (storage.foldername(name))[1] = 'sellers'
          and (storage.foldername(name))[2] = auth.uid()::text
          and not exists (
            select 1
            from public.resale_listings l
            join public.resale_orders o on o.listing_id = l.id
            where l.ticket_file_path = objects.name
              and o.payment_status = 'succeeded'
          )
        )
    $pol$;

    -- Čítanie. K pôvodnej ceste (kupujúci a predajca tej objednávky) pribudla
    -- tá nová: predajca vidí vždy svoj súbor, kupujúci až keď zaplatil.
    --
    -- „Až keď zaplatil" je tu doslova: podmienkou je `payment_status =
    -- 'succeeded'`, teda stav, ktorý nastavuje výhradne overený webhook.
    -- Rezervácia ani rozrobená objednávka na súbor nestačia — inak by sa dal
    -- obsah vstupenky stiahnuť bez zaplatenia.
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
            or (
              (storage.foldername(name))[1] = 'sellers'
              and (storage.foldername(name))[2] = auth.uid()::text
            )
            or exists (
              select 1
              from public.resale_listings l
              join public.resale_orders o on o.listing_id = l.id
              where l.ticket_file_path = objects.name
                and o.buyer_id = auth.uid()
                and o.payment_status = 'succeeded'
            )
          )
        )
    $pol$;
  end if;
end $$;

-- Bez indexu by každé čítanie súboru prešlo celú tabuľku ponúk.
create index if not exists resale_listings_file_idx
  on public.resale_listings (ticket_file_path)
  where ticket_file_path is not null;

-- ============================================================================
-- Vypísanie ponuky — pri „súbore" je súbor povinný
-- ============================================================================
-- Prečo povinný: spôsob doručenia „súbor" je sľub kupujúcemu, že vstupenku
-- dostane hneď po zaplatení. Ponuka bez súboru ten sľub dať nemôže, a ponúkať
-- ho aj tak by bolo presne to, čo robí z burzy lotériu.
drop function if exists public.create_resale_listing(
  uuid, resale_source, integer, uuid, integer, resale_delivery_method,
  text, text, text, text, text, text, integer, text);

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
  p_note            text default null,
  p_ticket_file_path   text default null
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
  file     text := nullif(btrim(p_ticket_file_path), '');
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
    file := null;   -- prevod je zápis v databáze, súbor by bol mätúca príloha

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

    if delivery = 'file' then
      if file is null then
        raise exception 'TICKET_FILE_REQUIRED' using errcode = 'P0001';
      end if;
      -- Súbor musí ležať v priečinku TOHTO predajcu. Bez tejto kontroly by
      -- sa dala vypísať ponuka ukazujúca na cudzí súbor a zásada „kupujúci
      -- vidí, čo si kúpil" by sa zmenila na „kupujúci vidí, čo mu predajca
      -- ukázal na cudzí účet".
      if file not like ('sellers/' || me::text || '/%') then
        raise exception 'INVALID_TICKET_DATA' using errcode = 'P0001';
      end if;
      -- A ten istý súbor nesmie byť prilepený na dve ponuky naraz: jedno PDF
      -- predané dvakrát je presne ten podvod, pred ktorým burza chráni.
      if exists (
        select 1 from public.resale_listings l
        where l.ticket_file_path = file
          and l.status in ('draft', 'active', 'reserved', 'sold')
      ) then
        raise exception 'TICKET_FILE_IN_USE' using errcode = 'P0001';
      end if;
    else
      file := null;
    end if;
  end if;

  insert into public.resale_listings (
    event_id, seller_id, source, ticket_id,
    external_provider, external_reference,
    ticket_label, section, row_label, seat_label,
    quantity, price_cents, currency, face_value_cents,
    delivery_method, status, note, ticket_file_path,
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
    delivery, 'active', nullif(btrim(p_note), ''), file,
    ev.start_at
  )
  returning * into created;

  return created;
end;
$$;

revoke execute on function public.create_resale_listing(
  uuid, resale_source, integer, uuid, integer, resale_delivery_method,
  text, text, text, text, text, text, integer, text, text) from public;
grant execute on function public.create_resale_listing(
  uuid, resale_source, integer, uuid, integer, resale_delivery_method,
  text, text, text, text, text, text, integer, text, text) to authenticated;

-- ============================================================================
-- Kupujúci musí vidieť DOPREDU, či vstupenku dostane hneď
-- ============================================================================
-- Bez toho je to skrytá vlastnosť: dve ponuky na to isté miesto za tú istú
-- cenu, jedna dorazí o sekundu a druhá o tri dni, a kupujúci si nemá podľa
-- čoho vybrať.
drop function if exists public.event_resale_listings(
  uuid, text, integer, integer, resale_source, text, integer);

create or replace function public.event_resale_listings(
  p_event_id  uuid,
  p_sort      text default 'price_asc',
  p_max_price integer default null,
  p_quantity  integer default null,
  p_source    resale_source default null,
  p_section   text default null,
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
  -- Doručenie v sekunde po zaplatení: naša vstupenka (prevod) alebo cudzia,
  -- ktorá už má nahratý súbor. Ostatné čakajú na predajcu.
  instant_delivery boolean,
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
    l.delivery_method,
    -- Nevracia sa CESTA k súboru, len to, že existuje. Cestu kupujúci
    -- nepotrebuje a pred zaplatením by mu aj tak bola na nič — bucket je
    -- súkromný a politika ho k nemu pustí až po platbe.
    (l.source = 'blup' or l.ticket_file_path is not null),
    l.note, l.status, l.created_at
  from public.resale_listings l
  join public.profiles p on p.id = l.seller_id
  where l.event_id = p_event_id
    and l.status = 'active'
    and (l.expires_at is null or l.expires_at > now())
    and not p.is_suspended
    and (p_max_price is null or l.price_cents <= p_max_price)
    and (p_quantity is null or l.quantity >= p_quantity)
    and (p_source is null or l.source = p_source)
    -- Hľadanie miesta od začiatku slova; „A" nesmie vrátiť „Tribúna Juh".
    and (
      nullif(btrim(p_section), '') is null
      or public.blup_norm(
           concat_ws(' ', l.section, l.row_label, l.seat_label, l.ticket_label)
         ) ~ ('(^| )' || regexp_replace(
                public.blup_norm(btrim(p_section)),
                '([.^$|()\[\]{}*+?\\])', '\\\1', 'g'))
    )
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
  uuid, text, integer, integer, resale_source, text, integer) from public;
grant execute on function public.event_resale_listings(
  uuid, text, integer, integer, resale_source, text, integer) to anon, authenticated;

-- To isté na stránke platby: kto ide platiť, má vedieť, čo bude o sekundu.
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
  reason   text;
  ticket   integer;
  buyer_fee  integer;
  seller_fee integer;
  live_res   integer;
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
    'delivery_method',    l.delivery_method,
    -- Zase len „áno/nie", nikdy cesta k súboru.
    'instant_delivery',   (l.source = 'blup' or l.ticket_file_path is not null),
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
-- Zaplatené — a vstupenka odinakiaľ odchádza v tej istej sekunde
-- ============================================================================
-- Jediná zmena oproti pôvodnej verzii je tu: keď ponuka už nesie súbor,
-- objednávka neskončí v stave „čaká sa na predajcu", ale rovno v „doručené",
-- a zapíše sa doručenie ukazujúce na ten súbor. Kupujúci si ho otvorí v tom
-- istom rozhraní ako doteraz, len nemusí čakať.
--
-- Zámerne sa NEKOPÍRUJE do priečinka objednávky. Kópia by znamenala dva
-- súbory, ktoré sa môžu rozísť, a hlavne by na ňu bolo treba právo zápisu do
-- cudzieho priečinka. Ukazuje sa na ten istý objekt a prístup rieši politika.
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
  instant boolean;
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

  -- Doručí sa hneď, keď je čím: naša vstupenka (prevod) alebo cudzia, ktorá
  -- má súbor nahratý už z inzerátu.
  instant := ord.source = 'blup' or l.ticket_file_path is not null;

  update public.resale_orders
  set payment_status     = 'succeeded',
      provider_reference = coalesce(provider_reference, p_reference),
      paid_at            = now(),
      order_status       = case
        when instant then 'ticket_delivered'::resale_order_status
        else 'waiting_for_ticket'::resale_order_status
      end,
      delivered_at       = case when instant then now() else null end
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
  elsif instant then
    -- Doručenie sa zapisuje AŽ TERAZ, nie pri vypisovaní ponuky: kým nebolo
    -- zaplatené, nebolo čo doručiť a riadok v `resale_deliveries` bez
    -- objednávky ani neexistuje.
    insert into public.resale_deliveries
      (resale_order_id, file_path, transfer_note, delivered_by)
    values (ord.id, l.ticket_file_path, null, ord.seller_id);

    perform public.notify_user(
      ord.buyer_id, 'ticket_confirmed',
      'Vstupenka je u teba',
      coalesce(ev.title, 'Event') || ' — otvor si ju a potvrď, že funguje. '
        || 'Peniaze predajcovi držíme až do eventu.',
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
    case
      when ord.source = 'blup'
        then 'Prevod prebehol automaticky. Peniaze dostaneš po evente.'
      when instant
        then 'Súbor sme kupujúcemu odovzdali hneď. Peniaze dostaneš po evente.'
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
      'instant_delivery', instant,
      'reference', p_reference
    )
  );

  return ord;
end;
$$;

revoke execute on function public.mark_resale_order_paid(uuid, text) from public;
grant execute on function public.mark_resale_order_paid(uuid, text) to service_role;

-- --- doručovať sa dá len to, čo ešte nie je doručené -------------------------
-- Predtým sa `deliver_resale_ticket` dala zavolať na už doručenú objednávku a
-- zapísala druhý riadok. Pri predaji so súborom z inzerátu by to znamenalo, že
-- predajca po predaji „doručí" iné PDF než to, ktoré si kupujúci kúpil.
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
  -- Doručené z inzerátu, alebo doručené ručne už predtým. Oboje znamená, že
  -- kupujúci niečo drží — a to sa mu nesmie vymeniť pod rukami.
  if exists (
    select 1 from public.resale_deliveries d where d.resale_order_id = ord.id
  ) then
    raise exception 'ALREADY_DELIVERED' using errcode = 'P0001';
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

-- ============================================================================
-- Aby peniaze nezamrzli, keď kupujúci nikdy neklikne
-- ============================================================================
-- Doteraz platilo: pri vstupenke odinakiaľ sa nárok predajcovi zapíše výhradne
-- po tom, ako kupujúci potvrdí, že vstupenka fungovala. To dávalo zmysel, kým
-- bolo doručenie ručný krok — kupujúci sedel a čakal, takže mal dôvod
-- odkliknúť, že dorazila.
--
-- Keď súbor príde hneď po zaplatení, ten dôvod mizne. Kupujúci má vstupenku,
-- ide na event a na appku si spomenie o rok. Predajcove peniaze by tam ležali
-- donekonečna a to nie je ochrana kupujúceho, to je zadržiavanie cudzích
-- peňazí.
--
-- Takže: objednávka sa uzavrie sama, ale až keď sú splnené VŠETKY tieto veci —
--
--   event už prebehol a od jeho konca ubehla čakacia lehota platformy
--   (`resale_settlement_days`, štandardne 2 dni),
--   kupujúci vstupenku naozaj dostal (existuje záznam o doručení),
--   a nikto neotvoril spor.
--
-- Kupujúci tým neprichádza o nič: vstupenku mal v ruke pred eventom, spor môže
-- otvoriť aj po uzavretí objednávky a otvorený spor výplatu zablokuje.
create or replace function public.auto_complete_resale_orders(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  fees   jsonb := public.resale_fees();
  wait   integer := greatest(0, (fees->>'settlement_days')::integer);
  ord    record;
  closed integer := 0;
begin
  for ord in
    select o.*
    from public.resale_orders o
    join public.events e on e.id = o.event_id
    where o.payment_status = 'succeeded'
      and o.source = 'external'
      and o.order_status = 'ticket_delivered'
      and e.status <> 'cancelled'
      and coalesce(e.end_at, e.start_at) + make_interval(days => wait) <= now()
      -- Doručenie musí byť ZAPÍSANÉ. Bez toho by sa sama uzavrela aj
      -- objednávka, ktorú niekto prepol do „doručené" bez toho, aby sa čokoľvek
      -- dostalo ku kupujúcemu.
      and exists (
        select 1 from public.resale_deliveries d where d.resale_order_id = o.id
      )
      and not exists (
        select 1 from public.resale_disputes d
        where d.resale_order_id = o.id and d.status in ('open', 'investigating')
      )
    order by o.paid_at
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
  loop
    update public.resale_deliveries
    set confirmed_at = now()
    where resale_order_id = ord.id and confirmed_at is null;

    update public.resale_orders
    set order_status = 'completed', completed_at = coalesce(completed_at, now())
    where id = ord.id;

    perform public.notify_user(
      ord.buyer_id, 'ticket_confirmed',
      'Objednávku sme uzavreli',
      'Event prebehol a nenahlásil si problém, tak sme ju uzavreli za teba. '
        || 'Ak niečo nesedelo, ozvi sa nám aj teraz.',
      null, ord.event_id,
      jsonb_build_object('resale_order_id', ord.id, 'kind', 'resale')
    );

    perform public.log_resale(null, 'order_auto_completed', 'resale_order', ord.id,
      jsonb_build_object('waited_days', wait));

    closed := closed + 1;
  end loop;

  return closed;
end;
$$;

revoke execute on function public.auto_complete_resale_orders(integer) from public;
grant execute on function public.auto_complete_resale_orders(integer) to service_role;

-- Vyrovnanie najprv dozrie objednávky a až potom počíta nároky. Jeden cron,
-- nie dva — dva by sa museli v správnom poradí, a to je vec, ktorú človek pri
-- nastavovaní pokazí.
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
  perform public.auto_complete_resale_orders(p_limit);

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
