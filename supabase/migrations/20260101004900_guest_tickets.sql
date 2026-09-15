-- ============================================================================
-- BLUP · 0049 · Tickets for people who are not on BLUP yet
-- ============================================================================
-- Comps could only go to an existing account, because a ticket had to belong to
-- a profile. That fails the case they exist for: the winner of an Instagram
-- competition has an e-mail address and no reason to have heard of us.
--
-- So a ticket may now belong to an address instead. Two things follow, and both
-- matter more than the account does:
--
--   * At the door nothing changes. The scanner validates the ticket, never the
--     person — the QR in their inbox works exactly like the QR in the app.
--   * If they do sign up, the ticket finds them: on the address they used, or
--     through the claim link in the e-mail when they signed up with another.
--
-- The alternative — "make an account first" — puts a registration form between
-- somebody and a prize they already won.
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- A ticket belongs to an account or to an address. Never to neither.
-- ---------------------------------------------------------------------------
alter table public.orders
  alter column buyer_id drop not null,
  add column if not exists guest_email citext,
  add column if not exists guest_name  text,
  -- Lets somebody who signed up with a different address still collect it.
  add column if not exists claim_token text unique;

alter table public.orders
  drop constraint if exists orders_has_a_recipient;
alter table public.orders
  add constraint orders_has_a_recipient
    check (buyer_id is not null or guest_email is not null);

alter table public.tickets
  alter column buyer_id drop not null,
  add column if not exists guest_email citext,
  add column if not exists guest_name  text;

alter table public.tickets
  drop constraint if exists tickets_has_a_holder;
alter table public.tickets
  add constraint tickets_has_a_holder
    check (buyer_id is not null or guest_email is not null);

create index if not exists tickets_guest_email_idx
  on public.tickets (guest_email) where guest_email is not null;
create index if not exists orders_guest_email_idx
  on public.orders (guest_email) where guest_email is not null;

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------
-- auth.users is not readable from a policy, so the address has to come through
-- a definer function. Returns null for an anonymous caller, which makes every
-- comparison below false rather than true — the safe direction.
create or replace function public.current_user_email()
returns citext
language sql
stable
security definer
set search_path = public, extensions
as $$
  select lower(u.email)::citext from auth.users u where u.id = auth.uid();
$$;

revoke all on function public.current_user_email() from public, anon;
grant execute on function public.current_user_email() to authenticated;

-- A guest ticket is visible to whoever holds that address, once they sign in.
drop policy if exists tickets_select on public.tickets;
create policy tickets_select on public.tickets
  for select using (
    buyer_id = auth.uid()
    or (guest_email is not null and guest_email = public.current_user_email())
    or public.is_admin()
    or exists (select 1 from public.events e where e.id = event_id
               and (e.creator_id = auth.uid()
                    or (e.organization_id is not null and public.is_org_member(e.organization_id, null))))
  );

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
  for select using (
    buyer_id = auth.uid()
    or (guest_email is not null and guest_email = public.current_user_email())
    or public.is_admin()
    or exists (select 1 from public.events e where e.id = event_id
               and (e.creator_id = auth.uid()
                    or (e.organization_id is not null and public.is_org_member(e.organization_id, null))))
  );

-- ---------------------------------------------------------------------------
-- Things that assumed a ticket had an owner
-- ---------------------------------------------------------------------------
-- Experience points for a ticket nobody owns yet would be points awarded to
-- null. They are granted when the ticket is claimed instead.
create or replace function public.gamify_ticket()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.buyer_id is not null then
    perform public.award_xp(new.buyer_id, 'ticket_purchased', 'ticket', new.id);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Issuing to an address
