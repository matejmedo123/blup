-- ============================================================================
-- BLUP · 0022 · Ticket delivery by email
-- ============================================================================
-- A ticket that only lives inside the app is a ticket you lose when your phone
-- dies at the door. This adds the second copy: a queued email with a PDF
-- attachment, one page per ticket, QR included.
--
-- The queue is a table rather than a direct call for the same reason the money
-- path is: sending happens over a network that fails. `fulfill_order` enqueues
-- inside the same transaction that issues the tickets, so an email is never
-- queued for an order that did not complete, and never lost for one that did.
-- Delivery is a separate, retryable step.
--
-- Idempotency is a unique index on (kind, order_id): a retried webhook, a
-- double-tapped button and a cron sweep all converge on the same single row.
-- Re-sending on request is deliberate and explicit — `resend_ticket_email()`
-- resets the existing row rather than inserting a second one.
-- ============================================================================

set search_path = public, extensions;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_status') then
    create type email_status as enum ('pending', 'sending', 'sent', 'failed', 'skipped');
  end if;
end
$$;

create table if not exists public.email_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('ticket', 'order_refunded')),
  user_id             uuid references public.profiles (id) on delete set null,
  order_id            uuid references public.orders (id) on delete cascade,
  event_id            uuid references public.events (id) on delete set null,
  to_email            text not null check (position('@' in to_email) > 1),
  subject             text not null,
  status              email_status not null default 'pending',
  attempts            integer not null default 0 check (attempts >= 0),
  last_error          text,
  provider            text,
  provider_message_id text,
  -- Retries back off; the worker only picks up rows whose time has come.
  next_attempt_at     timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  sent_at             timestamptz
);

-- One email of a kind per order. This is the whole idempotency story.
create unique index if not exists email_deliveries_kind_order_key
  on public.email_deliveries (kind, order_id)
  where order_id is not null;

create index if not exists email_deliveries_queue_idx
  on public.email_deliveries (status, next_attempt_at)
  where status in ('pending', 'failed');

alter table public.email_deliveries enable row level security;

-- The recipient may see that their own email was sent, and nothing else.
-- Nobody writes this table from a client; every state change goes through the
-- functions below.
drop policy if exists email_deliveries_select_own on public.email_deliveries;
create policy email_deliveries_select_own on public.email_deliveries
  for select using (user_id = auth.uid() or public.is_admin());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.email_deliveries from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on public.email_deliveries from authenticated';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Where to send it
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists ticket_email text;

comment on column public.profiles.ticket_email is
  'Optional override for ticket delivery. Null means "use the account email".';

/**
 * The address a person's tickets should go to: their override if they set one,
 * otherwise the address they signed up with.
 *
 * Reads auth.users, which is why it is SECURITY DEFINER — the client has no
 * access to that table and should not.
 */
