-- ============================================================================
-- Veľa e-mailov — bez toho, aby nás zablokovali
--
-- BLUP could send exactly two e-mails: a ticket and a refund. Everything else
-- it had to say went into an in-app notification, which reaches the people who
-- already open the app — that is, not the ones you are trying to bring back.
--
-- So this is the machinery for sending a lot of mail on purpose. The hard part
-- is not sending; it is sending without becoming the thing spam filters are
-- for. Four rules are built in rather than left to whoever writes the campaign:
--
--   1. Consent is per ADDRESS, not per account. A guest who bought one ticket
--      never made an account and never saw a preferences screen, so they are
--      not on a mailing list — but they are still the organizer's customer for
--      that event, and that relationship is what makes an announcement about it
--      lawful. Those are two different questions and the code asks both.
--   2. Every marketing mail carries a one-click unsubscribe that works without
--      signing in. A link that demands a login is not an unsubscribe link, and
--      in the EU it is also not legal.
--   3. A bounce or a complaint is final. The address is put down and nothing
--      tries it again — one hard bounce retried a thousand times is how a
--      sending domain dies.
--   4. There is an hourly ceiling, and tickets always go first. A blast must
--      never be the reason somebody's ticket arrives after the doors open.
-- ============================================================================

-- citext lives in the `extensions` schema, and a migration's top-level DDL does
-- not inherit the search_path a function body sets.
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Consent, per address
-- ---------------------------------------------------------------------------
create table if not exists public.email_contacts (
  email               citext primary key check (position('@' in email::text) > 1),
  -- Null for a guest: an address that has bought a ticket and nothing more.
  user_id             uuid references public.profiles (id) on delete set null,
  -- The unsubscribe link. Long and random because it is a bearer token that
  -- arrives in an e-mail and is clicked from a mail client with no session.
  unsubscribe_token   text not null default encode(gen_random_bytes(24), 'hex'),
  -- Wants the platform's own mail (the weekly digest). An account has agreed to
  -- the terms and can switch this off in settings; a guest address has agreed
  -- to nothing, so it starts at false and only a person can turn it on.
  digest_opt_in       boolean not null default false,
  -- Said no. Nothing marketing goes out after this, from anybody.
  unsubscribed_at     timestamptz,
  -- The mail server said this address does not exist. Final.
  bounced_at          timestamptz,
  -- Marked us as spam. More final than a bounce: retrying is what gets a
  -- domain blacklisted, so this stops transactional mail too.
  complained_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists email_contacts_token_key
  on public.email_contacts (unsubscribe_token);
create index if not exists email_contacts_user_idx
  on public.email_contacts (user_id) where user_id is not null;

drop trigger if exists email_contacts_set_updated_at on public.email_contacts;
create trigger email_contacts_set_updated_at
  before update on public.email_contacts
  for each row execute function public.set_updated_at();

alter table public.email_contacts enable row level security;

-- Nobody reads this table from a browser. It is a list of every address BLUP
-- has ever mailed, which is exactly the thing not to leak; the app reaches its
-- own row through my_email_preferences() and nothing else.
drop policy if exists email_contacts_none on public.email_contacts;
create policy email_contacts_none on public.email_contacts for select using (false);

/**
 * The contact row for an address, made if it is not there yet.
 *
 * An account's address starts opted in to the digest and a guest's does not —
 * see the note on the column. Called from everywhere that is about to mail
 * somebody, so the list builds itself rather than needing to be maintained.
 */
create or replace function public.ensure_email_contact(
  p_email   text,
  p_user_id uuid default null
)
returns public.email_contacts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  addr citext := nullif(lower(btrim(coalesce(p_email, ''))), '')::citext;
  out  public.email_contacts;
begin
  if addr is null or position('@' in addr::text) < 2 then
    raise exception 'INVALID_EMAIL';
  end if;

  insert into public.email_contacts (email, user_id, digest_opt_in)
  values (addr, p_user_id, p_user_id is not null)
  on conflict (email) do update
    -- An address that was a guest and now has an account keeps its history and
    -- gains the account. It does not gain consent: the person still has to say
    -- yes, they just now have a screen to say it on.
    set user_id = coalesce(public.email_contacts.user_id, excluded.user_id)
  returning * into out;

  return out;
end;
$$;

revoke all on function public.ensure_email_contact(text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- What may be sent to whom
-- ---------------------------------------------------------------------------
/**
 * May we send this kind of mail to this address?
 *
 * Three tiers, and the difference matters both legally and practically:
 *
 *   transactional  a ticket, a refund, the seat that just came free on the
 *                  waitlist they joined. The person asked for exactly this.
 *                  Sent unless the address is dead or has complained.
 *   invited        one person invited another. Not a mailing list, but still
 *                  unsolicited to the recipient, so an unsubscribe stops it.
 *   marketing      an organizer's announcement, the weekly digest. Needs a
 *                  reason: the digest needs an opt-in, an announcement needs
 *                  the recipient to actually be that organizer's customer —
 *                  which queue_campaign() establishes by how it picks the
 *                  audience, not by a flag anybody can set.
 */
create or replace function public.can_email(p_email text, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case
    -- Never. A complaint is the recipient telling a spam filter about us.
    when c.complained_at is not null then false
    when c.bounced_at is not null then false
    when p_kind in ('ticket', 'order_refunded', 'waitlist_open') then true
    when c.unsubscribed_at is not null then false
    when p_kind = 'digest' then coalesce(c.digest_opt_in, false)
    else true
  end
  from (select 1) one
  left join public.email_contacts c
    on c.email = nullif(lower(btrim(coalesce(p_email, ''))), '')::citext;
$$;

grant execute on function public.can_email(text, text) to authenticated;

/**
 * Stopping the mail, from a link in the mail.
 *
 * Granted to `anon` on purpose: the person clicking is in a mail client, not in
 * BLUP, and may never have had an account. The token is the whole authority,
 * which is why it is 24 random bytes and why this does nothing except set a
 * flag — it cannot read the address, list anything or change a password.
 *
 * Returns false for a token that means nothing, rather than saying which,
 * because an endpoint that distinguishes them is an address checker.
 */
create or replace function public.email_unsubscribe(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  hit integer;
begin
  if p_token is null or char_length(btrim(p_token)) < 20 then
    return false;
  end if;

  update public.email_contacts
  set unsubscribed_at = coalesce(unsubscribed_at, now()),
      digest_opt_in = false
  where unsubscribe_token = btrim(p_token);

  get diagnostics hit = row_count;
  return hit > 0;
end;
$$;

grant execute on function public.email_unsubscribe(text) to anon, authenticated;

/** Their own row, and only ever their own. */
create or replace function public.my_email_preferences()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'email', c.email,
    'digest_opt_in', c.digest_opt_in,
    'unsubscribed', c.unsubscribed_at is not null,
    'undeliverable', c.bounced_at is not null or c.complained_at is not null
  )
  from public.email_contacts c
  where c.user_id = auth.uid() and auth.uid() is not null
  limit 1;
$$;

grant execute on function public.my_email_preferences() to authenticated;

create or replace function public.set_email_preferences(p_digest boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  perform public.ensure_email_contact(public.current_user_email(), me);

  update public.email_contacts
  set digest_opt_in = coalesce(p_digest, digest_opt_in),
      -- Turning the digest back on is also taking back a blanket "no". Leaving
      -- the unsubscribe in place would make the switch lie.
      unsubscribed_at = case when p_digest then null else unsubscribed_at end
  where user_id = me;

  return public.my_email_preferences();
end;
$$;

revoke execute on function public.set_email_preferences(boolean) from public, anon;
grant execute on function public.set_email_preferences(boolean) to authenticated;

-- An address that signs up gets its contact row straight away, so the first
-- thing that wants to mail them does not have to make one.
create or replace function public.contact_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.email is not null and position('@' in new.email) > 1 then
    perform public.ensure_email_contact(new.email, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_zzz_contact on auth.users;
create trigger on_auth_user_created_zzz_contact
  after insert on auth.users
  for each row execute function public.contact_for_new_user();

-- ---------------------------------------------------------------------------
-- The queue learns to carry more than tickets
-- ---------------------------------------------------------------------------
alter table public.email_deliveries drop constraint if exists email_deliveries_kind_check;
alter table public.email_deliveries add constraint email_deliveries_kind_check
  check (kind in ('ticket', 'order_refunded', 'waitlist_open', 'invite', 'announcement', 'digest'));

-- Everything a non-ticket mail needs to render. A ticket keeps fetching its own
-- through ticket_email_payload(), which hands out QR secrets and must stay
-- service-role only rather than being copied into a row.
alter table public.email_deliveries add column if not exists payload jsonb;
alter table public.email_deliveries add column if not exists campaign_id uuid;
alter table public.email_deliveries add column if not exists unsubscribe_token text;

-- When the worker took it. The hourly budget is counted from this rather than
-- from sent_at: a row that has been claimed is already in flight at the
-- provider, and counting only what has come back would let the next run of the
-- worker spend the same hour's budget over again.
alter table public.email_deliveries add column if not exists claimed_at timestamptz;

create index if not exists email_deliveries_spend_idx
  on public.email_deliveries (claimed_at) where claimed_at is not null;

create index if not exists email_deliveries_campaign_idx
  on public.email_deliveries (campaign_id) where campaign_id is not null;

-- ---------------------------------------------------------------------------
-- How fast we are allowed to send
-- ---------------------------------------------------------------------------
-- Every provider has a rate limit and every domain has a reputation. Both are
-- spent by the same queue, so the ceiling lives next to the other numbers an
-- admin can turn.
alter table public.platform_settings
  add column if not exists email_per_hour integer not null default 500;

alter table public.platform_settings drop constraint if exists platform_settings_email_rate;
alter table public.platform_settings add constraint platform_settings_email_rate
  check (email_per_hour between 1 and 100000);

/**
 * The next few mails to send.
 *
 * Two things this did not do before.
 *
 * It took whatever was oldest. A campaign of four thousand announcements would
 * therefore sit in front of a ticket somebody bought thirty seconds ago, and
 * the ticket would arrive after the doors opened. Tickets and refunds now jump
 * the queue — not by a priority column that has to be set correctly every time,
 * but by what kind of mail it is.
 *
 * And it had no ceiling. A blast went out as fast as the worker could loop,
 * which is how a sending domain gets rate-limited by the provider and then
 * quietly filed as spam by everybody else. What has gone out in the last hour
 * is counted first, and a run that would cross the line sends what is left of
 * the budget and stops.
 */
create or replace function public.claim_email_deliveries(p_limit integer default 20)
returns setof public.email_deliveries
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  budget integer;
  spent  integer;
  room   integer;
begin
  select coalesce(email_per_hour, 500) into budget from public.platform_settings limit 1;
  budget := coalesce(budget, 500);

  select count(*) into spent
  from public.email_deliveries
  where coalesce(sent_at, claimed_at) > now() - interval '1 hour';

  room := least(greatest(coalesce(p_limit, 20), 1), greatest(budget - spent, 0));

  if room = 0 then
    return;
  end if;

  return query
  with due as (
    select id
    from public.email_deliveries
    where status in ('pending', 'failed')
      and next_attempt_at <= now()
      and attempts < 5
    order by
      -- A ticket is somebody standing at a door. Everything else can wait.
      case when kind in ('ticket', 'order_refunded') then 0 else 1 end,
      next_attempt_at
    limit room
    for update skip locked
  )
  update public.email_deliveries d
     set status = 'sending', attempts = d.attempts + 1, claimed_at = now()
    from due
   where d.id = due.id
  returning d.*;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function public.claim_email_deliveries(integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.claim_email_deliveries(integer) from anon';
  end if;
end
$$;

/**
 * The address said no, or does not exist.
 *
 * Called by the sender when the provider reports a hard bounce or a complaint.
 * Everything still queued for that address is dropped in the same breath —
 * leaving four thousand rows pointed at a dead address to retry five times each
 * is twenty thousand attempts that all end the same way.
 */
create or replace function public.mark_email_undeliverable(
  p_email     text,
  p_complaint boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  addr    citext := nullif(lower(btrim(coalesce(p_email, ''))), '')::citext;
  dropped integer;
begin
  if addr is null then
    return 0;
  end if;

  perform public.ensure_email_contact(addr::text, null);

  update public.email_contacts
  set bounced_at    = case when p_complaint then bounced_at else coalesce(bounced_at, now()) end,
      complained_at = case when p_complaint then coalesce(complained_at, now()) else complained_at end,
      digest_opt_in = false
  where email = addr;

  update public.email_deliveries
  set status = 'skipped',
      last_error = case when p_complaint then 'COMPLAINT' else 'HARD_BOUNCE' end
  where to_email = addr::text
    and status in ('pending', 'failed');

  get diagnostics dropped = row_count;
  return dropped;
end;
$$;

revoke all on function public.mark_email_undeliverable(text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- An organizer writing to the people who came
-- ---------------------------------------------------------------------------
-- This is the biggest legitimate source of "veľa e-mailov" a ticketing site
-- has, and the easiest to get wrong. The audience is never "everybody": it is
-- always a group with a real relationship to this organizer, and which group it
-- is decides whether the mail is lawful. The three below are, in order of how
-- solid that relationship is:
--
--   ticket_holders  bought a ticket for this event. Writing to them about that
--                   event is not marketing at all, it is the service.
--   attendees       said they are going to this event. They asked to hear.
--   past_attendees  held a ticket for one of this organizer's past events.
--                   A customer of theirs, and the ePrivacy soft opt-in — which
--                   is why it still carries an unsubscribe, and why "everybody
--                   on BLUP" is not on this list and never will be.
create table if not exists public.email_campaigns (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_id        uuid references public.events (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null,
  audience        text not null check (audience in ('ticket_holders', 'attendees', 'past_attendees')),
  subject         text not null,
  body            text not null,
  status          text not null default 'draft'
                  check (status in ('draft', 'queued', 'sent', 'cancelled')),
  recipients      integer not null default 0,
  skipped         integer not null default 0,
  created_at      timestamptz not null default now(),
  queued_at       timestamptz,

  constraint email_campaigns_subject_len check (char_length(btrim(subject)) between 3 and 120),
  constraint email_campaigns_body_len    check (char_length(btrim(body)) between 20 and 4000),
  -- The two event audiences are meaningless without one.
  constraint email_campaigns_event_needed
    check (audience = 'past_attendees' or event_id is not null)
);

create index if not exists email_campaigns_org_idx
  on public.email_campaigns (organization_id, created_at desc);

-- One delivery per address per campaign, forever. Pressing "send" twice is the
-- most ordinary mistake there is and it must not double anybody's inbox.
create unique index if not exists email_deliveries_campaign_once
  on public.email_deliveries (campaign_id, to_email)
  where campaign_id is not null;

alter table public.email_campaigns enable row level security;

drop policy if exists email_campaigns_read on public.email_campaigns;
create policy email_campaigns_read on public.email_campaigns
  for select using (
    public.is_org_member(organization_id, null, auth.uid()) or public.is_admin()
  );

-- Written only through create_campaign()/queue_campaign(), which count the
-- audience and check the limits. A direct insert would skip both.
drop policy if exists email_campaigns_no_write on public.email_campaigns;
create policy email_campaigns_no_write on public.email_campaigns
  for insert with check (false);

/**
 * Who would get it — counted before anything is written.
 *
 * The same query the send uses, so the number an organizer is shown before they
 * commit is the number that actually goes out, not an estimate that turns out
 * to have been optimistic by a factor of four.
 */
create or replace function public.campaign_audience(
  p_organization_id uuid,
  p_audience        text,
  p_event_id        uuid default null
)
returns table (email text, user_id uuid, display_name text)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with people as (
    select coalesce(public.ticket_email_for(t.buyer_id), t.guest_email::text) as email,
           t.buyer_id as user_id
    from public.tickets t
    join public.events e on e.id = t.event_id
    where p_audience in ('ticket_holders', 'past_attendees')
      and t.status in ('valid', 'used')
      and e.organization_id = p_organization_id
      and (
        (p_audience = 'ticket_holders' and t.event_id = p_event_id)
        or (p_audience = 'past_attendees')
      )

    union

    select public.ticket_email_for(a.user_id), a.user_id
    from public.event_attendees a
    join public.events e on e.id = a.event_id
    where p_audience = 'attendees'
      and a.event_id = p_event_id
      and e.organization_id = p_organization_id
      and a.status in ('going', 'interested')
  )
  select distinct on (lower(btrim(p.email)))
         lower(btrim(p.email)),
         p.user_id,
         pr.display_name
  from people p
  left join public.profiles pr on pr.id = p.user_id
  where p.email is not null
    and position('@' in p.email) > 1
    and public.can_email(p.email, 'announcement')
  order by lower(btrim(p.email)), p.user_id nulls last;
$$;

revoke all on function public.campaign_audience(uuid, text, uuid) from public, anon;
grant execute on function public.campaign_audience(uuid, text, uuid) to authenticated;

/**
 * Writes the campaign and queues it, in one step and one transaction.
 *
 * Deliberately not a draft that somebody sends later: a half-written campaign
 * sitting in a table is a thing that gets sent by accident, and the preview an
 * organizer needs is campaign_audience(), which they can call as often as they
 * like without creating anything.
 */
create or replace function public.send_campaign(
  p_organization_id uuid,
  p_audience        text,
  p_subject         text,
  p_body            text,
  p_event_id        uuid default null
)
returns public.email_campaigns
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me       uuid := auth.uid();
  org      public.organizations;
  camp     public.email_campaigns;
  recent   integer;
  n        integer;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  if not (public.is_org_member(p_organization_id, null, me) or public.is_admin()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select * into org from public.organizations where id = p_organization_id;
  if not found then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;
  -- An unverified organization cannot sell; it certainly cannot mail a
  -- thousand people from our domain.
  if org.verification_status <> 'verified' then
    raise exception 'ORGANIZATION_NOT_VERIFIED';
  end if;

  if p_event_id is not null and not exists (
    select 1 from public.events e
    where e.id = p_event_id and e.organization_id = p_organization_id
  ) then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- Three a day. Not a technical limit — a limit on how often the same people
  -- can be written to before they stop reading any of it.
  select count(*) into recent
  from public.email_campaigns c
  where c.organization_id = p_organization_id
    and c.created_at > now() - interval '24 hours'
    and c.status <> 'cancelled';

  if recent >= 3 then
    raise exception 'TOO_MANY_CAMPAIGNS'
      using hint = 'Tri rozposlania za deň stačia. Skús zajtra.';
  end if;

  insert into public.email_campaigns
    (organization_id, event_id, created_by, audience, subject, body, status, queued_at)
  values
    (p_organization_id, p_event_id, me, p_audience, btrim(p_subject), btrim(p_body), 'queued', now())
  returning * into camp;

  insert into public.email_deliveries
    (kind, user_id, event_id, to_email, subject, campaign_id, unsubscribe_token, payload)
  select
    'announcement',
    a.user_id,
    p_event_id,
    a.email,
    camp.subject,
    camp.id,
    c.unsubscribe_token,
    jsonb_build_object(
      'organizer', org.name,
      'greeting_name', a.display_name,
      'body', camp.body,
      'event_id', p_event_id
    )
  from public.campaign_audience(p_organization_id, p_audience, p_event_id) a
  -- The contact row has to exist for the unsubscribe token to exist, and a
  -- ticket buyer's address may never have been mailed anything but their ticket.
  cross join lateral public.ensure_email_contact(a.email, a.user_id) c
  on conflict (campaign_id, to_email) where campaign_id is not null do nothing;

  get diagnostics n = row_count;

  update public.email_campaigns
  set recipients = n, status = 'queued'
  where id = camp.id
  returning * into camp;

  return camp;
end;
$$;

revoke execute on function public.send_campaign(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.send_campaign(uuid, text, text, text, uuid) to authenticated;

/** How a rozposlanie actually went: queued, delivered, bounced, unsubscribed. */
create or replace function public.campaign_report(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  camp public.email_campaigns;
begin
  select * into camp from public.email_campaigns where id = p_campaign_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;
  if not (public.is_org_member(camp.organization_id, null, auth.uid()) or public.is_admin()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', camp.id,
    'subject', camp.subject,
    'audience', camp.audience,
    'created_at', camp.created_at,
    'recipients', camp.recipients,
    'sent', (select count(*) from public.email_deliveries d
             where d.campaign_id = camp.id and d.status = 'sent'),
    'pending', (select count(*) from public.email_deliveries d
                where d.campaign_id = camp.id and d.status in ('pending', 'sending', 'failed')),
    'failed', (select count(*) from public.email_deliveries d
               where d.campaign_id = camp.id and d.status = 'failed' and d.attempts >= 5),
    'skipped', (select count(*) from public.email_deliveries d
                where d.campaign_id = camp.id and d.status = 'skipped'),
    -- People who read this one and then asked not to get the next. The only
    -- number in here that says anything about the writing.
    'unsubscribed', (select count(*) from public.email_deliveries d
                     join public.email_contacts c on c.email = d.to_email::citext
                     where d.campaign_id = camp.id
                       and c.unsubscribed_at is not null
                       and c.unsubscribed_at >= camp.created_at)
  );
end;
$$;

revoke execute on function public.campaign_report(uuid) from public, anon;
grant execute on function public.campaign_report(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What the queue is doing, for whoever is watching the surge
-- ---------------------------------------------------------------------------
create or replace function public.email_queue_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'budget_per_hour', (select coalesce(email_per_hour, 500) from public.platform_settings limit 1),
    'sent_last_hour', (select count(*) from public.email_deliveries
                       where coalesce(sent_at, claimed_at) > now() - interval '1 hour'),
    'sent_today', (select count(*) from public.email_deliveries where sent_at > now() - interval '24 hours'),
    'waiting', (select count(*) from public.email_deliveries where status in ('pending', 'failed') and attempts < 5),
    -- Rows that have given up. If this is climbing, something is wrong with the
    -- provider or the domain, not with any one address.
    'dead', (select count(*) from public.email_deliveries where status = 'failed' and attempts >= 5),
    'by_kind', coalesce((
      select jsonb_object_agg(k.kind, k.n)
      from (select kind, count(*) as n from public.email_deliveries
            where created_at > now() - interval '24 hours' group by kind) k
    ), '{}'::jsonb),
    'contacts', (select count(*) from public.email_contacts),
    'unsubscribed', (select count(*) from public.email_contacts where unsubscribed_at is not null),
    'undeliverable', (select count(*) from public.email_contacts
                      where bounced_at is not null or complained_at is not null)
  );
end;
$$;

revoke execute on function public.email_queue_stats() from public, anon;
grant execute on function public.email_queue_stats() to authenticated;
