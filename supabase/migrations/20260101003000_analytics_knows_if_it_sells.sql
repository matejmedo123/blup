-- ============================================================================
-- Telling the analytics screen whether this event sells anything.
--
-- The screen drew a sales curve, a "predané vstupenky" tile and a whole money
-- section for every event, including free ones that have no ticket types at
-- all. A chart of nothing over time is not an empty state, it is a screen that
-- looks broken — and it invited the question of why a free event has a sales
-- report in the first place.
--
-- Two flags, so the screen can leave that section out rather than fill it with
-- zeroes: whether the event is set up to sell, and whether it ever has.
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

  select jsonb_build_object(
    'event_id', ev.id,
    'title', ev.title,
    'is_free', ev.is_free,
    -- Set up to sell: not free, and something priced actually exists.
    'sells_tickets', (not ev.is_free) and exists (
      select 1 from public.ticket_types tt
      where tt.event_id = ev.id and tt.is_active
    ),
    -- Has ever sold: keeps the report readable for an event whose sale is over
    -- and whose ticket types have since been deactivated.
    'has_sales', ev.tickets_sold > 0,
    'views', ev.view_count,
    'unique_viewers', (select count(distinct user_id) from public.event_views where event_id = ev.id),
    'saves', ev.saved_count,
    'likes', ev.like_count,
    'comments', ev.comment_count,
    'rsvp_going', ev.attendee_count,
    'rsvp_interested', ev.interested_count,
    'checked_in', (select count(*) from public.tickets where event_id = ev.id and status = 'used'),
    'tickets_sold', ev.tickets_sold,
    'conversion_rate', case when ev.view_count > 0
                            then round((ev.tickets_sold::numeric / ev.view_count) * 100, 2)
                            else 0 end,
    -- The money block, from the orders themselves. The screen has always asked
    -- for all of these; the function only ever returned three, so four rows of
    -- the "Peniaze" section were rendering an undefined amount.
    'gross_revenue_cents', coalesce(m.gross, 0),
    'discount_cents', coalesce(m.discount, 0),
    'net_revenue_cents', coalesce(m.gross - m.discount, 0),
    'commission_cents', coalesce(m.commission, 0),
    'archive_fee_cents', coalesce(m.archive_fee, 0),
    'platform_fee_cents', coalesce(m.platform_fee, 0),
    'organizer_net_cents', coalesce(m.gross - m.discount - m.platform_fee, 0),
    -- Everything the buyers handed over, archive fee included — which is not
    -- the organizer's revenue when the buyer is the one paying it.
    'buyers_paid_cents', coalesce(m.total, 0),
    'currency', ev.currency
  ) into result;

  return result;
end;
$$;

revoke execute on function public.event_analytics(uuid) from public;
grant execute on function public.event_analytics(uuid) to authenticated;
