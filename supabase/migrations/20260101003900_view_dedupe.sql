-- ============================================================================
-- One visit is one view.
--
-- The view was recorded inside the function that fetches the event, so every
-- refetch counted again — mounting the screen, refetching after an RSVP, the
-- seat plan and Blup Connect each loading the same event. Opening an event once
-- added three.
--
-- The client is being fixed to record it once per visit, but the client is the
-- wrong place to guarantee this: a remount, two tabs, a double-tap and a
-- reload all look like separate visits from up there. So the rule lives here.
-- A viewer counts once per event per half hour; anything sooner is the same
-- visit still going on.
--
-- Guests are deduplicated by source rather than by identity, which is coarse —
-- two guests on the same page within the window count once. That is the
-- trade-off for not fingerprinting people who have not signed in, and it errs
-- towards under-counting, which is the right direction for a number an
-- organizer makes decisions on.
-- ============================================================================

create index if not exists event_views_dedupe_idx
  on public.event_views (event_id, user_id, created_at desc);

create or replace function public.record_event_view(
  p_event_id uuid,
  p_source   text default 'app'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user   uuid := auth.uid();
  v_window constant interval := interval '30 minutes';
begin
  if not exists (select 1 from public.events where id = p_event_id) then
    return;
  end if;

  -- Already counted this visit?
  if exists (
    select 1 from public.event_views v
    where v.event_id = p_event_id
      and v.created_at > now() - v_window
      and (
        (v_user is not null and v.user_id = v_user)
        or (v_user is null and v.user_id is null and v.source = coalesce(p_source, 'app'))
      )
  ) then
    return;
  end if;

  insert into public.event_views (event_id, user_id, source)
  values (p_event_id, v_user, coalesce(p_source, 'app'));

  perform set_config('blup.counter_update', 'on', true);
  update public.events set view_count = view_count + 1 where id = p_event_id;
end;
$$;

revoke execute on function public.record_event_view(uuid, text) from public;
grant execute on function public.record_event_view(uuid, text) to anon, authenticated;
