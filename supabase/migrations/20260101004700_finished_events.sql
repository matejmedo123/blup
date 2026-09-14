-- ============================================================================
-- BLUP · 0047 · Finished events stop being live events
-- ============================================================================
-- Nothing ever moved an event out of `published`. A concert from March was, as
-- far as the database was concerned, still an upcoming event — it was only
-- missing from discovery because every discovery query filters on the date.
-- Everywhere else it behaved as if it were still ahead of us, which is how a
-- finished event ended up with a working "Boostnúť" button.
--
-- Deleting them, which is the obvious first instinct, is the one thing that
-- must not happen: tickets, ledger entries, the accounting export and the
-- payout tier all point at events, and an attendee's ticket has to stay
-- readable after the doors close. Finished events are marked, not removed.
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- One definition of "over"
-- ---------------------------------------------------------------------------
-- Scattered copies of `coalesce(end_at, start_at + interval '4 hours')` were
-- already drifting: the boost check used bare `start_at`, which is why a
-- three-day festival could not be promoted on its second day. One function, so
-- the rule can only be wrong in one place.
--
-- An event without an end time is treated as four hours long — long enough that
-- a gig is not marked finished while people are still inside, short enough that
-- yesterday's is.
create or replace function public.event_ends_at(
  p_start timestamptz,
  p_end   timestamptz
)
returns timestamptz
language sql
immutable
parallel safe
as $$ select coalesce(p_end, p_start + interval '4 hours'); $$;

create or replace function public.event_has_ended(
  p_start timestamptz,
  p_end   timestamptz
)
returns boolean
language sql
stable
parallel safe
as $$ select public.event_ends_at(p_start, p_end) < now(); $$;

-- ---------------------------------------------------------------------------
-- Marking them
-- ---------------------------------------------------------------------------
-- Only `published` → `completed`. A draft stays a draft and a cancelled event
-- stays cancelled; neither becomes "completed" by the passage of time.
create or replace function public.complete_past_events()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  moved integer;
begin
  update public.events
  set status = 'completed'
  where status = 'published'
    and public.event_has_ended(start_at, end_at);

  get diagnostics moved = row_count;
  return moved;
end;
$$;

