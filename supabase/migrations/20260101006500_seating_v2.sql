-- ============================================================================
-- Sedenie, druhýkrát: miesto, ktoré naozaj zostane tvoje.
--
-- The first version drew a plan, held a seat for fifteen minutes, and then
-- lost it. Three links in the chain were missing, and every one of them ends
-- with two people holding a ticket for the same chair:
--
--   1. checkout_start() turns the basket into orders and then deletes every
--      cart line. The hold lived on the cart line, so the seat went back on
--      sale the moment the buyer was sent to the payment page.
--   2. create_order() knows a ticket type and a quantity. It was never told
--      which seat, so nothing recorded the seat between basket and payment.
--   3. fulfill_order() writes the tickets. venue_seat_id was left null, so
--      even a paid ticket did not name a seat — the row and number the buyer
--      picked existed nowhere after the sale.
--
-- So the seat now travels the whole way: cart line → order → ticket. An order
-- holds its seat exactly as it holds stock (`processing`, or `requires_payment`
-- that has not expired), which is the rule held_quantity() already uses, and a
-- unique index makes a second live order for the same seat impossible rather
-- than unlikely.
--
-- The rest of this migration is what "pick a seat" needs to stop being a
-- puzzle: seats that say what they are (a wheelchair space is not a chair),
-- seats that can be taken out of sale without being deleted, holding four
-- seats in one go instead of four races, and a suggestion for four seats that
-- are actually next to each other — because nobody wants to click four dots
-- and discover they are in four different rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- What a seat is
-- ---------------------------------------------------------------------------
-- A wheelchair space, the companion seat beside it, and a seat with a pillar
-- in front of it are all sold — they are just not the same product, and a plan
-- that draws them as identical dots sells the wrong one to the wrong person.
alter table public.venue_seats
  add column if not exists kind text not null default 'standard';

alter table public.venue_seats drop constraint if exists venue_seats_kind_valid;
alter table public.venue_seats add constraint venue_seats_kind_valid
  check (kind in ('standard', 'wheelchair', 'companion', 'limited_view'));

-- Why this seat is what it is: "za stĺpom", "vyhradené pre ZŤP". Shown to the
-- buyer, so it is worth writing.
alter table public.venue_seats
  add column if not exists note text;

alter table public.venue_seats drop constraint if exists venue_seats_note_len;
alter table public.venue_seats add constraint venue_seats_note_len
  check (note is null or char_length(note) <= 120);

-- The plan is drawn at the picture's own proportions on the buyer's screen.
-- The editor used a fixed 0.7 and stored the rectangles against that, so every
-- sector moved between the two screens. The ratio now travels with the map and
-- both screens read it from here.
alter table public.venue_maps
  add column if not exists updated_by uuid references public.profiles (id) on delete set null;

-- ---------------------------------------------------------------------------
-- The seat on the order
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists venue_seat_id uuid references public.venue_seats (id) on delete set null;

-- One live order per seat. The predicate cannot call now() — an index needs an
-- immutable one — so an order that has expired but has not yet been swept still
-- blocks the seat. That is the safe direction to be wrong in, and
-- release_expired_holds() runs on every basket operation anyway.
create unique index if not exists orders_seat_once
  on public.orders (venue_seat_id)
  where venue_seat_id is not null
    and payment_status in ('requires_payment', 'processing', 'succeeded');

-- An order that names a seat is one seat.
alter table public.orders drop constraint if exists orders_seat_is_single;
alter table public.orders add constraint orders_seat_is_single
  check (venue_seat_id is null or quantity = 1);

create index if not exists orders_seat_idx on public.orders (venue_seat_id)
  where venue_seat_id is not null;

-- ---------------------------------------------------------------------------
-- Who has which seat — one answer, used everywhere
-- ---------------------------------------------------------------------------
/**
 * Every seat of an event that is not available, and to whom.
 *
 * Three ways a seat is gone, and they are not interchangeable: a sold ticket is
 * final, an order is money in flight, a basket line expires. The buyer's screen
 * only needs "taken by me" versus "taken by someone else", but the seat picker,
 * cart_hold_seat() and create_order() all have to agree on the answer, so it is
 * written once here instead of three times in three dialects.
 *
 * `claimed_by` is null for a guest order — nobody is signed in to own it, and a
 * guest's seat must still look taken to everyone else.
 */
create or replace function public.seat_claims(p_event_id uuid)
returns table (seat_id uuid, claimed_by uuid, claim text, hold_until timestamptz)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select t.venue_seat_id, t.buyer_id, 'sold', null::timestamptz
  from public.tickets t
  where t.event_id = p_event_id
    and t.venue_seat_id is not null
    and t.status in ('valid', 'used')

  union all

  select o.venue_seat_id, o.buyer_id, 'ordered', o.expires_at
  from public.orders o
  where o.event_id = p_event_id
    and o.venue_seat_id is not null
    and (
      o.payment_status = 'processing'
      or (o.payment_status = 'requires_payment' and o.expires_at > now())
    )

  union all

  select c.venue_seat_id, c.user_id, 'held', c.expires_at
  from public.cart_items c
  where c.event_id = p_event_id
    and c.venue_seat_id is not null
    and c.expires_at > now();
$$;

