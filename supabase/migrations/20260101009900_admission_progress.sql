-- ============================================================================
-- Koľko vstupeniek ešte treba odbaviť.
--
-- The analytics screen said how many tickets were sold and how many had been
-- scanned. The number an organizer standing at the door actually wants is the
-- third one — how many are still outside — and subtracting two figures in your
-- head at 23:00 with a queue in front of you is not a feature.
--
-- Three numbers, from the tickets themselves rather than from the denormalised
-- counter on the event:
--
--   inside     scanned in and not scanned back out: who is in the room
--   to_admit   still valid, never scanned: who can still walk up
--   void       refunded or deactivated: sold once, worth nothing at the door
--
-- `tickets_sold` on the event deliberately does not enter into it. It counts
-- what was sold, including tickets since refunded, so using it as the door's
-- denominator would leave an organizer waiting all night for people whose
-- money has already gone back.
-- ============================================================================

create or replace function public.event_analytics(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ev     public.events;
  m      record;
  door   record;
  result jsonb;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if not (
    ev.creator_id = auth.uid()
    or (ev.organization_id is not null and public.is_org_member(ev.organization_id, null, auth.uid()))
    or public.is_admin()
  ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select
    sum(o.subtotal_cents)     as gross,
    sum(o.discount_cents)     as discount,
    sum(o.commission_cents)   as commission,
    sum(o.archive_fee_cents)  as archive_fee,
    sum(o.platform_fee_cents) as platform_fee,
    sum(o.total_cents)        as total
  into m
  from public.orders o
  where o.event_id = ev.id and o.payment_status = 'succeeded';

  select
    count(*) filter (where t.status = 'used')                       as inside,
    count(*) filter (where t.status = 'valid')                      as to_admit,
    count(*) filter (where t.status in ('refunded', 'cancelled'))   as void,
    count(*) filter (where t.status in ('valid', 'used'))           as live
  into door
  from public.tickets t
  where t.event_id = ev.id;

  select jsonb_build_object(
    'event_id', ev.id,
    'title', ev.title,
    'is_free', ev.is_free,
    'sells_tickets', (not ev.is_free) and exists (
      select 1 from public.ticket_types tt
      where tt.event_id = ev.id and tt.is_active
    ),
    'has_sales', ev.tickets_sold > 0,
    'views', ev.view_count,
    'unique_viewers', (select count(distinct user_id) from public.event_views where event_id = ev.id),
    'saves', ev.saved_count,
    'likes', ev.like_count,
    'comments', ev.comment_count,
    'rsvp_going', ev.attendee_count,
    'rsvp_interested', ev.interested_count,
    'checked_in', coalesce(door.inside, 0),
    -- The door, in the three numbers it is actually made of.
    'inside', coalesce(door.inside, 0),
    'to_admit', coalesce(door.to_admit, 0),
    'tickets_void', coalesce(door.void, 0),
    'tickets_live', coalesce(door.live, 0),
    'admitted_pct', case when coalesce(door.live, 0) > 0
                         then round((door.inside::numeric / door.live) * 100, 1)
                         else 0 end,
    'tickets_sold', ev.tickets_sold,
    'conversion_rate', case when ev.view_count > 0
                            then round((ev.tickets_sold::numeric / ev.view_count) * 100, 2)
                            else 0 end,
    'gross_revenue_cents', coalesce(m.gross, 0),
    'discount_cents', coalesce(m.discount, 0),
    'net_revenue_cents', coalesce(m.gross - m.discount, 0),
    'commission_cents', coalesce(m.commission, 0),
    'archive_fee_cents', coalesce(m.archive_fee, 0),
    'platform_fee_cents', coalesce(m.platform_fee, 0),
    'organizer_net_cents', coalesce(m.gross - m.discount - m.platform_fee, 0),
    'buyers_paid_cents', coalesce(m.total, 0),
    'currency', ev.currency
  ) into result;

  return result;
end;
$$;

revoke execute on function public.event_analytics(uuid) from public;
grant execute on function public.event_analytics(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The same three numbers on their own, for the scanner screen — which needs
-- them after every scan and has no use for the money block.
-- ---------------------------------------------------------------------------
create or replace function public.event_door_state(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ev   public.events;
  door record;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if not (
    ev.creator_id = auth.uid()
    or (ev.organization_id is not null and public.is_org_member(ev.organization_id, null, auth.uid()))
    or public.is_admin()
  ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select
    count(*) filter (where t.status = 'used')                     as inside,
    count(*) filter (where t.status = 'valid')                    as to_admit,
    count(*) filter (where t.status in ('refunded', 'cancelled')) as void,
    count(*) filter (where t.status in ('valid', 'used'))         as live,
    max(t.checked_in_at)                                          as last_scan_at
  into door
  from public.tickets t
  where t.event_id = ev.id;

  return jsonb_build_object(
    'event_id', ev.id,
    'title', ev.title,
    'capacity', ev.capacity,
    'inside', coalesce(door.inside, 0),
    'to_admit', coalesce(door.to_admit, 0),
    'tickets_void', coalesce(door.void, 0),
    'tickets_live', coalesce(door.live, 0),
    'admitted_pct', case when coalesce(door.live, 0) > 0
                         then round((door.inside::numeric / door.live) * 100, 1)
                         else 0 end,
    'last_scan_at', door.last_scan_at
  );
end;
$$;

revoke execute on function public.event_door_state(uuid) from public;
grant execute on function public.event_door_state(uuid) to authenticated;
