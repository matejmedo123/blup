-- ============================================================================
-- Repairing the counters that were frozen at zero.
--
-- 20260101002900 fixed the mechanism: the guard no longer clamps our own
-- maintenance. But it only fixed it going forward. On a database that has been
-- running, every event still carries the zeros it accumulated while the guard
-- was eating the updates, and an event only repairs itself when somebody
-- happens to RSVP to it again — which for a past event is never.
--
-- So: recompute all of them once, from the tables that were always correct.
--
-- view_count is recoverable because event_views was being written the whole
-- time; it was only the denormalised copy on events that got clamped. Anything
-- not recoverable would have to stay lost, and there is none of that here.
--
-- Safe to run on a fresh database too, where it finds nothing to change.
-- ============================================================================

do $$
declare
  fixed integer;
begin
  -- A migration runs with no auth.uid(), which is the case protect_event_counters
  -- already lets through — but the flag is raised anyway rather than relying on
  -- that, because the trigger's condition is not this migration's to depend on.
  perform set_config('blup.counter_update', 'on', true);

  with recomputed as (
    select
      e.id,
      (select count(*) from public.event_attendees a
        where a.event_id = e.id and a.status in ('going', 'checked_in')) as going,
      (select count(*) from public.event_attendees a
        where a.event_id = e.id and a.status = 'interested') as interested,
      (select count(*) from public.saved_events s where s.event_id = e.id) as saved,
      (select count(*) from public.event_likes l where l.event_id = e.id) as likes,
      (select count(*) from public.comments c
        where c.event_id = e.id and not c.is_deleted) as comments,
      (select count(*) from public.tickets t
        where t.event_id = e.id and t.status in ('valid', 'used')) as sold,
      (select count(*) from public.event_views v where v.event_id = e.id) as views
    from public.events e
  )
  update public.events e
  set attendee_count   = r.going,
      interested_count = r.interested,
      saved_count      = r.saved,
      like_count       = r.likes,
      comment_count    = r.comments,
      tickets_sold     = r.sold,
      -- Never lower than what is already recorded: an early deployment may have
      -- counted views before event_views existed, and losing those to a repair
      -- would be a worse bug than the one being fixed.
      view_count       = greatest(e.view_count, r.views)
  from recomputed r
  where r.id = e.id
    and (e.attendee_count   is distinct from r.going
      or e.interested_count is distinct from r.interested
      or e.saved_count      is distinct from r.saved
      or e.like_count       is distinct from r.likes
      or e.comment_count    is distinct from r.comments
      or e.tickets_sold     is distinct from r.sold
      or e.view_count       is distinct from greatest(e.view_count, r.views));

  get diagnostics fixed = row_count;
  raise notice 'Counters recomputed on % events', fixed;
end $$;

-- The same for ticket types, whose quantity_sold was clamped by the same guard.
do $$
declare fixed integer;
begin
  update public.ticket_types tt
  set quantity_sold = (
    select count(*) from public.tickets t
    where t.ticket_type_id = tt.id and t.status in ('valid', 'used')
  )
  where tt.quantity_sold is distinct from (
    select count(*) from public.tickets t
    where t.ticket_type_id = tt.id and t.status in ('valid', 'used')
  );

  get diagnostics fixed = row_count;
  raise notice 'quantity_sold recomputed on % ticket types', fixed;
end $$;
