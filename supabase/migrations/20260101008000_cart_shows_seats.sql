-- ============================================================================
-- V košíku má byť vidieť, ktoré miesto si si vybral
--
-- „ked si uz v kosiku tak ti neukaze presne ake sedenie si si vybral."
--
-- `cart_view()` staval riadky z `cart_items` a `venue_seat_id` úplne ignoroval,
-- hoci ho tá tabuľka nesie od prvej migrácie so sedením. V košíku tak stálo
-- „Tribúna A", dvakrát, bez radu a bez čísla — a jediné miesto, kde sa človek
-- dozvedel, kde vlastne bude sedieť, bola vstupenka po zaplatení.
--
-- Dva problémy naraz, lebo spolu súvisia:
--
--   · riadky sa nezlučovali. Každá položka košíka bola vlastný riadok, takže
--     dve miesta v tom istom sektore vyzerali ako dva rôzne nákupy.
--   · a nikde nebolo napísané ktoré.
--
-- Event bez sedenia sa nemení: `seats` je prázdne pole a obrazovka vyzerá
-- presne ako predtým.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.cart_view(p_promo_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  uid       uuid := auth.uid();
  limits    jsonb;
  ev        record;
  fees      jsonb;
  lines     jsonb := '[]'::jsonb;
  line      record;
  quantity  integer := 0;
  subtotal  integer := 0;
  discount  integer := 0;
  net       integer;
  archive   integer := 0;
  commis    integer;
  payer     text;
  promo     jsonb;
  promo_err text;
  expires   timestamptz;
  currency  text := 'EUR';
begin
  limits := public.cart_limits();

  if uid is null then
    return jsonb_build_object(
      'lines', lines, 'quantity', 0, 'total_cents', 0, 'currency', currency,
      'limits', limits, 'event', null, 'expires_at', null, 'seconds_left', 0
    );
  end if;

  select min(c.expires_at) into expires
  from public.cart_items c
  where c.user_id = uid and c.expires_at > now();

  select e.* into ev
  from public.events e
  where e.id = (
    select c.event_id from public.cart_items c
    where c.user_id = uid and c.expires_at > now()
    limit 1
  );

  if ev.id is null then
    return jsonb_build_object(
      'lines', lines, 'quantity', 0, 'total_cents', 0, 'currency', currency,
      'limits', limits, 'event', null, 'expires_at', null, 'seconds_left', 0
    );
  end if;

  fees  := public.resolve_fees(ev.organization_id);
  payer := fees->>'archive_fee_payer';

  for line in
    -- Jeden riadok na typ vstupenky, nie na položku košíka. Dve miesta v tom
    -- istom sektore sú dve miesta v jednom sektore.
    select
      c.ticket_type_id,
      sum(c.quantity)::integer as quantity,
      tt.name, tt.price_cents, tt.currency, tt.max_per_order,
      greatest(tt.quantity_total - tt.quantity_sold - public.held_quantity(tt.id, uid), 0) as available,
      -- A ktoré miesta to sú. Zoradené tak, ako sa na ne pozerá človek:
      -- rad, potom číslo.
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'seat_id', vs.id,
            'section', sec.name,
            'row', vs.row_label,
            'number', vs.seat_number,
            'kind', vs.kind,
            'label', sec.name || ', rad ' || vs.row_label || ', miesto ' || vs.seat_number
          )
          order by vs.row_label, vs.seat_number
        )
        from public.cart_items ci
        join public.venue_seats vs on vs.id = ci.venue_seat_id
        join public.venue_sections sec on sec.id = vs.venue_section_id
        where ci.user_id = uid
          and ci.expires_at > now()
          and ci.ticket_type_id = c.ticket_type_id
      ), '[]'::jsonb) as seats
    from public.cart_items c
    join public.ticket_types tt on tt.id = c.ticket_type_id
    where c.user_id = uid and c.expires_at > now()
    -- Podľa primárneho kľúča: Postgres potom vie, že ostatné stĺpce z tt sú
    -- ním určené, a nemusia sa vymenúvať (ani tie vnútri held_quantity).
    group by c.ticket_type_id, tt.id
    order by tt.price_cents desc, tt.name asc
  loop
    quantity := quantity + line.quantity;
    subtotal := subtotal + line.price_cents * line.quantity;
    currency := line.currency;

    lines := lines || jsonb_build_object(
      'ticket_type_id', line.ticket_type_id,
      'name',           line.name,
      'quantity',       line.quantity,
      'unit_price_cents', line.price_cents,
      'line_total_cents', line.price_cents * line.quantity,
      'max_per_order',  least(line.max_per_order, (limits->>'max_tickets_per_order')::integer),
      'available',      line.available,
      'currency',       line.currency,
      'seats',          line.seats
    );
  end loop;

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);
    if (promo->>'valid')::boolean then
      discount := (promo->>'amount_off')::integer;
    else
      promo_err := promo->>'reason';
    end if;
  end if;

  net     := greatest(subtotal - discount, 0);
  archive := case when net > 0
                  then (fees->>'archive_fee_cents')::integer * quantity
                  else 0 end;
  commis  := (net * (fees->>'platform_fee_bps')::integer) / 10000;

  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', ev.id, 'title', ev.title, 'start_at', ev.start_at,
      'venue_name', ev.venue_name, 'city', ev.city, 'cover_image_url', ev.cover_image_url
    ),
    'lines',             lines,
    'quantity',          quantity,
    'subtotal_cents',    subtotal,
    'discount_cents',    discount,
    'archive_fee_cents', case when payer = 'buyer' then archive else 0 end,
    'archive_fee_payer', payer,
    'commission_cents',  commis,
    'total_cents',       net + case when payer = 'buyer' then archive else 0 end,
    'currency',          currency,
    'limits',            limits,
    'promo',             promo,
    'promo_error',       promo_err,
    'expires_at',        expires,
    'seconds_left',      greatest(0, extract(epoch from (expires - now()))::integer)
  );
end;
$$;

grant execute on function public.cart_view(text) to authenticated;
