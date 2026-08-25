-- ============================================================================
-- Selling by sector, and by seat.
--
-- The design constraint given was that plans of real venues will not exist for
-- a long time, so this cannot depend on having one. It does not: an organizer
-- uploads a picture of the layout — a photo, a PDF export, a drawing — and
-- marks rectangles on it. The picture is decoration; the rectangles are data.
--
-- A sector is a ticket type. That is the whole trick, and it is why this is a
-- small migration rather than a parallel ticketing system: pricing, holds, the
-- 20-per-order cap, promo splitting, the ledger and the archive fee already
-- work on ticket types and are already tested. A sector adds a shape on a
-- picture and, optionally, named seats inside it.
--
-- Numbered seating sits on top rather than beside: a seat belongs to a sector,
-- a held seat is a cart line of quantity one that names it, and a ticket points
-- at the seat it was sold for. A sector with no seats sells by count, exactly
-- as ticket types do today.
-- ============================================================================

create table if not exists public.venue_maps (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null,
  -- The picture the sectors are drawn on. Sectors are stored in its own
  -- coordinate space, so the plan can be re-photographed without moving them.
  image_url       text,
  image_width     integer not null default 1000 check (image_width between 1 and 20000),
  image_height    integer not null default 1000 check (image_height between 1 and 20000),
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint venue_maps_name_len check (char_length(name) between 2 and 80)
);

create index if not exists venue_maps_org_idx on public.venue_maps (organization_id);

-- ---------------------------------------------------------------------------
-- A sector: a rectangle on the plan, tied to what it sells.
-- ---------------------------------------------------------------------------
create table if not exists public.venue_sections (
  id             uuid primary key default gen_random_uuid(),
  venue_map_id   uuid not null references public.venue_maps (id) on delete cascade,
  ticket_type_id uuid references public.ticket_types (id) on delete cascade,
  name           text not null,
  colour         text not null default '#0080FF',
  -- Fractions of the image, 0..1, so the shape survives any resize of the plan.
  x              numeric(6,5) not null check (x between 0 and 1),
  y              numeric(6,5) not null check (y between 0 and 1),
  width          numeric(6,5) not null check (width  > 0 and width  <= 1),
  height         numeric(6,5) not null check (height > 0 and height <= 1),
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),

  constraint venue_sections_name_len check (char_length(name) between 1 and 60),
  constraint venue_sections_fits check (x + width <= 1.00001 and y + height <= 1.00001)
);

create index if not exists venue_sections_map_idx on public.venue_sections (venue_map_id, sort_order);
create index if not exists venue_sections_type_idx on public.venue_sections (ticket_type_id);

-- ---------------------------------------------------------------------------
-- A seat. Optional: a sector without seats sells by count.
-- ---------------------------------------------------------------------------
create table if not exists public.venue_seats (
  id                uuid primary key default gen_random_uuid(),
  venue_section_id  uuid not null references public.venue_sections (id) on delete cascade,
  row_label         text not null,
  seat_number       integer not null check (seat_number > 0),
  -- A seat that exists but must not be sold: a pillar in front of it, a
  -- wheelchair space held back, a seat the fire officer took away.
  is_sellable       boolean not null default true,
  created_at        timestamptz not null default now(),

  unique (venue_section_id, row_label, seat_number),
  constraint venue_seats_row_len check (char_length(row_label) between 1 and 8)
);

create index if not exists venue_seats_section_idx on public.venue_seats (venue_section_id);

-- Link the map to the event, and a sold ticket to its seat.
alter table public.events     add column if not exists venue_map_id uuid references public.venue_maps (id) on delete set null;
alter table public.tickets    add column if not exists venue_seat_id uuid references public.venue_seats (id) on delete set null;
alter table public.cart_items add column if not exists venue_seat_id uuid references public.venue_seats (id) on delete cascade;

