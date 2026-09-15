-- ============================================================================
-- BLUP · 0048 · Complimentary tickets, and events BLUP lists for somebody else
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Part 1 · Events BLUP adds on somebody else's behalf
-- ---------------------------------------------------------------------------
-- At the start the catalogue has to be seeded by hand, which means BLUP typing
-- in other people's events. The instinct is to hide the organizer on those —
-- but an event with no named organizer does not read as "somebody else's", it
-- reads as BLUP's, by omission. It also contradicts our own terms, which say
-- the contract is between the buyer and the organizer: there has to be one.
--
-- So the opposite: name them. The event carries the real organizer's name as
-- text and a link to wherever it was announced, and says on its face that BLUP
-- listed it. When the organizer turns up, they claim it and it becomes theirs.
alter table public.events
  add column if not exists listed_by_platform    boolean not null default false,
  add column if not exists external_organizer_name text,
  add column if not exists external_source_url     text;

alter table public.events
  drop constraint if exists events_listing_names_organizer;
alter table public.events
  add constraint events_listing_names_organizer check (
    not listed_by_platform
    or (external_organizer_name is not null and btrim(external_organizer_name) <> '')
  );

-- A listing is somebody else's event. It cannot also be hosted by one of our
-- organizations — that is the thing a claim turns it into.
alter table public.events
  drop constraint if exists events_listing_has_no_organization;
alter table public.events
  add constraint events_listing_has_no_organization check (
    not listed_by_platform or organization_id is null
  );

create index if not exists events_listed_idx
  on public.events (listed_by_platform) where listed_by_platform;

-- Only an admin may mark an event as listed-on-behalf-of. Without this any user
-- could label their own event as "added by BLUP" and borrow the credibility.
create or replace function public.guard_platform_listing()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'INSERT' then
    if new.listed_by_platform and not public.is_admin() then
      raise exception 'NOT_AUTHORIZED'
        using hint = 'Only BLUP staff can list an event on another organizer''s behalf.';
    end if;
    return new;
  end if;

  -- On update: the flag and the attribution move together, and only for staff.
  if (new.listed_by_platform    is distinct from old.listed_by_platform
   or new.external_organizer_name is distinct from old.external_organizer_name
   or new.external_source_url     is distinct from old.external_source_url)
    and not public.is_admin()
  then
    raise exception 'NOT_AUTHORIZED'
      using hint = 'The listing attribution is maintained by BLUP staff.';
  end if;

  return new;
end;
$$;

drop trigger if exists events_guard_platform_listing on public.events;
create trigger events_guard_platform_listing
  before insert or update on public.events
  for each row execute function public.guard_platform_listing();

-- --- claiming ---------------------------------------------------------------
create table if not exists public.event_claims (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  claimed_by      uuid not null references public.profiles (id) on delete cascade,
  note            text,
  status          text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz not null default now()
);

-- One open claim per event per organization; a rejected one may be retried.
create unique index if not exists event_claims_one_open
  on public.event_claims (event_id, organization_id) where status = 'pending';
create index if not exists event_claims_pending_idx
  on public.event_claims (status, created_at desc);

alter table public.event_claims enable row level security;

drop policy if exists event_claims_select on public.event_claims;
create policy event_claims_select on public.event_claims
  for select using (
    public.is_admin()
    or claimed_by = auth.uid()
    or public.is_org_member(organization_id, null)
  );

drop policy if exists event_claims_write on public.event_claims;
create policy event_claims_write on public.event_claims
  for all using (public.is_admin()) with check (public.is_admin());

-- An organizer says "this is ours". It is a request, not a transfer: anyone can
-- click it, so nothing moves until a human at BLUP agrees.
create or replace function public.claim_event(
  p_event_id        uuid,
  p_organization_id uuid,
  p_note            text default null
)
returns public.event_claims
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ev public.events;
  c  public.event_claims;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if not public.is_org_member(p_organization_id, array['owner', 'admin']::org_role[]) then
    raise exception 'NOT_AUTHORIZED'
      using hint = 'Only an owner or admin of the organization can claim an event for it.';
  end if;

  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if not ev.listed_by_platform then
    raise exception 'EVENT_NOT_CLAIMABLE'
      using hint = 'Only an event BLUP listed on somebody''s behalf can be claimed.';
  end if;

  insert into public.event_claims (event_id, organization_id, claimed_by, note)
  values (p_event_id, p_organization_id, auth.uid(), p_note)
  on conflict (event_id, organization_id) where status = 'pending'
    do update set note = coalesce(excluded.note, public.event_claims.note)
  returning * into c;

  return c;