-- ---------------------------------------------------------------------------
create or replace function public.issue_comp_tickets(
  p_ticket_type_id uuid,
  p_recipient      text,
  p_quantity       integer default 1,
  p_note           text     default null,
  p_guest_name     text     default null
)
returns setof public.tickets
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tt        public.ticket_types;
  ev        public.events;
  recipient uuid;
  handle    text := btrim(coalesce(p_recipient, ''));
  guest     citext;
  ord       public.orders;
  i         integer;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 50 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select * into tt from public.ticket_types where id = p_ticket_type_id;
  if not found then
    raise exception 'TICKET_TYPE_NOT_FOUND';
  end if;

  select * into ev from public.events where id = tt.event_id for update;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if ev.creator_id <> auth.uid()
     and not (ev.organization_id is not null
              and public.is_org_member(ev.organization_id,
                    array['owner', 'admin', 'event_manager']::org_role[]))
     and not public.is_full_admin()
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if public.event_has_ended(ev.start_at, ev.end_at) then
    raise exception 'EVENT_ALREADY_ENDED';
  end if;
  if ev.status = 'cancelled' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- An account if we can find one, an address if we cannot. Looking the account
  -- up first matters: somebody who is already on BLUP should get the ticket in
  -- their app, not a claim link to something they already have.
  recipient := public.find_recipient(handle);

  if recipient is null then
    if position('@' in handle) < 2 then
      raise exception 'RECIPIENT_NOT_FOUND'
        using hint = 'Give an @username of somebody on BLUP, or an e-mail address to send the ticket to.';
    end if;
    guest := lower(handle)::citext;
  end if;

  if tt.quantity_sold + p_quantity > tt.quantity_total then
    raise exception 'SOLD_OUT'
      using hint = 'Raise the ticket type''s quantity first if you want to add seats.';
  end if;

  insert into public.orders (
    event_id, organization_id, ticket_type_id, buyer_id, guest_email, guest_name,
    quantity, unit_price_cents, subtotal_cents, platform_fee_cents, total_cents, currency,
    payment_status, provider, provider_reference, paid_at, claim_token
  )
  values (
    ev.id, ev.organization_id, tt.id, recipient, guest, nullif(btrim(coalesce(p_guest_name, '')), ''),
    p_quantity, 0, 0, 0, 0, coalesce(tt.currency, 'EUR'),
    'succeeded', 'manual', 'comp_' || public.blup_short_code(12), now(),
    case when guest is not null then public.blup_short_code(24) end
  )
  returning * into ord;

  for i in 1..p_quantity loop
    insert into public.tickets (
      order_id, event_id, ticket_type_id, buyer_id, guest_email, guest_name,
      code, qr_secret, price_cents, currency, is_complimentary, issued_by, issue_note
    )
    values (
      ord.id, ev.id, tt.id, recipient, guest, ord.guest_name,
      'BLP-' || public.blup_short_code(10),
      encode(gen_random_bytes(24), 'hex'),
      0, coalesce(tt.currency, 'EUR'), true, auth.uid(), p_note
    );
  end loop;

  if recipient is not null then
    insert into public.event_attendees (event_id, user_id, status)
    values (ev.id, recipient, 'going')
    on conflict (event_id, user_id) do update set status = 'going';

    insert into public.notifications (user_id, type, title, body, event_id, data)
    values (
      recipient, 'ticket_confirmed', 'Dostal si vstupenku',
      coalesce(nullif(btrim(p_note), ''), 'Organizátor ti poslal vstupenku. Nájdeš ju v sekcii Vstupenky.'),
      ev.id, jsonb_build_object('order_id', ord.id, 'complimentary', true)
    );
  end if;

  -- For a guest this e-mail is the only copy they have, so it is not optional
  -- the way it is for somebody who can open the app.
  perform public.queue_ticket_email(ord.id);

  return query select * from public.tickets t where t.order_id = ord.id;
end;
$$;

revoke all on function public.issue_comp_tickets(uuid, text, integer, text, text) from public, anon;
grant execute on function public.issue_comp_tickets(uuid, text, integer, text, text) to authenticated;

-- The four-argument form is gone; drop it so a stale client fails loudly rather
-- than silently calling something that no longer matches.
drop function if exists public.issue_comp_tickets(uuid, text, integer, text);