-- A seat is sold once. A partial unique index rather than a constraint, so the
-- rule applies to live tickets and lets a refunded seat go back on sale.
create unique index if not exists tickets_seat_once
  on public.tickets (venue_seat_id)
  where venue_seat_id is not null and status in ('valid', 'used');

-- And held once. cart_items already has (user_id, ticket_type_id) unique, which
-- would stop one person holding two seats of the same type — so a seat line is
-- exempted from that and gets its own rule instead.
-- The constraint owns its index, so the constraint has to go first.
alter table public.cart_items drop constraint if exists cart_items_user_id_ticket_type_id_key;
drop index if exists cart_items_user_id_ticket_type_id_key;

create unique index if not exists cart_items_one_per_type
  on public.cart_items (user_id, ticket_type_id)
  where venue_seat_id is null;

create unique index if not exists cart_items_seat_held_once
  on public.cart_items (venue_seat_id)
  where venue_seat_id is not null;

-- A seat line is exactly one seat.
alter table public.cart_items drop constraint if exists cart_items_seat_is_single;
alter table public.cart_items add constraint cart_items_seat_is_single
  check (venue_seat_id is null or quantity = 1);

-- cart_add targeted the constraint that just became a partial index, so its
-- ON CONFLICT has to carry the same predicate. Only that one line changes; the
-- rest is the function as it was, repeated here because Postgres has no way to
-- patch a body in place.
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