create or replace function public.ticket_email_for(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, auth
as $$
declare
  v_override text;
  v_account  text;
begin
  select ticket_email into v_override from public.profiles where id = p_user_id;
  if v_override is not null and btrim(v_override) <> '' then
    return btrim(v_override);
  end if;

  select email into v_account from auth.users where id = p_user_id;
  return nullif(btrim(coalesce(v_account, '')), '');
end;
$$;

/**
 * Lets a person send their tickets somewhere else — a work address, a partner's
 * inbox. Validated loosely on purpose: the authority on whether an address
 * exists is the mail server, not a regular expression.
 */
create or replace function public.set_ticket_email(p_email text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_clean text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if v_clean is not null and position('@' in v_clean) < 2 then
    raise exception 'INVALID_EMAIL';
  end if;

  update public.profiles set ticket_email = v_clean where id = auth.uid();
  return public.ticket_email_for(auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------
-- Queueing
-- ---------------------------------------------------------------------------

/**
 * Enqueues the ticket email for a paid order. Called from fulfill_order() in
 * the same transaction that mints the tickets.
 *
 * Returns the delivery id, or null when there is nothing to send to — an order
 * without a reachable address is not an error, it is simply an app-only ticket.
 */
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

  v_email := public.ticket_email_for(o.buyer_id);
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

/**
 * Re-sends an order's ticket email, optionally to a different address.
 *
 * The person who bought it may do this for their own order; so may an admin.
 * It resets the existing row rather than adding a second one, so the unique
 * index keeps meaning "one ticket email per order" however many times the
 * button is pressed.
 */
create or replace function public.resend_ticket_email(
  p_order_id uuid,
  p_email    text default null
)
returns public.email_deliveries
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o       public.orders;
  ev      public.events;
  v_email text;
  row     public.email_deliveries;
begin
  select * into o from public.orders where id = p_order_id;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if auth.uid() is not null and o.buyer_id <> auth.uid() and not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if o.payment_status <> 'succeeded' then
    raise exception 'ORDER_NOT_PAID';
  end if;

  v_email := coalesce(nullif(btrim(coalesce(p_email, '')), ''), public.ticket_email_for(o.buyer_id));
  if v_email is null or position('@' in v_email) < 2 then
    raise exception 'NO_EMAIL_ADDRESS';
  end if;

  select * into ev from public.events where id = o.event_id;

  insert into public.email_deliveries (kind, user_id, order_id, event_id, to_email, subject)
  values ('ticket', o.buyer_id, o.id, o.event_id, v_email,
          'Tvoja vstupenka · ' || coalesce(ev.title, 'Blup'))
  on conflict (kind, order_id) where order_id is not null do update
    set to_email        = excluded.to_email,
        subject         = excluded.subject,
        status          = 'pending',
        attempts        = 0,
        last_error      = null,
        next_attempt_at = now(),
        sent_at         = null
  returning * into row;

  return row;
end;
$$;

-- ---------------------------------------------------------------------------
-- The worker's view of the queue
-- ---------------------------------------------------------------------------

/**
 * Claims up to `p_limit` deliveries that are due, marking them 'sending' so a
 * second worker running at the same time cannot pick up the same row.
 *
 * `for update skip locked` is what makes that true under concurrency — without
 * it two workers both read the row, both send, and somebody gets their ticket
 * twice.
 */
create or replace function public.claim_email_deliveries(p_limit integer default 20)
returns setof public.email_deliveries
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  with due as (
    select id
    from public.email_deliveries
    where status in ('pending', 'failed')
      and next_attempt_at <= now()
      and attempts < 5
    order by next_attempt_at
    limit greatest(coalesce(p_limit, 20), 1)
    for update skip locked
  )
  update public.email_deliveries d
     set status = 'sending', attempts = d.attempts + 1
    from due
   where d.id = due.id
  returning d.*;
end;
$$;

/**
 * Everything the renderer needs for one ticket email, in one round trip.
 *
 * The QR secret is in here, which is the whole point — the attachment *is* the
 * ticket. That is also why this is service-role only: it is revoked from
 * `authenticated` below, so no client can ask for somebody else's codes.
 */
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
    'buyer_name',      coalesce(buyer.display_name, buyer.username, 'Host'),
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

/** Records a successful send. */
create or replace function public.mark_email_sent(
  p_id         uuid,
  p_provider   text,
  p_message_id text
)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.email_deliveries
     set status = 'sent', sent_at = now(), provider = p_provider,
         provider_message_id = p_message_id, last_error = null
   where id = p_id;
$$;

/**
 * Records a failure and schedules the retry. The backoff doubles each attempt
 * (2, 4, 8, 16 minutes) and the fifth failure is the last — `claim_email_deliveries`
 * stops picking the row up, so a permanently bad address stops burning quota
 * instead of retrying forever.
 *
 * `skipped` is its own state: no mail provider is configured, which is not a
 * failure to retry but a deployment that has not wired email up yet.
 */
create or replace function public.mark_email_failed(
  p_id      uuid,
  p_error   text,
  p_skipped boolean default false
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_attempts integer;
begin
  if p_skipped then
    update public.email_deliveries
       set status = 'skipped', last_error = p_error
     where id = p_id;
    return;
  end if;

  select attempts into v_attempts from public.email_deliveries where id = p_id;

  update public.email_deliveries
     set status = 'failed',
         last_error = left(coalesce(p_error, 'unknown'), 500),
         next_attempt_at = now() + make_interval(mins => power(2, least(coalesce(v_attempts, 1), 4))::integer)
   where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fulfilment enqueues the email
-- ---------------------------------------------------------------------------
-- Same body as 0021, with one line added at the end. The email is queued in the
-- transaction that mints the tickets: if the order rolls back, so does the
-- promise to email it.
create or replace function public.fulfill_order(
  p_order_id           uuid,
  p_provider           payment_provider,
  p_provider_reference text,
  p_amount_cents       integer
)
returns setof public.tickets
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  o      public.orders;
  i      integer;
  settle integer;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if o.payment_status = 'succeeded' then
    return query select * from public.tickets t where t.order_id = o.id;
    return;
  end if;

  if p_amount_cents is not null and p_amount_cents <> o.total_cents then
    raise exception 'AMOUNT_MISMATCH: expected % got %', o.total_cents, p_amount_cents;
  end if;

  update public.orders
  set payment_status = 'succeeded',
      provider = p_provider,
      provider_reference = coalesce(p_provider_reference, provider_reference),
      paid_at = now()
  where id = o.id;

  insert into public.payments (order_id, user_id, provider, provider_reference, amount_cents, currency, status)
  values (o.id, o.buyer_id, p_provider, p_provider_reference, o.total_cents, o.currency, 'succeeded')
  on conflict (provider, provider_reference) do nothing;

  for i in 1..o.quantity loop
    insert into public.tickets (
      order_id, event_id, ticket_type_id, buyer_id, code, qr_secret,
      price_cents, currency
    )
    values (
      o.id, o.event_id, o.ticket_type_id, o.buyer_id,
      'BLP-' || public.blup_short_code(10),
      encode(gen_random_bytes(24), 'hex'),
      o.unit_price_cents, o.currency
    );
  end loop;

  if o.organization_id is not null then
    settle := (public.resolve_fees(o.organization_id)->>'settlement_days')::integer;

    insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
    values (o.organization_id, o.event_id, o.id, 'sale', o.net_cents, o.currency,
            'Ticket sale x' || o.quantity, now() + make_interval(days => settle));

    if o.commission_cents > 0 then
      insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'platform_fee', -o.commission_cents, o.currency,
              'BLUP commission', now() + make_interval(days => settle));
    end if;

    if o.archive_fee_payer = 'organizer' and o.archive_fee_cents > 0 then
      insert into public.ledger_entries (organization_id, event_id, order_id, type, amount_cents, currency, description, available_at)
      values (o.organization_id, o.event_id, o.id, 'platform_fee', -o.archive_fee_cents, o.currency,
              'BLUP archive fee x' || o.quantity, now() + make_interval(days => settle));
    end if;
  end if;

  insert into public.event_attendees (event_id, user_id, status)
  values (o.event_id, o.buyer_id, 'going')
  on conflict (event_id, user_id) do update set status = 'going';

  insert into public.notifications (user_id, type, title, body, event_id, data)
  values (
    o.buyer_id, 'ticket_confirmed', 'Ticket confirmed',
    'Your ticket is ready. Show the QR code at the door.',
    o.event_id, jsonb_build_object('order_id', o.id)
  );

  -- The second copy of the ticket. Queued, not sent: delivery happens outside
  -- the transaction, because a mail provider being slow must never hold up (or
  -- roll back) a payment that already went through.
  perform public.queue_ticket_email(o.id);

  return query select * from public.tickets t where t.order_id = o.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- ticket_email_payload hands out QR secrets, and claim/mark drive the queue.
-- All four are service-role only.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function public.ticket_email_payload(uuid) from authenticated';
    execute 'revoke execute on function public.claim_email_deliveries(integer) from authenticated';
    execute 'revoke execute on function public.mark_email_sent(uuid, text, text) from authenticated';
    execute 'revoke execute on function public.mark_email_failed(uuid, text, boolean) from authenticated';
    execute 'revoke execute on function public.queue_ticket_email(uuid) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.ticket_email_payload(uuid) from anon';
    execute 'revoke execute on function public.claim_email_deliveries(integer) from anon';
    execute 'revoke execute on function public.mark_email_sent(uuid, text, text) from anon';
    execute 'revoke execute on function public.mark_email_failed(uuid, text, boolean) from anon';
    execute 'revoke execute on function public.queue_ticket_email(uuid) from anon';
  end if;
end
$$;
