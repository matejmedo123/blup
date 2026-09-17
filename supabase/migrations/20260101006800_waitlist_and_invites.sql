-- ============================================================================
-- Nával ľudí: dôvody prísť, a dôvod priviesť niekoho so sebou
--
-- The mailing machinery in 0066 can send a lot of e-mail. This is what there is
-- to send, and why anybody would open it — two mechanisms, both of which start
-- from something the person actually wants rather than from a list we bought.
--
-- The waitlist is the honest one. A sold-out event is the single strongest
-- reason somebody will give you their address: they are not subscribing to
-- anything, they want that ticket. When one comes back — a refund, a cancelled
-- order, sales opening — the people waiting hear first, in the order they
-- asked, and never more of them than there are tickets. A "it's available!"
-- mail sent to four hundred people for six tickets teaches three hundred and
-- ninety-four of them not to open the next one.
--
-- Invites are the other. The rule that makes them worth having rather than a
-- bot farm's payroll: nothing is paid out for a signup. An invite counts when
-- the invited person has confirmed their address AND has actually done
-- something — a ticket, or turning up. Ten a month, per inviter, and never for
-- an address the inviter controls.
-- ============================================================================
set search_path = public, extensions;

insert into public.xp_rules (kind, amount, daily_cap, description) values
  ('friend_invited', 150, 5, 'Priviedol si kamaráta')
on conflict (kind) do update
  set amount = excluded.amount,
      daily_cap = excluded.daily_cap,
      description = excluded.description;

-- ---------------------------------------------------------------------------
-- The waitlist
-- ---------------------------------------------------------------------------
create table if not exists public.ticket_waitlist (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events (id) on delete cascade,
  ticket_type_id uuid not null references public.ticket_types (id) on delete cascade,
  -- One or the other. A guest can buy a ticket here, so a guest can wait for
  -- one; asking them to make an account first is asking them to go away.
  user_id        uuid references public.profiles (id) on delete cascade,
  email          citext,
  wanted         integer not null default 1 check (wanted between 1 and 10),
  created_at     timestamptz not null default now(),
  -- When we told them. Nulled again if they are still waiting after the window,
  -- so a person who misses one release is not silently dropped from the queue.
  notified_at    timestamptz,

  constraint ticket_waitlist_who check (user_id is not null or email is not null),
  constraint ticket_waitlist_email_shape
    check (email is null or position('@' in email::text) > 1)
);

-- One place in the queue per person per ticket type, whichever way they are
-- identified. Two partial indexes rather than one on a coalesce, so both are
-- usable as lookups as well as rules.
create unique index if not exists ticket_waitlist_user_once
  on public.ticket_waitlist (ticket_type_id, user_id) where user_id is not null;
create unique index if not exists ticket_waitlist_email_once
  on public.ticket_waitlist (ticket_type_id, email) where user_id is null and email is not null;

create index if not exists ticket_waitlist_queue_idx
  on public.ticket_waitlist (ticket_type_id, created_at);
create index if not exists ticket_waitlist_event_idx
  on public.ticket_waitlist (event_id);

alter table public.ticket_waitlist enable row level security;

-- Your own place, and nobody else's. The queue is not public: "you are 340th"
-- is discouraging and "here are the 340 people ahead of you" is a mailing list
-- somebody else built for free.
drop policy if exists ticket_waitlist_mine on public.ticket_waitlist;
create policy ticket_waitlist_mine on public.ticket_waitlist
  for select using (user_id = auth.uid() and auth.uid() is not null);

drop policy if exists ticket_waitlist_no_write on public.ticket_waitlist;
create policy ticket_waitlist_no_write on public.ticket_waitlist
  for insert with check (false);

/**
 * "Daj mi vedieť, keď sa uvoľní."
 *
 * Works signed in or not. A guest gives an address and nothing else; it becomes
 * a contact row, so the mail they asked for can carry an unsubscribe link like
 * everything else does.
 */