revoke execute on function public.cart_add(uuid, integer) from public;
grant execute on function public.cart_add(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- What is still free
-- ---------------------------------------------------------------------------
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
  taken as (
    select t.venue_seat_id as seat_id
    from public.tickets t
    where t.event_id = p_event_id and t.venue_seat_id is not null
      and t.status in ('valid', 'used')
    union
    select c.venue_seat_id
    from public.cart_items c
    where c.event_id = p_event_id and c.venue_seat_id is not null
      and c.expires_at > now()
  )
  select case when (select venue_map_id from ev) is null then null else
    jsonb_build_object(
      'map', to_jsonb(m) - 'created_by',
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
            -- For a numbered sector this is seats left; for an open one it is
            -- whatever the ticket type has left, so the two read the same way.
            'available', case
              when exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id)
                then (select count(*) from public.venue_seats vs
                      where vs.venue_section_id = s.id and vs.is_sellable
                        and vs.id not in (select seat_id from taken))
              -- ticket_type_availability returns a row, not a number.
              else coalesce((select a.available
                             from public.ticket_type_availability(s.ticket_type_id) a), 0)
            end,
            'seats', coalesce((
              select jsonb_agg(jsonb_build_object(
                'id', vs.id,
                'row', vs.row_label,
                'number', vs.seat_number,
                'free', vs.is_sellable and vs.id not in (select seat_id from taken)
              ) order by vs.row_label, vs.seat_number)
              from public.venue_seats vs where vs.venue_section_id = s.id
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
-- Holding a seat
-- ---------------------------------------------------------------------------
create or replace function public.cart_hold_seat(p_seat_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user    uuid := auth.uid();
  v_section public.venue_sections;
  v_seat    public.venue_seats;
  v_event   uuid;
  v_minutes integer;
  v_held    integer;
  v_max     integer;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into v_seat from public.venue_seats where id = p_seat_id;
  if not found then raise exception 'SEAT_NOT_FOUND'; end if;
  if not v_seat.is_sellable then raise exception 'SEAT_NOT_SELLABLE'; end if;

  select * into v_section from public.venue_sections where id = v_seat.venue_section_id;
  if v_section.ticket_type_id is null then raise exception 'SECTION_NOT_ON_SALE'; end if;

  select tt.event_id into v_event from public.ticket_types tt where tt.id = v_section.ticket_type_id;
  if v_event is null then raise exception 'SECTION_NOT_ON_SALE'; end if;

  -- Expired holds first, or a seat abandoned fifteen minutes ago still looks
  -- taken to the next person to want it.
  perform public.release_expired_holds();

  if exists (
    select 1 from public.tickets t
    where t.venue_seat_id = p_seat_id and t.status in ('valid', 'used')
  ) then
    raise exception 'SEAT_TAKEN';
  end if;

  if exists (
    select 1 from public.cart_items c
    where c.venue_seat_id = p_seat_id and c.expires_at > now() and c.user_id <> v_user
  ) then
    raise exception 'SEAT_HELD';
  end if;

  select coalesce(max_tickets_per_order, 20), coalesce(cart_hold_minutes, 15)
    into v_max, v_minutes
  from public.platform_settings limit 1;

  select coalesce(sum(quantity), 0) into v_held
  from public.cart_items
  where user_id = v_user and event_id = v_event and expires_at > now();

  if v_held >= coalesce(v_max, 20) then
    raise exception 'CART_LIMIT_REACHED';
  end if;

  insert into public.cart_items (user_id, event_id, ticket_type_id, venue_seat_id, quantity, expires_at)
  values (v_user, v_event, v_section.ticket_type_id, p_seat_id, 1,
          now() + make_interval(mins => coalesce(v_minutes, 15)))
  on conflict (venue_seat_id) where venue_seat_id is not null
  do update set expires_at = now() + make_interval(mins => coalesce(v_minutes, 15));

  return jsonb_build_object(
    'seat_id', p_seat_id,
    'section', v_section.name,
    'row', v_seat.row_label,
    'number', v_seat.seat_number,
    'expires_at', now() + make_interval(mins => coalesce(v_minutes, 15))
  );
end;
$$;

revoke execute on function public.cart_hold_seat(uuid) from public;
grant execute on function public.cart_hold_seat(uuid) to authenticated;

create or replace function public.cart_release_seat(p_seat_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  delete from public.cart_items
  where venue_seat_id = p_seat_id and user_id = auth.uid();
end;
$$;

revoke execute on function public.cart_release_seat(uuid) from public;
grant execute on function public.cart_release_seat(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.venue_maps     enable row level security;
alter table public.venue_sections enable row level security;
alter table public.venue_seats    enable row level security;

-- A plan is public: it is what a buyer picks a seat from.
drop policy if exists venue_maps_select on public.venue_maps;
create policy venue_maps_select on public.venue_maps for select using (true);

drop policy if exists venue_maps_write on public.venue_maps;
create policy venue_maps_write on public.venue_maps
  for all using (public.is_org_member(organization_id, null, auth.uid()) or public.is_admin())
  with check (public.is_org_member(organization_id, null, auth.uid()) or public.is_admin());

drop policy if exists venue_sections_select on public.venue_sections;
create policy venue_sections_select on public.venue_sections for select using (true);

drop policy if exists venue_sections_write on public.venue_sections;
create policy venue_sections_write on public.venue_sections
  for all using (exists (
    select 1 from public.venue_maps m
    where m.id = venue_map_id
      and (public.is_org_member(m.organization_id, null, auth.uid()) or public.is_admin())
  ))
  with check (exists (
    select 1 from public.venue_maps m
    where m.id = venue_map_id
      and (public.is_org_member(m.organization_id, null, auth.uid()) or public.is_admin())
  ));

drop policy if exists venue_seats_select on public.venue_seats;
create policy venue_seats_select on public.venue_seats for select using (true);

drop policy if exists venue_seats_write on public.venue_seats;
create policy venue_seats_write on public.venue_seats
  for all using (exists (
    select 1 from public.venue_sections s
    join public.venue_maps m on m.id = s.venue_map_id
    where s.id = venue_section_id
      and (public.is_org_member(m.organization_id, null, auth.uid()) or public.is_admin())
  ))
  with check (exists (
    select 1 from public.venue_sections s
    join public.venue_maps m on m.id = s.venue_map_id
    where s.id = venue_section_id
      and (public.is_org_member(m.organization_id, null, auth.uid()) or public.is_admin())
  ));