grant execute on function public.seat_claims(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The plan, as the buyer sees it
-- ---------------------------------------------------------------------------
-- Three things changed here beyond the new claim source.
--
-- `mine` used to mean only "in my basket". It now means any claim of mine, and
-- `mine_claim` says which — because a seat you already paid for and a seat you
-- are holding look the same on a plan and must not behave the same when you
-- click them. Tapping the held one gives it back; tapping the paid one has to
-- do nothing, which it cannot decide without being told the difference.
--
-- `hold_until` comes back with the seat, so the screen can count the hold down
-- instead of the buyer discovering it ended.
--
-- And `auth.uid() is not null` guards every ownership test: a guest's claim has
-- no owner, and without the guard `null is not distinct from null` would show a
-- signed-out visitor every guest-held seat as their own.
create or replace function public.seat_map_for_event(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ev as (
    select e.id, e.venue_map_id from public.events e where e.id = p_event_id
  ),
  claims as (
    select
      c.seat_id,
      bool_or(c.claimed_by is not distinct from auth.uid() and auth.uid() is not null) as is_mine,
      -- 'held' < 'ordered' < 'sold' alphabetically, which is also weakest to
      -- strongest. That is luck rather than design, so: max() is picking the
      -- strongest claim, and renaming one of these three strings breaks it.
      max(case when c.claimed_by is not distinct from auth.uid() and auth.uid() is not null
               then c.claim end) as mine_claim,
      max(case when c.claimed_by is not distinct from auth.uid() and auth.uid() is not null
               then c.hold_until end) as mine_until
    from public.seat_claims(p_event_id) c
    group by c.seat_id
  )
  select case when (select venue_map_id from ev) is null then null else
    jsonb_build_object(
      'map', to_jsonb(m) - 'created_by' - 'updated_by',
      'sections', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'colour', s.colour,
            'x', s.x, 'y', s.y, 'width', s.width, 'height', s.height,
            'ticket_type_id', s.ticket_type_id,
            'price_cents', tt.price_cents,
            'numbered', exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id),
            'available', case
              when exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id)
                then (select count(*) from public.venue_seats vs
                      where vs.venue_section_id = s.id and vs.is_sellable
                        and not exists (select 1 from claims cl where cl.seat_id = vs.id))
              else coalesce((select a.available
                             from public.ticket_type_availability(s.ticket_type_id) a), 0)
            end,
            'rows', (select count(distinct vs.row_label) from public.venue_seats vs
                     where vs.venue_section_id = s.id),
            'row_width', coalesce((select max(cnt) from (
                select count(*) as cnt from public.venue_seats vs
                where vs.venue_section_id = s.id group by vs.row_label) w), 0),
            'seats', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', vs.id,
                'row', vs.row_label,
                'number', vs.seat_number,
                'row_index', vs.row_index,
                'sellable', vs.is_sellable,
                'kind', vs.kind,
                'note', vs.note,
                'mine', coalesce(cl.is_mine, false),
                'mine_claim', cl.mine_claim,
                'hold_until', cl.mine_until,
                'taken', cl.seat_id is not null and not coalesce(cl.is_mine, false),
                'free', vs.is_sellable and cl.seat_id is null
              ) order by vs.row_label, vs.seat_number)
              from (
                select v.*,
                       dense_rank() over (order by v.row_label) - 1 as row_index
                from public.venue_seats v
                where v.venue_section_id = s.id
              ) vs
              left join claims cl on cl.seat_id = vs.id
            ), '[]'::jsonb)
          ) order by s.sort_order, s.name
        )
        from public.venue_sections s
        left join public.ticket_types tt on tt.id = s.ticket_type_id
        where s.venue_map_id = m.id
      ), '[]'::jsonb)
    )
  end
  from ev
  left join public.venue_maps m on m.id = ev.venue_map_id;
$$;

