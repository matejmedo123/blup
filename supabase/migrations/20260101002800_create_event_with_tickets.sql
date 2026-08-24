-- ============================================================================
-- Creating an event and its ticket types in one transaction.
--
-- Ticket types used to be a second screen the organizer reached from an alert
-- after the event already existed. Two things went wrong with that: people
-- dismissed the alert and left a paid event with nothing to sell (which then
-- showed a sales chart for an event that could never sell anything), and a
-- failure halfway through left exactly the same state with no way to notice.
--
-- So the whole thing is one call. Either the event exists with everything it
-- needs to sell, or nothing was written at all.
-- ============================================================================

create or replace function public.create_event_with_tickets(
  p_event jsonb,
  p_ticket_types jsonb default '[]'::jsonb
)
returns public.events
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user      uuid := auth.uid();
  v_event     public.events;
  v_type      jsonb;
  v_count     integer := jsonb_array_length(coalesce(p_ticket_types, '[]'::jsonb));
  v_is_free   boolean := coalesce((p_event ->> 'is_free')::boolean, true);
  v_org       uuid := nullif(p_event ->> 'organization_id', '')::uuid;
  v_min_price integer;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  -- A paid event has to have something to sell, and only a verified
  -- organization may sell it. Both are checked before anything is written.
  if not v_is_free then
    if v_count = 0 then
      raise exception 'TICKET_TYPES_REQUIRED';
    end if;
    if v_org is null then
      raise exception 'ORGANIZATION_REQUIRED';
    end if;
    if not exists (
      select 1 from public.organizations o
      where o.id = v_org and o.verification_status = 'verified'
    ) then
      raise exception 'ORGANIZATION_NOT_VERIFIED';
    end if;
    if not public.is_org_member(v_org, null, v_user) then
      raise exception 'NOT_AN_ORGANIZER';
    end if;
  elsif v_count > 0 then
    -- A free event with priced tickets is a contradiction; refuse rather than
    -- silently picking one of the two.
    raise exception 'FREE_EVENT_CANNOT_SELL';
  end if;

  insert into public.events (
    creator_id, organization_id, community_id, title, description, category, tags,
    latitude, longitude, address, venue_name, city, country,
    start_at, end_at, capacity, is_free, price_cents, currency,
    cover_image_url, visibility, status
  )
  values (
    v_user,
    v_org,
    nullif(p_event ->> 'community_id', '')::uuid,
    p_event ->> 'title',
    nullif(p_event ->> 'description', ''),
    p_event ->> 'category',
    coalesce((select array_agg(value #>> '{}') from jsonb_array_elements(p_event -> 'tags')), '{}'),
    (p_event ->> 'latitude')::double precision,
    (p_event ->> 'longitude')::double precision,
    nullif(p_event ->> 'address', ''),
    nullif(p_event ->> 'venue_name', ''),
    nullif(p_event ->> 'city', ''),
    nullif(p_event ->> 'country', ''),
    (p_event ->> 'start_at')::timestamptz,
    nullif(p_event ->> 'end_at', '')::timestamptz,
    nullif(p_event ->> 'capacity', '')::integer,
    v_is_free,
    0,                       -- replaced below with the cheapest ticket
    coalesce(nullif(p_event ->> 'currency', ''), 'EUR'),
    nullif(p_event ->> 'cover_image_url', ''),
    coalesce(nullif(p_event ->> 'visibility', ''), 'public')::event_visibility,
    coalesce(nullif(p_event ->> 'status', ''), 'published')::event_status
  )
  returning * into v_event;

  for v_type in select * from jsonb_array_elements(coalesce(p_ticket_types, '[]'::jsonb))
  loop
    insert into public.ticket_types (
      event_id, name, description, price_cents, currency,
      quantity_total, max_per_order, sales_start_at, sales_end_at
    )
    values (
      v_event.id,
      v_type ->> 'name',
      nullif(v_type ->> 'description', ''),
      (v_type ->> 'price_cents')::integer,
      coalesce(nullif(v_type ->> 'currency', ''), v_event.currency),
      (v_type ->> 'quantity_total')::integer,
      coalesce(nullif(v_type ->> 'max_per_order', '')::integer, 6),
      nullif(v_type ->> 'sales_start_at', '')::timestamptz,
      nullif(v_type ->> 'sales_end_at', '')::timestamptz
    );
  end loop;

  -- The card in the feed shows "od 12 €", so the event's own price is the
  -- cheapest thing on sale rather than a number typed separately and left to
  -- drift away from the tickets.
  if not v_is_free then
    select min(price_cents) into v_min_price
    from public.ticket_types where event_id = v_event.id;

    update public.events set price_cents = coalesce(v_min_price, 0)
    where id = v_event.id
    returning * into v_event;
  end if;

  return v_event;
end;
$$;

revoke execute on function public.create_event_with_tickets(jsonb, jsonb) from public;
grant execute on function public.create_event_with_tickets(jsonb, jsonb) to authenticated;
