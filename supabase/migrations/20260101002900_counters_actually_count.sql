-- ============================================================================
-- Letting the counter maintenance through its own guard.
--
-- protect_event_counters is a BEFORE UPDATE trigger that pins every
-- denormalised counter to its old value, so a client cannot inflate an event's
-- attendance or views by writing the row directly. It checked auth.uid(), which
-- is set for anyone signed in — and SECURITY DEFINER does not change auth.uid().
--
-- So the trigger fired on our own maintenance too: sync_event_attendee_counts
-- recomputed attendee_count, the trigger put the old value back, and every
-- counter on every event stayed at zero for everyone except an admin. The map
-- said "0 ide" for a full event, views never moved, and the ranker — which
-- weighs attendee_count, saved_count and view_count — was reading zeroes.
--
-- The trusted maintainers now raise a transaction-local flag that the trigger
-- consumes. A client cannot forge it: PostgREST runs each request in its own
-- transaction, so setting the flag and updating the row cannot happen together.
-- The trigger clears it as it passes, so one raise permits exactly one update.
-- ============================================================================

create or replace function public.protect_event_counters()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  trusted boolean := coalesce(current_setting('blup.counter_update', true), '') = 'on';
begin
  if trusted then
    -- Single use: consumed here so a raised flag cannot cover a second update.
    perform set_config('blup.counter_update', 'off', true);
    return new;
  end if;

  if auth.uid() is not null and not public.is_admin() then
    new.attendee_count   := old.attendee_count;
    new.interested_count := old.interested_count;
    new.saved_count      := old.saved_count;
    new.like_count       := old.like_count;
    new.comment_count    := old.comment_count;
    new.view_count       := old.view_count;
    new.tickets_sold     := old.tickets_sold;
  end if;
  return new;
end;
$$;

create or replace function public.sync_event_attendee_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
begin
  perform set_config('blup.counter_update', 'on', true);

  update public.events e
  set attendee_count = (
        select count(*) from public.event_attendees a
        where a.event_id = target_event and a.status in ('going', 'checked_in')
      ),
      interested_count = (
        select count(*) from public.event_attendees a
        where a.event_id = target_event and a.status = 'interested'
      )
  where e.id = target_event;
  return null;
end;
$$;

-- The remaining counter maintainers, each raising the flag before its update.
-- Written out rather than patched dynamically: there are four of them, they
-- differ, and a regex over pg_get_functiondef would be four chances to change
-- behaviour by accident.

create or replace function public.sync_event_saved_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
begin
  perform set_config('blup.counter_update', 'on', true);
  update public.events e
  set saved_count = (select count(*) from public.saved_events s where s.event_id = target_event)
  where e.id = target_event;
  return null;
end;
$$;

create or replace function public.sync_event_like_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
begin
  perform set_config('blup.counter_update', 'on', true);
  update public.events e
  set like_count = (select count(*) from public.event_likes l where l.event_id = target_event)
  where e.id = target_event;
  return null;
end;
$$;

create or replace function public.sync_comment_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
  target_post  uuid := coalesce(new.post_id, old.post_id);
begin
  if target_event is not null then
    perform set_config('blup.counter_update', 'on', true);
    update public.events e
    set comment_count = (
      select count(*) from public.comments c
      where c.event_id = target_event and not c.is_deleted
    )
    where e.id = target_event;
  end if;

  if target_post is not null then
    update public.posts p
    set comment_count = (
      select count(*) from public.comments c
      where c.post_id = target_post and not c.is_deleted
    )
    where p.id = target_post;
  end if;

  return null;
end;
$$;

create or replace function public.sync_ticket_counts()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_event uuid := coalesce(new.event_id, old.event_id);
  target_type  uuid := coalesce(new.ticket_type_id, old.ticket_type_id);
begin
  perform set_config('blup.counter_update', 'on', true);
  update public.events e
  set tickets_sold = (
    select count(*) from public.tickets t
    where t.event_id = target_event and t.status in ('valid', 'used')
  )
  where e.id = target_event;

  if target_type is not null then
    update public.ticket_types tt
    set quantity_sold = (
      select count(*) from public.tickets t
      where t.ticket_type_id = target_type and t.status in ('valid', 'used')
    )
    where tt.id = target_type;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- A view is a view, even from somebody who is not signed in.
-- ---------------------------------------------------------------------------
create or replace function public.record_event_view(
  p_event_id uuid,
  p_source   text default 'app'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.events where id = p_event_id) then
    return;
  end if;

  insert into public.event_views (event_id, user_id, source)
  values (p_event_id, auth.uid(), coalesce(p_source, 'app'));

  perform set_config('blup.counter_update', 'on', true);
  update public.events set view_count = view_count + 1 where id = p_event_id;
end;
$$;

revoke execute on function public.record_event_view(uuid, text) from public;
grant execute on function public.record_event_view(uuid, text) to anon, authenticated;

-- record_signal keeps the personal signal (which needs a user) and hands the
-- public counter to the function above, so the two no longer have to agree.
create or replace function public.record_signal(
  p_event_id uuid,
  p_signal   signal_type,
  p_weight   numeric default 1.0,
  p_context  jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  insert into public.user_event_signals (user_id, event_id, signal, weight, context)
  values (auth.uid(), p_event_id, p_signal, coalesce(p_weight, 1.0), coalesce(p_context, '{}'::jsonb));

  if p_signal in ('open_detail', 'impression') then
    perform public.record_event_view(p_event_id, coalesce(p_context ->> 'source', 'app'));
  end if;
end;
$$;