revoke all on function public.complete_past_events() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- …without hiding them
-- ---------------------------------------------------------------------------
-- The read policy allowed the public only `published`. Marking last month's
-- event `completed` would therefore have made it a 404 for everyone who was
-- there — including the person holding a ticket to it, and anyone opening a
-- link that was shared at the time. A finished event is still a page.
drop policy if exists events_select on public.events;
create policy events_select on public.events
  for select using (
    creator_id = auth.uid()
    or public.is_admin()
    or (organization_id is not null and public.is_org_member(organization_id, null))
    or (
      status in ('published', 'completed')
      and (
        visibility in ('public', 'unlisted')
        or (visibility = 'followers' and public.is_following(creator_id, auth.uid()))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Boosting
-- ---------------------------------------------------------------------------
-- Two bugs in one line. `start_at < now()` let a finished event be promoted
-- right up until… no, it refused it — but only at the very end, after the
-- payment sheet had opened, and it *also* refused a multi-day festival on its
-- second day, which is a perfectly sensible thing to promote. The test is
-- whether the event is over, not whether it has begun.
create or replace function public.create_boost_order(
  p_event   uuid,
  p_package text
)
returns public.event_boosts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me      uuid := auth.uid();
  v_event   public.events%rowtype;
  v_package public.boost_packages%rowtype;
  v_start   timestamptz;
  v_ends    timestamptz;
  v_boost   public.event_boosts;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select * into v_package from public.boost_packages where code = p_package and is_active;
  if not found then
    raise exception 'BOOST_PACKAGE_NOT_FOUND';
  end if;

  select * into v_event from public.events where id = p_event;
  if not found then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- Only the host, or somebody who runs the hosting organization, may promote it.
  if v_event.creator_id <> v_me
     and not (v_event.organization_id is not null
              and public.is_org_member(v_event.organization_id,
                                       array['owner','admin']::org_role[]))
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  -- Checked before the status, so somebody promoting yesterday's event is told
  -- what is actually wrong rather than a generic "not available".
  if public.event_has_ended(v_event.start_at, v_event.end_at) then
    raise exception 'EVENT_ALREADY_ENDED';
  end if;

  if v_event.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- A live boost is not replaced; a queued one starts when the current ends.
  select greatest(now(), coalesce(max(ends_at), now())) into v_start
  from public.event_boosts
  where event_id = p_event and payment_status = 'succeeded' and ends_at > now();

  v_ends := v_start + make_interval(hours => v_package.hours);

  -- Promotion past the end of the event is money for nothing: discovery drops
  -- the event the moment it is over, boosted or not. Cut it short rather than
  -- sell time that cannot be delivered.
  v_ends := least(v_ends, public.event_ends_at(v_event.start_at, v_event.end_at));

  if v_ends <= v_start then
    raise exception 'EVENT_ALREADY_ENDED';
  end if;

  insert into public.event_boosts (
    event_id, organization_id, package_code, buyer_id,
    starts_at, ends_at, weight, amount_cents, currency,
    payment_status, provider, created_by
  )
  values (
    p_event, v_event.organization_id, v_package.code, v_me,
    v_start, v_ends,
    v_package.weight, v_package.price_cents, v_package.currency,
    'requires_payment', 'stripe', v_me
  )
  returning * into v_boost;

  return v_boost;
end;
$$;

grant execute on function public.create_boost_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- What a boost actually buys, before anyone pays for it
-- ---------------------------------------------------------------------------
-- A boost is worth nothing after the event is over — discovery drops the event
-- either way — so the order above cuts the boost short at the event's end. Left
-- there, that would be selling twenty-four hours and delivering three. This is
-- the same arithmetic, callable before the payment sheet opens, so the screen
-- can say "pobeží 3 z 24 hodín" while the organizer can still change their mind.
create or replace function public.boost_quote(
  p_event   uuid,
  p_package text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_me      uuid := auth.uid();
  v_event   public.events%rowtype;
  v_package public.boost_packages%rowtype;
  v_start   timestamptz;
  v_full    timestamptz;
  v_ends    timestamptz;
  v_hours   numeric;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select * into v_package from public.boost_packages where code = p_package and is_active;
  if not found then
    return jsonb_build_object('available', false, 'reason', 'BOOST_PACKAGE_NOT_FOUND');
  end if;

  select * into v_event from public.events where id = p_event;
  if not found then
    return jsonb_build_object('available', false, 'reason', 'EVENT_NOT_AVAILABLE');
  end if;

  if v_event.creator_id <> v_me
     and not (v_event.organization_id is not null
              and public.is_org_member(v_event.organization_id,
                                       array['owner','admin']::org_role[]))
  then
    return jsonb_build_object('available', false, 'reason', 'NOT_AUTHORIZED');
  end if;

  if public.event_has_ended(v_event.start_at, v_event.end_at) then
    return jsonb_build_object('available', false, 'reason', 'EVENT_ALREADY_ENDED');
  end if;

  if v_event.status <> 'published' then
    return jsonb_build_object('available', false, 'reason', 'EVENT_NOT_AVAILABLE');
  end if;

  select greatest(now(), coalesce(max(ends_at), now())) into v_start
  from public.event_boosts
  where event_id = p_event and payment_status = 'succeeded' and ends_at > now();

  v_full  := v_start + make_interval(hours => v_package.hours);
  v_ends  := least(v_full, public.event_ends_at(v_event.start_at, v_event.end_at));
  v_hours := round(extract(epoch from (v_ends - v_start)) / 3600.0, 1);

  return jsonb_build_object(
    'available',      v_ends > v_start,
    'reason',         case when v_ends > v_start then null else 'EVENT_ALREADY_ENDED' end,
    'package_hours',  v_package.hours,
    -- Less than package_hours when the event ends first. The screen must show
    -- this; the price does not change, so the organizer has to be the one who
    -- decides whether it is still worth it.
    'effective_hours', greatest(0, v_hours),
    'truncated',      v_ends < v_full,
    'starts_at',      v_start,
    'ends_at',        v_ends,
    -- Non-null when a boost is already running: this one queues behind it.
    'queued_after',   case when v_start > now() then v_start end,
    'amount_cents',   v_package.price_cents,
    'currency',       v_package.currency
  );
end;
$$;

grant execute on function public.boost_quote(uuid, text) to authenticated;