grant execute on function public.seat_map_for_event(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The seat, from basket to order
-- ---------------------------------------------------------------------------
-- create_order() gains the seat. Everything else is the function as 0056 left
-- it — Postgres has no way to patch a body in place, so the whole thing is
-- restated and the changes are marked where they sit.
drop function if exists public.create_order(uuid, uuid, integer, text, integer, uuid, uuid, text, text, text, double precision, double precision);

create or replace function public.create_order(
  p_buyer_id          uuid,
  p_ticket_type_id    uuid,
  p_quantity          integer,
  p_promo_code        text default null,
  p_discount_override integer default null,
  p_promo_code_id     uuid default null,
  p_checkout_id       uuid default null,
  -- The guest half. Given together or not at all.
  p_guest_email       text default null,
  p_guest_name        text default null,
  p_buyer_city        text default null,
  p_buyer_latitude    double precision default null,
  p_buyer_longitude   double precision default null,
  -- Which chair. Null for everything that sells by count, which is still most
  -- of what BLUP sells.
  p_venue_seat_id     uuid default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tt        record;
  ev        record;
  org       record;
  fees      jsonb;
  cap       integer;
  subtotal  integer;
  discount  integer := 0;
  net       integer;
  archive   integer;
  commis    integer;
  payer     text;
  promo     jsonb;
  promo_id  uuid;
  held      integer;
  guest     citext := nullif(lower(btrim(coalesce(p_guest_email, ''))), '')::citext;
  city      text   := nullif(btrim(coalesce(p_buyer_city, '')), '');
  lat       double precision := p_buyer_latitude;
  lng       double precision := p_buyer_longitude;
  new_order public.orders;
  seat      public.venue_seats;
  seat_sect public.venue_sections;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
  end if;

  -- A seat is one seat. Asking for three of chair B12 is not a thing that can
  -- be sold, and the constraint on the table says so too — this says it in a
  -- word the app can translate.
  if p_venue_seat_id is not null and p_quantity <> 1 then
    raise exception 'SEAT_IS_SINGLE';
  end if;

  -- Somebody has to own this order. Not both, not neither: an account or an
  -- address, and an address that at least looks like one.
  if p_buyer_id is null and guest is null then
    raise exception 'BUYER_REQUIRED';
  end if;
  if guest is not null and position('@' in guest::text) < 2 then
    raise exception 'INVALID_EMAIL';
  end if;

  cap := (public.cart_limits()->>'max_tickets_per_order')::integer;
  if p_quantity > cap then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  select * into tt from public.ticket_types where id = p_ticket_type_id for update;
  if not found then
    raise exception 'TICKET_TYPE_NOT_FOUND';
  end if;
  if not tt.is_active then
    raise exception 'TICKET_TYPE_INACTIVE';
  end if;
  if p_quantity > tt.max_per_order then
    raise exception 'QUANTITY_ABOVE_LIMIT';
  end if;
  if tt.sales_start_at is not null and now() < tt.sales_start_at then
    raise exception 'SALES_NOT_STARTED';
  end if;
  if tt.sales_end_at is not null and now() > tt.sales_end_at then
    raise exception 'SALES_ENDED';
  end if;

  -- Everyone else's live reservations count as gone. The buyer's own basket
  -- does not: this order is what that basket turns into.
  held := public.held_quantity(tt.id, p_buyer_id);
  if tt.quantity_sold + held + p_quantity > tt.quantity_total then
    raise exception 'SOLD_OUT';
  end if;

  select * into ev from public.events where id = tt.event_id;
  if ev.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;
  if ev.organization_id is null then
    raise exception 'PAID_EVENT_REQUIRES_ORGANIZATION';
  end if;

  select * into org from public.organizations where id = ev.organization_id;

  -- --- the seat ------------------------------------------------------------
  -- Two rules, and the second one is the one that was missing. A seat may only
  -- be bought through the sector that sells it; and a sector that has seats may
  -- ONLY be bought by naming one. Without the second rule the guest checkout —
  -- which never touches the seat picker — sold numbered stalls seats with no
  -- seat on them, and two people arrived for the same chair.
  if p_venue_seat_id is not null then
    select * into seat from public.venue_seats where id = p_venue_seat_id;
    if not found then
      raise exception 'SEAT_NOT_FOUND';
    end if;
    if not seat.is_sellable then
      raise exception 'SEAT_NOT_SELLABLE';
    end if;

    select * into seat_sect from public.venue_sections where id = seat.venue_section_id;
    if seat_sect.ticket_type_id is distinct from tt.id then
      raise exception 'SEAT_WRONG_SECTION';
    end if;

    -- Somebody else's, by any of the three routes. Their own basket line is not
    -- in the way: it is what this order is being made out of.
    if exists (
      select 1 from public.seat_claims(ev.id) c
      where c.seat_id = p_venue_seat_id
        and (p_buyer_id is null or c.claimed_by is distinct from p_buyer_id)
    ) then
      raise exception 'SEAT_TAKEN';
    end if;

  elsif exists (
    select 1
    from public.venue_sections s
    join public.venue_seats vs on vs.venue_section_id = s.id
    where s.ticket_type_id = tt.id
    limit 1
  ) then
    raise exception 'SEAT_REQUIRED';
  end if;

  -- Nothing was said about where the buyer is from, but we know them: take it
  -- from the profile so a signed-in purchase lands on the same map as a guest's.
  if p_buyer_id is not null and city is null then
    select p.city, p.latitude, p.longitude into city, lat, lng
    from public.profiles p where p.id = p_buyer_id;
  end if;

  fees     := public.resolve_fees(ev.organization_id);
  payer    := fees->>'archive_fee_payer';
  subtotal := tt.price_cents * p_quantity;

  if p_discount_override is not null then
    -- Basket path: the caller already validated the code and split it.
    discount := least(greatest(p_discount_override, 0), subtotal);
    promo_id := p_promo_code_id;
  elsif p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);

    if not (promo->>'valid')::boolean then
      raise exception '%', promo->>'reason';
    end if;

    discount := (promo->>'amount_off')::integer;
    promo_id := (promo->>'promo_code_id')::uuid;
  end if;

  net     := greatest(subtotal - discount, 0);
  archive := case when net > 0
                  then (fees->>'archive_fee_cents')::integer * p_quantity
                  else 0 end;
  commis  := (net * (fees->>'platform_fee_bps')::integer) / 10000;

  insert into public.orders (
    event_id, organization_id, ticket_type_id, buyer_id, quantity,
    unit_price_cents, subtotal_cents, discount_cents, promo_code_id,
    commission_cents, archive_fee_cents, archive_fee_payer,
    platform_fee_cents, total_cents, currency, payment_status, provider,
    checkout_id, guest_email, guest_name, claim_token,
    buyer_city, buyer_latitude, buyer_longitude, venue_seat_id
  )
  values (
    ev.id, ev.organization_id, tt.id, p_buyer_id, p_quantity,
    tt.price_cents, subtotal, discount, promo_id,
    commis, archive, payer,
    commis + case when payer = 'organizer' then archive else 0 end,
    net + case when payer = 'buyer' then archive else 0 end,
    tt.currency, 'requires_payment', org.payment_provider,
    p_checkout_id, guest, nullif(btrim(coalesce(p_guest_name, '')), ''),
    -- The guest's only way back to their ticket if they read the e-mail on a
    -- different device, or sign up later with a different address.
    case when guest is not null then public.blup_short_code(24) end,
    city, lat, lng, p_venue_seat_id
  )
  returning * into new_order;

  -- The basket path counts the code once, in create_checkout().
  if promo_id is not null and p_discount_override is null then
    update public.promo_codes
      set used_count = used_count + 1
      where id = promo_id;
  end if;

  -- The basket path records one redemption for the whole basket in
  -- create_checkout(); a single-line order records its own here. A guest has no
  -- user id to record, and the redemption is tied to the order either way.
  if promo_id is not null and discount > 0 and p_discount_override is null then
    insert into public.promo_redemptions (promo_code_id, order_id, user_id, amount_off)
    values (promo_id, new_order.id, p_buyer_id, discount);
  end if;

  return new_order;
end;
$$;


revoke all on function public.create_order(
  uuid, uuid, integer, text, integer, uuid, uuid, text, text, text, double precision, double precision, uuid
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Basket -> orders, with the seat still attached
-- ---------------------------------------------------------------------------
-- Two lines change: the loop reads the seat off the cart line, and passes it
-- on. The rest is create_checkout() as 0025 wrote it.
create or replace function public.create_checkout(
  p_buyer_id   uuid,
  p_promo_code text default null
)
returns public.checkouts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  cap        integer;
  ev         record;
  fees       jsonb;
  payer      text;
  line       record;
  quantity   integer := 0;
  subtotal   integer := 0;
  discount   integer := 0;
  promo      jsonb;
  promo_id   uuid;
  co         public.checkouts;
  ord        public.orders;
  share      integer;
  assigned   integer := 0;
  idx        integer := 0;
  n_lines    integer;
  sum_sub    integer := 0;
  sum_comm   integer := 0;
  sum_arch   integer := 0;
  sum_total  integer := 0;
  cur        text := 'EUR';
begin
  if p_buyer_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  perform public.release_expired_holds();

  cap := (public.cart_limits()->>'max_tickets_per_order')::integer;

  select e.* into ev
  from public.events e
  join public.cart_items c on c.event_id = e.id
  where c.user_id = p_buyer_id and c.expires_at > now()
  limit 1;

  if not found then
    raise exception 'CART_EMPTY';
  end if;

  select coalesce(sum(c.quantity), 0), coalesce(sum(tt.price_cents * c.quantity), 0), count(*)
    into quantity, subtotal, n_lines
  from public.cart_items c
  join public.ticket_types tt on tt.id = c.ticket_type_id
  where c.user_id = p_buyer_id and c.expires_at > now();

  if quantity < 1 then
    raise exception 'CART_EMPTY';
  end if;
  if quantity > cap then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  fees  := public.resolve_fees(ev.organization_id);
  payer := fees->>'archive_fee_payer';

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);
    if not (promo->>'valid')::boolean then
      raise exception '%', promo->>'reason';
    end if;
    discount := (promo->>'amount_off')::integer;
    promo_id := (promo->>'promo_code_id')::uuid;
  end if;

  insert into public.checkouts (
    buyer_id, event_id, organization_id, quantity, subtotal_cents, discount_cents,
    total_cents, currency, promo_code_id, provider
  )
  values (
    p_buyer_id, ev.id, ev.organization_id, quantity, subtotal, discount,
    0, coalesce((select default_currency from public.organizations where id = ev.organization_id), 'EUR'),
    promo_id,
    coalesce((select payment_provider from public.organizations where id = ev.organization_id), 'stripe')
  )
  returning * into co;

  -- Largest-remainder split of the basket discount across the lines. Ordered by
  -- line value so the rounding cent lands on the biggest line, and the last
  -- line takes whatever is left so the parts sum to the whole exactly.
  for line in
    select c.ticket_type_id, c.quantity, c.venue_seat_id, tt.price_cents,
           tt.price_cents * c.quantity as line_subtotal
    from public.cart_items c
    join public.ticket_types tt on tt.id = c.ticket_type_id
    where c.user_id = p_buyer_id and c.expires_at > now()
    -- Two seats in the same sector are two lines of the same value, so the id
    -- breaks the tie and the discount always splits the same way twice.
    order by tt.price_cents * c.quantity desc, c.ticket_type_id, c.venue_seat_id
  loop
    idx := idx + 1;

    if discount = 0 or subtotal = 0 then
      share := 0;
    elsif idx = n_lines then
      share := discount - assigned;
    else
      share := (discount * line.line_subtotal) / subtotal;
    end if;
    assigned := assigned + share;

    ord := public.create_order(
      p_buyer_id          => p_buyer_id,
      p_ticket_type_id    => line.ticket_type_id,
      p_quantity          => line.quantity,
      p_promo_code        => null,
      p_discount_override => case when discount > 0 then share else null end,
      p_promo_code_id     => case when discount > 0 then promo_id else null end,
      p_checkout_id       => co.id,
      -- The line that was missing. The basket is deleted at the end of this
      -- function, so a seat that stops here stops for good: the buyer went to
      -- the payment page and the chair went back on sale behind them.
      p_venue_seat_id     => line.venue_seat_id
    );

    sum_sub   := sum_sub + ord.subtotal_cents;
    sum_comm  := sum_comm + ord.commission_cents;
    sum_arch  := sum_arch + ord.archive_fee_cents;
    sum_total := sum_total + ord.total_cents;
    cur       := ord.currency;
  end loop;

  if promo_id is not null then
    update public.promo_codes set used_count = used_count + 1 where id = promo_id;

    insert into public.promo_redemptions (promo_code_id, order_id, user_id, amount_off)
    select promo_id, o.id, p_buyer_id, discount
    from public.orders o
    where o.checkout_id = co.id
    order by o.created_at, o.id
    limit 1;
  end if;

  update public.checkouts
  set subtotal_cents    = sum_sub,
      commission_cents  = sum_comm,
      archive_fee_cents = case when payer = 'buyer' then sum_arch else 0 end,
      total_cents       = sum_total,
      currency          = cur
  where id = co.id
  returning * into co;

  -- The basket has become orders; the reservation now lives on the orders.
  delete from public.cart_items where user_id = p_buyer_id;

  return co;
end;
$$;

-- ---------------------------------------------------------------------------
-- The seat, from order to ticket
-- ---------------------------------------------------------------------------
-- A trigger rather than a change to fulfill_order(), for the same reason the
-- guest fields are one: the money path has a single definition in 0046 and
-- 0056, and reaching into it to copy one column would mean restating a hundred
-- lines of ledger arithmetic to add one. This also covers every other way a
-- ticket can be made from an order — a manual fulfilment, a repair script —
-- which a line inside fulfill_order() would not.
create or replace function public.copy_seat_to_ticket()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  seat uuid;
begin
  if new.venue_seat_id is not null or new.order_id is null then
    return new;
  end if;

  select o.venue_seat_id into seat from public.orders o where o.id = new.order_id;
  new.venue_seat_id := seat;
  return new;
end;
$$;

drop trigger if exists tickets_copy_seat on public.tickets;
create trigger tickets_copy_seat
  before insert on public.tickets
  for each row execute function public.copy_seat_to_ticket();

-- ---------------------------------------------------------------------------
-- Holding seats — all of them, or none
-- ---------------------------------------------------------------------------
/**
 * Four seats in one call.
 *
 * Holding them one at a time is four chances to lose the fourth to somebody
 * faster and be left sitting apart, and four rows of "seat taken" for a person
 * who asked one question. This either holds the whole set or changes nothing.
 *
 * Seats the caller already holds are refreshed rather than refused — clicking
 * "hold these four" twice is not an error, it is impatience.
 */
create or replace function public.cart_hold_seats(p_seat_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_ids     uuid[];
  v_event   uuid;
  v_minutes integer;
  v_max     integer;
  v_other   integer;
  v_claim   text;
  v_until   timestamptz;
  r         record;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  -- The same seat named twice is one seat, not a conflict.
  select array_agg(distinct s) into v_ids
  from unnest(coalesce(p_seat_ids, '{}'::uuid[])) s
  where s is not null;

  if v_ids is null or array_length(v_ids, 1) is null then
    raise exception 'NO_SEATS';
  end if;

  perform public.release_expired_holds();

  -- Which event these seats belong to, and that they all belong to the same
  -- one. A sector is a ticket type, so the route is seat → sector → type →
  -- event, and a sector with no type is a shape nobody can buy yet.
  for r in
    select vs.id as seat_id, vs.is_sellable, vs.row_label, vs.seat_number,
           s.name as section_name, s.ticket_type_id, tt.event_id
    from unnest(v_ids) as want(id)
    left join public.venue_seats vs on vs.id = want.id
    left join public.venue_sections s on s.id = vs.venue_section_id
    left join public.ticket_types tt on tt.id = s.ticket_type_id
  loop
    if r.seat_id is null then raise exception 'SEAT_NOT_FOUND'; end if;
    if not r.is_sellable then raise exception 'SEAT_NOT_SELLABLE'; end if;
    if r.ticket_type_id is null or r.event_id is null then
      raise exception 'SECTION_NOT_ON_SALE';
    end if;
    if v_event is null then
      v_event := r.event_id;
    elsif v_event <> r.event_id then
      raise exception 'SEATS_DIFFERENT_EVENTS';
    end if;
  end loop;

  -- A basket holds one event at a time, here as everywhere else.
  if exists (
    select 1 from public.cart_items c
    where c.user_id = v_user and c.expires_at > now() and c.event_id <> v_event
  ) then
    raise exception 'CART_OTHER_EVENT';
  end if;

  -- "Sold" and "somebody is in the middle of buying it" are not the same news:
  -- one means pick another seat, the other means try again in a quarter of an
  -- hour. The app has both sentences, so keep the distinction.
  select c.claim into v_claim
  from public.seat_claims(v_event) c
  where c.seat_id = any (v_ids) and c.claimed_by is distinct from v_user
  order by c.claim desc   -- 'sold' > 'ordered' > 'held'; the worst news wins
  limit 1;

  if v_claim in ('sold', 'ordered') then
    raise exception 'SEAT_TAKEN';
  elsif v_claim = 'held' then
    raise exception 'SEAT_HELD';
  end if;

  select coalesce(max_tickets_per_order, 20), coalesce(cart_hold_minutes, 15)
    into v_max, v_minutes
  from public.platform_settings limit 1;
  v_max     := coalesce(v_max, 20);
  v_minutes := coalesce(v_minutes, 15);

  -- Everything already in the basket that is not one of these seats. Counting
  -- the seats being re-held would refuse the second click on the same four.
  select coalesce(sum(c.quantity), 0) into v_other
  from public.cart_items c
  where c.user_id = v_user and c.expires_at > now()
    and (c.venue_seat_id is null or not (c.venue_seat_id = any (v_ids)));

  if v_other + array_length(v_ids, 1) > v_max then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  v_until := now() + make_interval(mins => v_minutes);

  begin
    insert into public.cart_items (user_id, event_id, ticket_type_id, venue_seat_id, quantity, expires_at)
    select v_user, v_event, s.ticket_type_id, vs.id, 1, v_until
    from unnest(v_ids) as want(id)
    join public.venue_seats vs on vs.id = want.id
    join public.venue_sections s on s.id = vs.venue_section_id
    on conflict (venue_seat_id) where venue_seat_id is not null
    do update set expires_at = excluded.expires_at;
  exception when unique_violation then
    -- Two people clicked the same dot inside the same millisecond. The index
    -- decided; this is only the wording — and it is another basket that won,
    -- so it is the fifteen-minute answer rather than the final one.
    raise exception 'SEAT_HELD';
  end;

  -- The whole basket expires together, or the oldest line quietly takes the
  -- newest seat with it.
  update public.cart_items set expires_at = v_until
  where user_id = v_user and expires_at > now();

  return jsonb_build_object(
    'expires_at', v_until,
    'seats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'seat_id', vs.id,
        'section', s.name,
        'row', vs.row_label,
        'number', vs.seat_number,
        'kind', vs.kind
      ) order by s.name, vs.row_label, vs.seat_number)
      from unnest(v_ids) as want(id)
      join public.venue_seats vs on vs.id = want.id
      join public.venue_sections s on s.id = vs.venue_section_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.cart_hold_seats(uuid[]) from public, anon;
grant execute on function public.cart_hold_seats(uuid[]) to authenticated;

-- One seat is the same operation with one element. Kept because the picker
-- calls it on every tap and its answer is a seat, not a list.
create or replace function public.cart_hold_seat(p_seat_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  res jsonb := public.cart_hold_seats(array[p_seat_id]);
begin
  return (res->'seats'->0) || jsonb_build_object('expires_at', res->>'expires_at');
end;
$$;

revoke execute on function public.cart_hold_seat(uuid) from public, anon;
grant execute on function public.cart_hold_seat(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- "Just give me four together"
-- ---------------------------------------------------------------------------
/**
 * The best free block of p_count seats in a sector.
 *
 * Almost nobody arrives alone and almost nobody wants to solve a puzzle. The
 * policy is the one a box office would use out loud: seats next to each other
 * in one row, the row nearest the stage first, and within a row as close to the
 * middle as the free seats allow.
 *
 * Rows are lettered from the front — that is what generate_section_seats() does
 * and what every organizer doing it by hand also does — so "nearest the stage"
 * is simply the first row label.
 *
 * Accessible and restricted-view seats are left out: handing a wheelchair space
 * to a group of four who did not ask for one takes it from the person who
 * needs it, and a pillar is not a surprise anybody enjoys. Those are picked
 * deliberately, one at a time, on the plan.
 *
 * Returns nothing at all when the sector cannot seat the group together, which
 * the screen says plainly instead of silently offering a worse answer.
 */
create or replace function public.suggest_seats(p_section_id uuid, p_count integer default 2)
returns table (seat_id uuid, row_label text, seat_number integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_event uuid;
  v_want  integer := greatest(coalesce(p_count, 1), 1);
  v_row   text;
  v_from  integer;
begin
  select tt.event_id into v_event
  from public.venue_sections s
  join public.ticket_types tt on tt.id = s.ticket_type_id
  where s.id = p_section_id;

  if v_event is null then
    return;
  end if;

  with claims as (
    select c.seat_id from public.seat_claims(v_event) c
  ),
  all_seats as (
    select vs.row_label, vs.seat_number,
           dense_rank() over (order by vs.row_label) - 1 as row_index
    from public.venue_seats vs
    where vs.venue_section_id = p_section_id
  ),
  span as (
    -- The middle of the row as built, not the middle of what is left: a block
    -- at the end of a half-empty row is not central just because the rest of
    -- the row is gone.
    select a.row_label, min(a.seat_number) as first_no, max(a.seat_number) as last_no
    from all_seats a group by a.row_label
  ),
  free as (
    select vs.id, vs.row_label, vs.seat_number,
           dense_rank() over (order by vs.row_label) - 1 as row_index
    from public.venue_seats vs
    where vs.venue_section_id = p_section_id
      and vs.is_sellable
      and vs.kind = 'standard'
      and not exists (select 1 from claims cl where cl.seat_id = vs.id)
  ),
  islands as (
    -- Gaps and islands: consecutive seat numbers share one value here, and a
    -- missing or taken seat starts a new run.
    select f.*,
           f.seat_number - row_number() over (partition by f.row_label order by f.seat_number) as grp
    from free f
  ),
  runs as (
    select i.row_label, i.row_index, i.grp,
           min(i.seat_number) as lo, max(i.seat_number) as hi, count(*) as len
    from islands i
    group by i.row_label, i.row_index, i.grp
  ),
  windows as (
    select r.row_label, r.row_index, w.start_no,
           abs(((w.start_no + (w.start_no + v_want - 1)) / 2.0)
               - ((sp.first_no + sp.last_no) / 2.0)) as off_centre
    from runs r
    join span sp on sp.row_label = r.row_label
    cross join lateral generate_series(r.lo, r.hi - v_want + 1) as w(start_no)
    where r.len >= v_want
  )
  select w.row_label, w.start_no into v_row, v_from
  from windows w
  order by w.row_index, w.off_centre, w.start_no
  limit 1;

  if v_row is null then
    return;
  end if;

  return query
  select vs.id, vs.row_label, vs.seat_number
  from public.venue_seats vs
  where vs.venue_section_id = p_section_id
    and vs.row_label = v_row
    and vs.seat_number between v_from and v_from + v_want - 1
  order by vs.seat_number;
end;
$$;

grant execute on function public.suggest_seats(uuid, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The organizer's side
-- ---------------------------------------------------------------------------
-- Until now the plan editor wrote to venue_sections and venue_seats straight
-- through PostgREST. RLS made that safe, but it made nothing else safe: the app
-- deleted every seat in a sector to regenerate it, and because tickets point at
-- seats with ON DELETE SET NULL, a sector regenerated mid-sale silently emptied
-- the row and number off tickets people had already paid for. No error, no
-- trace — the buyer just turns up with a ticket for nowhere.
create or replace function public.assert_can_manage_venue_map(p_map_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  org uuid;
begin
  select organization_id into org from public.venue_maps where id = p_map_id;
  if org is null then
    raise exception 'VENUE_MAP_NOT_FOUND';
  end if;
  if not (public.is_org_member(org, null, auth.uid()) or public.is_admin()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
end;
$$;

grant execute on function public.assert_can_manage_venue_map(uuid) to authenticated;

-- A, B … Z, AA, AB. The app had its own copy of this; two copies of a rule
-- that has to agree is one copy too many, so the database owns it now.
create or replace function public.seat_row_label(p_index integer)
returns text
language plpgsql
immutable
as $$
declare
  label text := '';
  n     integer := greatest(coalesce(p_index, 0), 0);
begin
  loop
    label := chr(65 + (n % 26)) || label;
    n := (n / 26) - 1;
    exit when n < 0;
  end loop;
  return label;
end;
$$;

grant execute on function public.seat_row_label(integer) to anon, authenticated;

/**
 * Fills a sector with rows of seats, without losing the ones that are sold.
 *
 * Growing a grid is free. Shrinking one is refused when the seats that would
 * disappear belong to somebody — the organizer is told how many and which row,
 * because the fix is theirs to make (refund those, or keep the rows) and not
 * something this function can guess.
 *
 * Seats that already exist keep their id, their kind and their note, so
 * regenerating a stand does not un-mark the wheelchair spaces.
 */
create or replace function public.generate_section_seats(
  p_section_id uuid,
  p_rows       integer,
  p_per_row    integer,
  p_start_row  integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_map     uuid;
  v_event   uuid;
  v_created integer := 0;
  v_removed integer := 0;
  v_clash   record;
begin
  if p_rows is null or p_per_row is null or p_rows < 1 or p_per_row < 1 then
    raise exception 'INVALID_GRID';
  end if;
  if p_rows > 200 or p_per_row > 200 then
    raise exception 'GRID_TOO_BIG';
  end if;

  select s.venue_map_id, tt.event_id into v_map, v_event
  from public.venue_sections s
  left join public.ticket_types tt on tt.id = s.ticket_type_id
  where s.id = p_section_id;

  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  -- Would anybody lose a seat? Asked before anything is touched, so a refusal
  -- leaves the sector exactly as the organizer left it.
  if v_event is not null then
    select vs.row_label, count(*) as n into v_clash
    from public.venue_seats vs
    join public.seat_claims(v_event) c on c.seat_id = vs.id
    where vs.venue_section_id = p_section_id
      and not exists (
        select 1
        from generate_series(0, p_rows - 1) r
        cross join generate_series(1, p_per_row) n
        where public.seat_row_label(p_start_row + r) = vs.row_label
          and n = vs.seat_number
      )
    group by vs.row_label
    order by vs.row_label
    limit 1;

    if found then
      raise exception 'SEATS_IN_USE'
        using hint = 'Rad ' || v_clash.row_label || ' má predané alebo držané miesta. '
                  || 'Zmenši plán tak, aby ostal, alebo tie vstupenky najprv zruš.';
    end if;
  end if;

  delete from public.venue_seats vs
  where vs.venue_section_id = p_section_id
    and not exists (
      select 1
      from generate_series(0, p_rows - 1) r
      cross join generate_series(1, p_per_row) n
      where public.seat_row_label(p_start_row + r) = vs.row_label
        and n = vs.seat_number
    );
  get diagnostics v_removed = row_count;

  -- Seats that survive keep their id, so a wheelchair space stays one and a
  -- ticket that names the seat still finds it.
  insert into public.venue_seats (venue_section_id, row_label, seat_number)
  select p_section_id, public.seat_row_label(p_start_row + r), n
  from generate_series(0, p_rows - 1) r
  cross join generate_series(1, p_per_row) n
  on conflict (venue_section_id, row_label, seat_number) do nothing;
  get diagnostics v_created = row_count;

  return jsonb_build_object(
    'total', (select count(*) from public.venue_seats where venue_section_id = p_section_id),
    'created', v_created,
    'removed', v_removed
  );
end;
$$;

revoke execute on function public.generate_section_seats(uuid, integer, integer, integer) from public, anon;
grant execute on function public.generate_section_seats(uuid, integer, integer, integer) to authenticated;


/**
 * Takes seats out of sale, or marks what they are.
 *
 * Deliberately not STRICT: a null argument here means "leave this one alone",
 * and a STRICT function called with one returns null before it runs its own
 * authorization check — which is exactly how claim_event once shipped broken.
 */
create or replace function public.set_seat_state(
  p_seat_ids uuid[],
  p_sellable boolean default null,
  p_kind     text default null,
  p_note     text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_map     uuid;
  v_event   uuid;
  v_changed integer;
begin
  if p_seat_ids is null or array_length(p_seat_ids, 1) is null then
    return 0;
  end if;
  if p_kind is not null and p_kind not in ('standard', 'wheelchair', 'companion', 'limited_view') then
    raise exception 'INVALID_SEAT_KIND';
  end if;

  select distinct s.venue_map_id into v_map
  from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  where vs.id = any (p_seat_ids);

  if v_map is null then
    raise exception 'SEAT_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  select tt.event_id into v_event
  from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  join public.ticket_types tt on tt.id = s.ticket_type_id
  where vs.id = any (p_seat_ids)
  limit 1;

  -- Blocking a seat somebody is already sitting in does not un-sell it; it just
  -- makes the plan lie. Say so instead.
  if p_sellable is false and v_event is not null and exists (
    select 1 from public.seat_claims(v_event) c where c.seat_id = any (p_seat_ids)
  ) then
    raise exception 'SEATS_IN_USE'
      using hint = 'Tieto miesta sú predané alebo držané — najprv zruš tie vstupenky.';
  end if;

  update public.venue_seats vs
  set is_sellable = coalesce(p_sellable, vs.is_sellable),
      kind        = coalesce(p_kind, vs.kind),
      note        = case when p_note is null then vs.note
                         when btrim(p_note) = '' then null
                         else btrim(p_note) end
  where vs.id = any (p_seat_ids);

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke execute on function public.set_seat_state(uuid[], boolean, text, text) from public, anon;
grant execute on function public.set_seat_state(uuid[], boolean, text, text) to authenticated;

/**
 * Renaming, recolouring or re-pricing a sector.
 *
 * There was no way to do any of these: a sector drawn in the wrong place, or
 * pointed at the wrong ticket type, could only be deleted — taking its seats,
 * and with them the row and number on every ticket already sold from it.
 *
 * Null means "leave it", so the editor can send one field at a time.
 */
create or replace function public.update_section(
  p_section_id     uuid,
  p_name           text default null,
  p_colour         text default null,
  p_ticket_type_id uuid default null,
  p_x              numeric default null,
  p_y              numeric default null,
  p_width          numeric default null,
  p_height         numeric default null,
  p_sort_order     integer default null
)
returns public.venue_sections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_map uuid;
  v_out public.venue_sections;
begin
  select venue_map_id into v_map from public.venue_sections where id = p_section_id;
  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  -- Moving a sector to a different ticket type moves its seats' price and
  -- their event. Tickets already sold name the seat, so they would end up in a
  -- sector selling something else entirely.
  if p_ticket_type_id is not null and exists (
    select 1 from public.venue_seats vs
    join public.tickets t on t.venue_seat_id = vs.id and t.status in ('valid', 'used')
    where vs.venue_section_id = p_section_id
  ) then
    raise exception 'SEATS_IN_USE'
      using hint = 'Zo sektora sú už predané vstupenky, typ vstupenky sa nedá vymeniť.';
  end if;

  update public.venue_sections s
  set name           = coalesce(nullif(btrim(coalesce(p_name, '')), ''), s.name),
      colour         = coalesce(p_colour, s.colour),
      ticket_type_id = coalesce(p_ticket_type_id, s.ticket_type_id),
      x              = coalesce(p_x, s.x),
      y              = coalesce(p_y, s.y),
      width          = coalesce(p_width, s.width),
      height         = coalesce(p_height, s.height),
      sort_order     = coalesce(p_sort_order, s.sort_order)
  where s.id = p_section_id
  returning * into v_out;

  return v_out;
end;
$$;

revoke execute on function public.update_section(uuid, text, text, uuid, numeric, numeric, numeric, numeric, integer) from public, anon;
grant execute on function public.update_section(uuid, text, text, uuid, numeric, numeric, numeric, numeric, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Who sits where
-- ---------------------------------------------------------------------------
/**
 * The seating list an organizer actually needs at the door.
 *
 * Sorted the way a room is walked — sector, then row, then number — rather than
 * by when the ticket was bought, which is the order the attendee list uses and
 * is useless for finding the person in D14.
 */
create or replace function public.event_seat_manifest(p_event_id uuid)
returns table (
  section      text,
  row_label    text,
  seat_number  integer,
  kind         text,
  seat_note    text,
  ticket_id    uuid,
  code         text,
  status       ticket_status,
  holder_name  text,
  checked_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  perform public.assert_can_read_event_stats(p_event_id);

  return query
  select
    s.name,
    vs.row_label,
    vs.seat_number,
    vs.kind,
    vs.note,
    t.id,
    t.code,
    t.status,
    coalesce(nullif(btrim(coalesce(t.holder_name, '')), ''),
             nullif(btrim(coalesce(p.display_name, '')), ''),
             nullif(btrim(coalesce(t.guest_name, '')), ''),
             p.username::text),
    t.checked_in_at
  from public.venue_sections s
  join public.venue_seats vs on vs.venue_section_id = s.id
  left join public.tickets t
    on t.venue_seat_id = vs.id and t.event_id = p_event_id and t.status in ('valid', 'used')
  left join public.profiles p on p.id = t.buyer_id
  where s.venue_map_id = (select e.venue_map_id from public.events e where e.id = p_event_id)
  order by s.sort_order, s.name, vs.row_label, vs.seat_number;
end;
$$;

revoke all on function public.event_seat_manifest(uuid) from public, anon;
grant execute on function public.event_seat_manifest(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The attendee list learns about seats
-- ---------------------------------------------------------------------------
-- Adding a column to the result changes the signature, so the old one has to go
-- first. The body is 0055's, with the seat joined on and made searchable.
drop function if exists public.event_ticket_holders(uuid, text, text, integer, integer);

create or replace function public.event_ticket_holders(
  p_event_id uuid,
  p_query    text    default null,
  p_status   text    default null,
  p_limit    integer default 100,
  p_offset   integer default 0
)
returns table (
  ticket_id      uuid,
  code           text,
  status         ticket_status,
  holder_name    text,
  email          text,
  username       text,
  buyer_id       uuid,
  is_guest       boolean,
  ticket_type    text,
  price_cents    integer,
  currency       text,
  is_complimentary boolean,
  checked_in_at  timestamptz,
  deactivated_at timestamptz,
  deactivation_reason text,
  order_id       uuid,
  created_at     timestamptz,
  -- "Tribúna A · rad D, miesto 14", or null for a ticket that names no chair.
  seat_label     text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  needle text := nullif(btrim(coalesce(p_query, '')), '');
  want   text := nullif(btrim(coalesce(p_status, '')), '');
begin
  perform public.assert_can_read_event_stats(p_event_id);

  return query
  select
    t.id,
    t.code,
    t.status,
    -- Whatever name we actually have: the one written on the ticket, then the
    -- account's, then the guest name from the order. Never a placeholder that
    -- looks like a person.
    coalesce(nullif(btrim(coalesce(t.holder_name, '')), ''),
             nullif(btrim(coalesce(p.display_name, '')), ''),
             nullif(btrim(coalesce(t.guest_name, '')), ''),
             p.username::text),
    coalesce(public.ticket_email_for(t.buyer_id), t.guest_email::text),
    p.username::text,
    t.buyer_id,
    t.buyer_id is null,
    tt.name,
    t.price_cents,
    t.currency,
    coalesce(t.is_complimentary, false),
    t.checked_in_at,
    t.deactivated_at,
    t.deactivation_reason,
    t.order_id,
    t.created_at,
    case when vs.id is null then null
         else vsec.name || ' · rad ' || vs.row_label || ', miesto ' || vs.seat_number
    end
  from public.tickets t
  left join public.profiles p on p.id = t.buyer_id
  left join public.ticket_types tt on tt.id = t.ticket_type_id
  left join public.venue_seats vs on vs.id = t.venue_seat_id
  left join public.venue_sections vsec on vsec.id = vs.venue_section_id
  where t.event_id = p_event_id
    and (want is null or t.status::text = want)
    and (
      needle is null
      or t.code ilike '%' || needle || '%'
      or coalesce(t.holder_name, '') ilike '%' || needle || '%'
      or coalesce(t.guest_name, '') ilike '%' || needle || '%'
      or coalesce(p.display_name, '') ilike '%' || needle || '%'
      or coalesce(p.username::text, '') ilike '%' || needle || '%'
      or coalesce(t.guest_email::text, '') ilike '%' || needle || '%'
      or coalesce(public.ticket_email_for(t.buyer_id), '') ilike '%' || needle || '%'
      -- At the door people are found by their seat far more often than by the
      -- code on a phone screen they are still unlocking.
      or coalesce(vs.row_label || vs.seat_number::text, '') ilike '%' || needle || '%'
      or coalesce(vs.row_label || ' ' || vs.seat_number::text, '') ilike '%' || needle || '%'
    )
  order by t.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.event_ticket_holders(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.event_ticket_holders(uuid, text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- The plain ticket list stops selling numbered seats blind
-- ---------------------------------------------------------------------------
-- Otherwise "Sedenie A × 2" is an ordinary row in the ticket list, and two
-- people leave with tickets to a numbered stand and no seat on them. The body
-- is 0036's with one check added.
create or replace function public.cart_add(
  p_ticket_type_id uuid,
  p_quantity       integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid       uuid := auth.uid();
  tt        public.ticket_types;
  ev        public.events;
  cap       integer;
  hold      integer;
  mine      integer;
  in_basket integer;
  others    integer;
  wanted    integer;
begin
  if uid is null then
    -- AUTH_REQUIRED, as the original raised: the app maps these codes to
    -- messages and a renamed one becomes an untranslated string on screen.
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
  end if;

  perform public.release_expired_holds();

  select * into tt from public.ticket_types where id = p_ticket_type_id and is_active;
  if not found then raise exception 'TICKET_TYPE_NOT_FOUND'; end if;

  select * into ev from public.events where id = tt.event_id;
  if ev.status <> 'published' then raise exception 'EVENT_NOT_ON_SALE'; end if;

  -- A sector with named seats is bought by naming one. create_order() refuses
  -- this too, but refusing it here is the difference between a ticket list that
  -- does not offer the button and one that offers it and fails at the till.
  if exists (
    select 1
    from public.venue_sections s
    join public.venue_seats vs on vs.venue_section_id = s.id
    where s.ticket_type_id = tt.id
    limit 1
  ) then
    raise exception 'SEAT_REQUIRED';
  end if;

  if tt.sales_start_at is not null and now() < tt.sales_start_at then
    raise exception 'SALES_NOT_OPEN';
  end if;
  if tt.sales_end_at is not null and now() > tt.sales_end_at then
    raise exception 'SALES_CLOSED';
  end if;

  select coalesce(max_tickets_per_order, 20), coalesce(cart_hold_minutes, 15)
    into cap, hold from public.platform_settings limit 1;
  cap := coalesce(cap, 20);
  hold := coalesce(hold, 15);

  -- A basket holds one event at a time.
  if exists (
    select 1 from public.cart_items c
    where c.user_id = uid and c.expires_at > now() and c.event_id <> ev.id
  ) then
    raise exception 'CART_OTHER_EVENT';
  end if;

  select coalesce(quantity, 0) into mine
  from public.cart_items
  where user_id = uid and ticket_type_id = tt.id and venue_seat_id is null and expires_at > now();
  mine := coalesce(mine, 0);

  select coalesce(sum(quantity), 0) into in_basket
  from public.cart_items
  where user_id = uid and expires_at > now()
    and not (ticket_type_id = tt.id and venue_seat_id is null);

  wanted := mine + p_quantity;

  if wanted > tt.max_per_order then
    raise exception 'QUANTITY_ABOVE_LIMIT';
  end if;
  if in_basket + wanted > cap then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  others := public.held_quantity(tt.id, uid);
  if tt.quantity_sold + others + wanted > tt.quantity_total then
    raise exception 'SOLD_OUT';
  end if;

  insert into public.cart_items (user_id, event_id, ticket_type_id, quantity, expires_at)
  values (uid, ev.id, tt.id, wanted, now() + make_interval(mins => hold))
  on conflict (user_id, ticket_type_id) where venue_seat_id is null do update
    set quantity = excluded.quantity,
        expires_at = excluded.expires_at;

  update public.cart_items
  set expires_at = now() + make_interval(mins => hold)
  where user_id = uid;

  return public.cart_view(null);
end;
$$;

revoke execute on function public.cart_add(uuid, integer) from public, anon;
grant execute on function public.cart_add(uuid, integer) to authenticated;