end;
$$;

create or replace function public.decide_event_claim(
  p_claim_id uuid,
  p_approve  boolean,
  p_note     text default null
)
returns public.event_claims
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  c public.event_claims;
begin
  if not public.is_full_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.event_claims
  set status        = case when p_approve then 'approved' else 'rejected' end,
      decided_by    = auth.uid(),
      decided_at    = now(),
      decision_note = p_note
  where id = p_claim_id and status = 'pending'
  returning * into c;

  if not found then
    raise exception 'CLAIM_NOT_PENDING';
  end if;

  if p_approve then
    -- It stops being a listing the moment it has a real owner. Both flags clear
    -- together: an event cannot be "listed by BLUP" and hosted by somebody.
    update public.events
    set organization_id       = c.organization_id,
        listed_by_platform    = false,
        external_organizer_name = null,
        external_source_url   = null
    where id = c.event_id;

    -- Every other open claim on the same event is now moot.
    update public.event_claims
    set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
        decision_note = 'Event bol pridelený inej organizácii'
    where event_id = c.event_id and status = 'pending' and id <> c.id;
  end if;

  insert into public.notifications (user_id, type, title, body, event_id, data)
  values (
    c.claimed_by, 'org_verified',
    case when p_approve then 'Event je tvoj' else 'Nárok na event zamietnutý' end,
    case when p_approve
         then 'Prevzali sme ti ho pod tvoju organizáciu. Môžeš ho upravovať.'
         else coalesce(p_note, 'Nepodarilo sa nám overiť, že je tvoj.') end,
    c.event_id, jsonb_build_object('claim_id', c.id)
  );

  return c;
end;
$$;