-- ---------------------------------------------------------------------------
-- Delivery, without a profile to read the address off
-- ---------------------------------------------------------------------------
create or replace function public.queue_ticket_email(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o        public.orders;
  ev       public.events;
  v_email  text;
  v_id     uuid;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or o.payment_status <> 'succeeded' then
    return null;
  end if;

  -- An account's notification address if there is an account; the address the
  -- ticket was sent to if there is not.
  v_email := coalesce(public.ticket_email_for(o.buyer_id), o.guest_email::text);
  if v_email is null then
    return null;
  end if;

  select * into ev from public.events where id = o.event_id;

  insert into public.email_deliveries (kind, user_id, order_id, event_id, to_email, subject)
  values ('ticket', o.buyer_id, o.id, o.event_id, v_email,
          'Tvoja vstupenka · ' || coalesce(ev.title, 'Blup'))
  on conflict (kind, order_id) where order_id is not null do nothing
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.ticket_email_payload(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  o      public.orders;
  ev     public.events;
  org    public.organizations;
  buyer  public.profiles;
  result jsonb;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  select * into ev from public.events where id = o.event_id;
  select * into org from public.organizations where id = o.organization_id;
  select * into buyer from public.profiles where id = o.buyer_id;

  select jsonb_build_object(
    'order_id',        o.id,
    'order_reference', coalesce(o.provider_reference, left(o.id::text, 8)),
    'quantity',        o.quantity,
    'currency',        o.currency,
    'total_cents',     o.total_cents,
    'unit_price_cents', o.unit_price_cents,
    'archive_fee_cents', o.archive_fee_cents,
    'buyer_name',      coalesce(buyer.display_name, buyer.username, o.guest_name, 'Host'),
    -- Present only for a ticket that has no account behind it. The e-mail turns
    -- it into a link; it is what lets somebody who signs up with a different
    -- address still end up holding their ticket.
    'claim_token',     o.claim_token,
    'is_guest',        o.buyer_id is null,
    'event', jsonb_build_object(
      'id',         ev.id,
      'title',      ev.title,
      'start_at',   ev.start_at,
      'end_at',     ev.end_at,
      'venue_name', ev.venue_name,
      'address',    ev.address,
      'category',   ev.category
    ),
    'organizer', coalesce(org.name, 'Blup'),
    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',        t.id,
               'code',      t.code,
               'qr_secret', t.qr_secret,
               'type',      tt.name,
               'price_cents', t.price_cents
             ) order by t.created_at, t.id)
      from public.tickets t
      join public.ticket_types tt on tt.id = t.ticket_type_id
      where t.order_id = o.id and t.status <> 'refunded'
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Collecting it later
-- ---------------------------------------------------------------------------
-- Two ways in, because people sign up with whatever address is in front of
-- them. Both attach the same thing: the order, its tickets, and the RSVP.
create or replace function public.attach_order_to_me(p_order public.orders)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  n integer;
begin
  update public.orders
  set buyer_id = auth.uid(), guest_email = null, guest_name = guest_name
  where id = p_order.id and buyer_id is null;

  update public.tickets
  set buyer_id = auth.uid(), guest_email = null
  where order_id = p_order.id and buyer_id is null;

  get diagnostics n = row_count;

  insert into public.event_attendees (event_id, user_id, status)
  values (p_order.event_id, auth.uid(), 'going')
  on conflict (event_id, user_id) do update set status = 'going';

  -- Held back at issue time because there was nobody to give them to.
  perform public.award_xp(auth.uid(), 'ticket_purchased', 'order', p_order.id);

  return n;
end;
$$;

revoke all on function public.attach_order_to_me(public.orders) from public, anon, authenticated;

/**
 * Everything sent to the address I signed up with.
 *
 * Called after sign-in. Safe to call as often as you like: an order that
 * already has an owner is not touched.
 */
create or replace function public.claim_my_guest_tickets()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  mine  citext := public.current_user_email();
  o     public.orders;
  total integer := 0;
begin
  if auth.uid() is null or mine is null then
    return 0;
  end if;

  for o in
    select * from public.orders
    where buyer_id is null and guest_email = mine
  loop
    total := total + public.attach_order_to_me(o);
  end loop;

  return total;
end;
$$;

grant execute on function public.claim_my_guest_tickets() to authenticated;

/**
 * The link in the e-mail, for somebody who signed up with a different address.
 *
 * The token is the proof — whoever has the e-mail has the ticket, which is the
 * same thing the QR code already assumes. It is consumed on use, so a forwarded
 * e-mail cannot hand the same ticket to a second person.
 */
create or replace function public.claim_tickets_with_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o public.orders;
  n integer;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  if p_token is null or btrim(p_token) = '' then
    raise exception 'CLAIM_TOKEN_INVALID';
  end if;

  select * into o from public.orders where claim_token = btrim(p_token) for update;
  if not found then
    raise exception 'CLAIM_TOKEN_INVALID';
  end if;

  if o.buyer_id is not null then
    -- Already collected. If it was this person, say so plainly rather than
    -- failing; they most likely pressed the link twice.
    return jsonb_build_object(
      'ok',        o.buyer_id = auth.uid(),
      'reason',    case when o.buyer_id = auth.uid() then 'ALREADY_YOURS' else 'ALREADY_CLAIMED' end,
      'event_id',  o.event_id,
      'tickets',   0
    );
  end if;

  n := public.attach_order_to_me(o);

  -- Spent. The e-mail keeps working as a ticket; it stops working as a key.
  update public.orders set claim_token = null where id = o.id;

  return jsonb_build_object('ok', true, 'reason', null, 'event_id', o.event_id, 'tickets', n);
end;
$$;

grant execute on function public.claim_tickets_with_token(text) to authenticated;

-- A new account picks up whatever was already waiting for that address, so
-- somebody who signs up after being sent a ticket finds it there on first open.
--
-- NOTE ON THE TRIGGER NAME BELOW. Postgres fires triggers of the same kind in
-- alphabetical order, and orders.buyer_id has a foreign key to profiles — so
-- this has to run after `on_auth_user_created`, which is what creates the
-- profile. `on_auth_user_claim_tickets` sorted *before* it ("cl" < "cr") and
-- failed on the foreign key. The name is load-bearing; keep the prefix.
create or replace function public.claim_guest_tickets_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  mine citext := lower(new.email)::citext;
begin
  if mine is null then
    return new;
  end if;

  update public.orders  set buyer_id = new.id, guest_email = null
  where buyer_id is null and guest_email = mine;

  update public.tickets set buyer_id = new.id, guest_email = null
  where buyer_id is null and guest_email = mine;

  insert into public.event_attendees (event_id, user_id, status)
  select distinct t.event_id, new.id, 'going'::attendee_status
  from public.tickets t
  where t.buyer_id = new.id
  on conflict (event_id, user_id) do nothing;

  return new;
end;
$$;

-- After the profile exists: event_attendees and the tickets both point at it.
drop trigger if exists on_auth_user_claim_tickets on auth.users;
drop trigger if exists on_auth_user_created_zz_claim_tickets on auth.users;
create trigger on_auth_user_created_zz_claim_tickets
  after insert on auth.users
  for each row execute function public.claim_guest_tickets_for_new_user();