create or replace function public.join_waitlist(
  p_ticket_type_id uuid,
  p_wanted         integer default 1,
  p_email          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  me     uuid := auth.uid();
  addr   citext := nullif(lower(btrim(coalesce(p_email, ''))), '')::citext;
  tt     public.ticket_types;
  ev     public.events;
  recent integer;
  row_id uuid;
begin
  select * into tt from public.ticket_types where id = p_ticket_type_id;
  if not found then
    raise exception 'TICKET_TYPE_NOT_FOUND';
  end if;

  select * into ev from public.events where id = tt.event_id;
  if ev.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;
  if ev.start_at < now() then
    raise exception 'EVENT_ALREADY_OVER';
  end if;

  if me is null then
    if addr is null then
      raise exception 'INVALID_EMAIL';
    end if;

    -- An address nobody is signed in as is an address anybody can type. Six an
    -- hour from one address is plenty for a person and useless for a script
    -- trying to find out which addresses exist.
    select count(*) into recent
    from public.ticket_waitlist w
    where w.email = addr and w.created_at > now() - interval '1 hour';

    if recent >= 6 then
      raise exception 'RATE_LIMITED';
    end if;
  else
    addr := coalesce(addr, public.current_user_email());
  end if;

  if addr is not null then
    perform public.ensure_email_contact(addr::text, me);
  end if;

  -- Two indexes guard this — one for accounts, one for bare addresses — and
  -- ON CONFLICT can only name one of them, so which one depends on who is
  -- asking rather than on trying both and hoping.
  if me is not null then
    -- They waited as a guest and have since signed in. One person, one place in
    -- the queue, or they get told twice about the same six tickets.
    if addr is not null then
      delete from public.ticket_waitlist
      where ticket_type_id = tt.id and user_id is null and email = addr;
    end if;

    insert into public.ticket_waitlist (event_id, ticket_type_id, user_id, email, wanted)
    values (ev.id, tt.id, me, addr, greatest(least(coalesce(p_wanted, 1), 10), 1))
    on conflict (ticket_type_id, user_id) where user_id is not null
    do update set wanted = excluded.wanted, notified_at = null
    returning id into row_id;
  else
    insert into public.ticket_waitlist (event_id, ticket_type_id, user_id, email, wanted)
    values (ev.id, tt.id, null, addr, greatest(least(coalesce(p_wanted, 1), 10), 1))
    on conflict (ticket_type_id, email) where user_id is null and email is not null
    do update set wanted = excluded.wanted, notified_at = null
    returning id into row_id;
  end if;

  return jsonb_build_object(
    'id', row_id,
    'ticket_type', tt.name,
    'event_id', ev.id,
    'waiting', (select count(*) from public.ticket_waitlist w where w.ticket_type_id = tt.id)
  );
end;
$$;

grant execute on function public.join_waitlist(uuid, integer, text) to anon, authenticated;

create or replace function public.leave_waitlist(p_ticket_type_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  delete from public.ticket_waitlist
  where ticket_type_id = p_ticket_type_id and user_id = auth.uid();
end;
$$;

revoke execute on function public.leave_waitlist(uuid) from public, anon;
grant execute on function public.leave_waitlist(uuid) to authenticated;

/**
 * How many people are waiting for this ticket type.
 *
 * Public, and deliberately just a count: it is the number that makes somebody
 * join ("forty people want this") without being a queue anybody can read.
 */
create or replace function public.waitlist_size(p_ticket_type_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $$
  select count(*)::integer from public.ticket_waitlist where ticket_type_id = p_ticket_type_id;
$$;

grant execute on function public.waitlist_size(uuid) to anon, authenticated;

/** What the signed-in person is waiting for, across every event. */
create or replace function public.my_waitlist()
returns table (
  ticket_type_id uuid,
  ticket_type    text,
  event_id       uuid,
  event_title    text,
  start_at       timestamptz,
  wanted         integer,
  waiting        integer,
  available      integer,
  notified_at    timestamptz,
  joined_at      timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    w.ticket_type_id,
    tt.name,
    e.id,
    e.title,
    e.start_at,
    w.wanted,
    (select count(*)::integer from public.ticket_waitlist x where x.ticket_type_id = w.ticket_type_id),
    coalesce((select a.available from public.ticket_type_availability(w.ticket_type_id) a), 0),
    w.notified_at,
    w.created_at
  from public.ticket_waitlist w
  join public.ticket_types tt on tt.id = w.ticket_type_id
  join public.events e on e.id = w.event_id
  where w.user_id = auth.uid() and auth.uid() is not null
  order by e.start_at;
$$;

grant execute on function public.my_waitlist() to authenticated;

/**
 * Telling the people who are waiting, when there is actually something to tell.
 *
 * Run by cron. For every ticket type with somebody waiting and stock free, it
 * mails the head of the queue — and never more people than there are tickets,
 * because the point of the mail is that it is true. Somebody who was told and
 * did not buy goes back into the queue after the window, at the back, so one
 * missed mail is not a permanent removal and one fast person cannot be told
 * again and again.
 *
 * Nothing is reserved. It is first come, first served among the people told,
 * and the mail says so — promising a hold we do not enforce would be worse than
 * saying nothing.
 */
create or replace function public.notify_waitlists(p_max_emails integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  budget  integer := greatest(coalesce(p_max_emails, 500), 1);
  queued  integer := 0;
  tt      record;
  person  record;
  free    integer;
  told    integer;
begin
  -- A window of six hours: long enough that somebody at work still has a
  -- chance, short enough that a seat is not held out of the queue for a day.
  update public.ticket_waitlist
  set notified_at = null
  where notified_at is not null and notified_at < now() - interval '6 hours';

  for tt in
    select w.ticket_type_id, w.event_id,
           t.name as ticket_name, e.title as event_title, e.start_at,
           coalesce((select a.available from public.ticket_type_availability(w.ticket_type_id) a), 0) as available,
           -- People already told about this ticket type and still inside their
           -- window. They are holding no stock — nothing here reserves anything
           -- — but they were told, and telling the next person while the first
           -- is still on their way is how one ticket gets promised twice.
           (select count(*) from public.ticket_waitlist x
            where x.ticket_type_id = w.ticket_type_id and x.notified_at is not null) as outstanding
    from public.ticket_waitlist w
    join public.ticket_types t on t.id = w.ticket_type_id
    join public.events e on e.id = w.event_id
    where w.notified_at is null
      and e.status = 'published'
      and e.start_at > now()
      and t.is_active
      and (t.sales_start_at is null or t.sales_start_at <= now())
      and (t.sales_end_at is null or t.sales_end_at > now())
    group by w.ticket_type_id, w.event_id, t.name, e.title, e.start_at
  loop
    free := tt.available - tt.outstanding;
    told := 0;
    exit when queued >= budget;
    continue when free <= 0;

    for person in
      select w.id, w.user_id, w.wanted,
             coalesce(w.email::text, public.ticket_email_for(w.user_id)) as email
      from public.ticket_waitlist w
      where w.ticket_type_id = tt.ticket_type_id and w.notified_at is null
      order by w.created_at
    loop
      exit when told >= free or queued >= budget;
      continue when person.email is null;
      continue when not public.can_email(person.email, 'waitlist_open');

      insert into public.email_deliveries
        (kind, user_id, event_id, to_email, subject, unsubscribe_token, payload)
      select
        'waitlist_open',
        person.user_id,
        tt.event_id,
        person.email,
        'Uvoľnilo sa: ' || tt.event_title,
        c.unsubscribe_token,
        jsonb_build_object(
          'event_id', tt.event_id,
          'event_title', tt.event_title,
          'start_at', tt.start_at,
          'ticket_type', tt.ticket_name,
          'available', free,
          'wanted', person.wanted
        )
      from public.ensure_email_contact(person.email, person.user_id) c;

      -- The in-app copy, for the people who have the app open right now and
      -- would otherwise find out by e-mail an hour later.
      if person.user_id is not null then
        perform public.notify_user(
          person.user_id, 'waitlist_open',
          'Uvoľnili sa vstupenky',
          tt.event_title || ' — ' || tt.ticket_name || ' je zase v predaji.',
          null, tt.event_id,
          jsonb_build_object('ticket_type_id', tt.ticket_type_id)
        );
      end if;

      update public.ticket_waitlist set notified_at = now() where id = person.id;

      told   := told + 1;
      queued := queued + 1;
    end loop;
  end loop;

  return jsonb_build_object('queued', queued);
end;
$$;

revoke all on function public.notify_waitlists(integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Invites
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists invite_code text;

create unique index if not exists profiles_invite_code_key
  on public.profiles (invite_code) where invite_code is not null;

/**
 * Everybody's code, made on demand rather than for every account at signup.
 *
 * A code that is never used is a row of noise and a name in a namespace, so it
 * is generated the first time somebody actually opens the invite screen.
 */
create or replace function public.my_invite_code()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me   uuid := auth.uid();
  code text;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select invite_code into code from public.profiles where id = me;
  if code is not null then
    return code;
  end if;

  -- Eight characters from the same alphabet as ticket codes, which already
  -- leaves out the letters people mistype when reading one out loud.
  for i in 1..10 loop
    begin
      code := public.blup_short_code(8);
      update public.profiles set invite_code = code where id = me;
      return code;
    exception when unique_violation then
      code := null;
    end;
  end loop;

  raise exception 'COULD_NOT_ALLOCATE_CODE';
end;
$$;

revoke execute on function public.my_invite_code() from public, anon;
grant execute on function public.my_invite_code() to authenticated;

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  inviter_id  uuid not null references public.profiles (id) on delete cascade,
  -- One row per invited person, ever. Somebody cannot be "invited" twice, by
  -- the same person or by two different ones.
  invitee_id  uuid not null unique references public.profiles (id) on delete cascade,
  code        text not null,
  created_at  timestamptz not null default now(),
  -- When the invited person did something real. Until then this is worth
  -- nothing to anybody, which is the entire anti-abuse design.
  qualified_at timestamptz,
  rewarded_at  timestamptz,

  constraint invites_no_self check (inviter_id <> invitee_id)
);

create index if not exists invites_inviter_idx on public.invites (inviter_id, created_at desc);
create index if not exists invites_pending_idx on public.invites (qualified_at)
  where rewarded_at is null;

alter table public.invites enable row level security;

drop policy if exists invites_mine on public.invites;
create policy invites_mine on public.invites
  for select using (
    (inviter_id = auth.uid() or invitee_id = auth.uid()) and auth.uid() is not null
  );

drop policy if exists invites_no_write on public.invites;
create policy invites_no_write on public.invites for insert with check (false);

/**
 * "Prišiel som cez kód od kamaráta."
 *
 * Called by the new account, once, in its first fortnight. Refuses the four
 * ways this is cheated: your own code, a code you already used, an account that
 * has been around long enough that it is not really a referral, and an address
 * that belongs to the inviter.
 */
create or replace function public.claim_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  me       uuid := auth.uid();
  code     text := upper(btrim(coalesce(p_code, '')));
  inviter  uuid;
  joined   timestamptz;
  my_mail  citext;
  their_mail citext;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;
  if code = '' then
    raise exception 'INVITE_CODE_INVALID';
  end if;

  select id into inviter from public.profiles where upper(invite_code) = code;
  if inviter is null then
    raise exception 'INVITE_CODE_INVALID';
  end if;
  if inviter = me then
    raise exception 'INVITE_SELF';
  end if;

  select created_at into joined from public.profiles where id = me;
  if joined < now() - interval '14 days' then
    raise exception 'INVITE_TOO_LATE'
      using hint = 'Kód sa dá uplatniť do 14 dní od registrácie.';
  end if;

  if exists (select 1 from public.invites where invitee_id = me) then
    raise exception 'INVITE_ALREADY_USED';
  end if;

  -- The same person twice. Not airtight — nothing about e-mail is — but it
  -- stops the laziest version, which is the one that actually happens.
  select lower(u.email)::citext into my_mail from auth.users u where u.id = me;
  select lower(u.email)::citext into their_mail from auth.users u where u.id = inviter;
  if my_mail is not null and my_mail = their_mail then
    raise exception 'INVITE_SELF';
  end if;

  insert into public.invites (inviter_id, invitee_id, code)
  values (inviter, me, code);

  return jsonb_build_object(
    'inviter', (select display_name from public.profiles where id = inviter),
    'qualified', false
  );
end;
$$;

revoke execute on function public.claim_invite(text) from public, anon;
grant execute on function public.claim_invite(text) to authenticated;

/**
 * Paying out the invites that turned into somebody real.
 *
 * Run by cron. An invite qualifies when the invited person has confirmed their
 * address and has either bought a ticket or turned up at something — not when
 * they signed up. That single rule is the difference between a referral scheme
 * and a bounty on making accounts.
 *
 * Ten rewards per inviter per thirty days. Somebody genuinely bringing their
 * whole crew hits that and can bring the rest next month; a script hits it on
 * the first morning and stops being worth running.
 */
create or replace function public.qualify_invites(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  inv     record;
  rewarded integer := 0;
  recent  integer;
begin
  for inv in
    select i.*
    from public.invites i
    join auth.users u on u.id = i.invitee_id
    where i.rewarded_at is null
      and u.email_confirmed_at is not null
      and (
        exists (
          select 1 from public.tickets t
          where t.buyer_id = i.invitee_id and t.status in ('valid', 'used')
        )
        or exists (
          select 1 from public.event_attendees a
          join public.events e on e.id = a.event_id
          where a.user_id = i.invitee_id
            and a.status = 'checked_in'
            and e.start_at < now()
        )
      )
    order by i.created_at
    limit greatest(coalesce(p_limit, 200), 1)
  loop
    select count(*) into recent
    from public.invites x
    where x.inviter_id = inv.inviter_id
      and x.rewarded_at > now() - interval '30 days';

    if recent >= 10 then
      continue;
    end if;

    update public.invites
    set qualified_at = coalesce(qualified_at, now()), rewarded_at = now()
    where id = inv.id;

    -- Both sides. The person who came deserves the welcome as much as the
    -- person who brought them deserves the thanks.
    perform public.award_xp(inv.inviter_id, 'friend_invited', 'invite', inv.id);
    perform public.award_xp(inv.invitee_id, 'friend_invited', 'invite', inv.id);

    perform public.notify_user(
      inv.inviter_id, 'invite_arrived',
      'Tvoja pozvánka zabrala',
      coalesce((select display_name from public.profiles where id = inv.invitee_id), 'Niekto')
        || ' prišiel cez teba a už bol na evente. Máš za to body.',
      inv.invitee_id, null, jsonb_build_object('invite_id', inv.id)
    );

    rewarded := rewarded + 1;
  end loop;

  return jsonb_build_object('rewarded', rewarded);
end;
$$;

revoke all on function public.qualify_invites(integer) from public, anon, authenticated;

/** The invite screen: the code, and what it has actually done. */
create or replace function public.my_invites()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  return jsonb_build_object(
    'code', (select invite_code from public.profiles where id = me),
    'invited', (select count(*) from public.invites where inviter_id = me),
    'arrived', (select count(*) from public.invites where inviter_id = me and rewarded_at is not null),
    'xp_each', (select amount from public.xp_rules where kind = 'friend_invited'),
    -- Who they were, for the people who want to see it. Only ever names, never
    -- addresses: the inviter did not earn a copy of their friend's contact card.
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', p.display_name,
        'username', p.username,
        'avatar_url', p.avatar_url,
        'arrived', i.rewarded_at is not null,
        'joined_at', i.created_at
      ) order by i.created_at desc)
      from public.invites i
      join public.profiles p on p.id = i.invitee_id
      where i.inviter_id = me
    ), '[]'::jsonb),
    'came_from', (
      select p.display_name from public.invites i
      join public.profiles p on p.id = i.inviter_id
      where i.invitee_id = me
    )
  );
end;
$$;

revoke execute on function public.my_invites() from public, anon;
grant execute on function public.my_invites() to authenticated;