revoke all on function public.decide_event_claim(uuid, boolean, text) from public, anon;
grant execute on function public.decide_event_claim(uuid, boolean, text) to authenticated;
grant execute on function public.claim_event(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Part 2 · Complimentary tickets
-- ---------------------------------------------------------------------------
-- A paid event still needs a way to hand somebody a ticket for nothing: a
-- competition winner, a guest, press, the sound engineer's partner. Doing it by
-- refunding a real purchase is worse in every way — it touches Stripe, it
-- muddles the takings, and it can be disputed later.
--
-- A comp is a real ticket. Same QR, same scanner, same one-use rule. What makes
-- it different is that it is worth zero, so it writes no ledger entry: there is
-- no money to hold, no reserve, no commission. It does take a seat, because the
-- venue's capacity does not care how the ticket was obtained.
alter table public.tickets
  add column if not exists is_complimentary boolean not null default false,
  add column if not exists issued_by uuid references public.profiles (id) on delete set null,
  add column if not exists issue_note text;

create index if not exists tickets_comp_idx
  on public.tickets (event_id) where is_complimentary;

-- Finds the person a comp is meant for. Organizers have the recipient's
-- @username or the address they signed up with, not their uuid.
create or replace function public.find_recipient(p_handle text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p.id
  from public.profiles p
  where p.username = btrim(ltrim(btrim(p_handle), '@'))::citext
  union all
  select u.id
  from auth.users u
  where lower(u.email) = lower(btrim(p_handle))
  limit 1;
$$;

revoke all on function public.find_recipient(text) from public, anon, authenticated;

create or replace function public.issue_comp_tickets(
  p_ticket_type_id uuid,
  p_recipient      text,
  p_quantity       integer default 1,
  p_note           text     default null
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

  -- Whoever runs the event. `event_manager` is included on purpose: handing out
  -- guest tickets is exactly the job that role exists for.
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

  recipient := public.find_recipient(p_recipient);
  if recipient is null then
    raise exception 'RECIPIENT_NOT_FOUND'
      using hint = 'The recipient needs a BLUP account — send them @username or the e-mail they signed up with.';
  end if;

  -- A free ticket still occupies a place. Checked against the same total the
  -- paid path uses, so a comp cannot oversell the room.
  if tt.quantity_sold + p_quantity > tt.quantity_total then
    raise exception 'SOLD_OUT'
      using hint = 'Raise the ticket type''s quantity first if you want to add seats.';
  end if;

  -- An order at zero, so the ticket has the same shape as every other ticket
  -- and the accounting export does not have to special-case it. `manual` marks
  -- where it came from; no provider was involved.
  insert into public.orders (
    event_id, organization_id, ticket_type_id, buyer_id, quantity,
    unit_price_cents, subtotal_cents, platform_fee_cents, total_cents, currency,
    payment_status, provider, provider_reference, paid_at
  )
  values (
    ev.id, ev.organization_id, tt.id, recipient, p_quantity,
    0, 0, 0, 0, coalesce(tt.currency, 'EUR'),
    'succeeded', 'manual', 'comp_' || public.blup_short_code(12), now()
  )
  returning * into ord;

  for i in 1..p_quantity loop
    insert into public.tickets (
      order_id, event_id, ticket_type_id, buyer_id, code, qr_secret,
      price_cents, currency, is_complimentary, issued_by, issue_note
    )
    values (
      ord.id, ev.id, tt.id, recipient,
      'BLP-' || public.blup_short_code(10),
      encode(gen_random_bytes(24), 'hex'),
      0, coalesce(tt.currency, 'EUR'), true, auth.uid(), p_note
    );
  end loop;

  insert into public.event_attendees (event_id, user_id, status)
  values (ev.id, recipient, 'going')
  on conflict (event_id, user_id) do update set status = 'going';

  insert into public.notifications (user_id, type, title, body, event_id, data)
  values (
    recipient, 'ticket_confirmed', 'Dostal si vstupenku',
    coalesce(nullif(btrim(p_note), ''), 'Organizátor ti poslal vstupenku. Nájdeš ju v sekcii Vstupenky.'),
    ev.id, jsonb_build_object('order_id', ord.id, 'complimentary', true)
  );

  -- Same delivery as a bought ticket: the QR has to reach them by e-mail too,
  -- because "it is in the app" fails at the door on a dead phone.
  perform public.queue_ticket_email(ord.id);

  return query select * from public.tickets t where t.order_id = ord.id;
end;
$$;

revoke all on function public.issue_comp_tickets(uuid, text, integer, text) from public, anon;
grant execute on function public.issue_comp_tickets(uuid, text, integer, text) to authenticated;

-- How many were given away, for the organizer's own numbers. Comps are not
-- revenue, so they must never quietly inflate a sales figure — they are counted
-- separately and reported separately.
create or replace function public.event_comp_summary(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'issued',    count(*),
    'checked_in', count(*) filter (where t.checked_in_at is not null),
    'cancelled', count(*) filter (where t.status = 'cancelled')
  )
  from public.tickets t
  where t.event_id = p_event_id and t.is_complimentary;
$$;

grant execute on function public.event_comp_summary(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin dashboard: claims waiting on a human
-- ---------------------------------------------------------------------------
create or replace function public.admin_platform_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'suspended_users', (select count(*) from public.profiles where is_suspended),
    'events', (select count(*) from public.events),
    'published_events', (select count(*) from public.events where status = 'published'),
    'listed_events', (select count(*) from public.events where listed_by_platform),
    'organizations', (select count(*) from public.organizations),
    'pending_verifications', (select count(*) from public.organization_verification_requests where status = 'pending'),
    'pending_event_claims', (select count(*) from public.event_claims where status = 'pending'),
    'tickets', (select count(*) from public.tickets),
    'complimentary_tickets', (select count(*) from public.tickets where is_complimentary),
    'open_reports', (select count(*) from public.reports where status = 'open'),
    'gross_sales_cents', coalesce((select sum(subtotal_cents) from public.orders where payment_status = 'succeeded'), 0),
    'net_sales_cents', coalesce((select sum(net_cents) from public.orders where payment_status = 'succeeded'), 0),
    'commission_cents', coalesce((select sum(commission_cents) from public.orders where payment_status = 'succeeded'), 0),
    'archive_fee_cents', coalesce((select sum(archive_fee_cents) from public.orders where payment_status = 'succeeded'), 0),
    'boost_revenue_cents', coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'platform_revenue_cents',
      coalesce((select sum(blup_revenue_cents) from public.orders where payment_status = 'succeeded'), 0)
      + coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'pending_payouts', (select count(*) from public.payouts where status = 'pending'),
    'open_disputes', (select count(*) from public.payment_disputes where status = 'open'),
    'frozen_organizations',
      (select count(distinct organization_id) from public.payment_disputes where status = 'open'),
    'premium_users', (select count(distinct user_id) from public.premium_subscriptions
                      where status in ('active', 'trialing', 'grace_period')
                        and (expires_at is null or expires_at > now()))
  );
end;
$$;
