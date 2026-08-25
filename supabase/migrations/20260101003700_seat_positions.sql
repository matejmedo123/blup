-- ============================================================================
-- Seats as dots on the plan, and telling mine from taken.
--
-- Two gaps the first version left.
--
-- The map said `free` for every seat, which folded together "somebody else has
-- it" and "you have it". On a plan drawn as dots those must look different: a
-- seat you are holding is the whole point of clicking, and showing it in the
-- same grey as one you cannot have makes the click look like it failed.
--
-- And a seat had no position, so it could only be drawn as a list under the
-- plan. A generated sector is a grid — rows by seats — so the position is
-- derivable from the row and the number rather than stored: nothing has to be
-- kept in step when a stand is regenerated, and re-photographing the plan
-- still moves nothing.
-- ============================================================================

create or replace function public.seat_map_for_event(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ev as (
    select e.id, e.venue_map_id from public.events e where e.id = p_event_id
  ),
  sold as (
    select t.venue_seat_id as seat_id
    from public.tickets t
    where t.event_id = p_event_id and t.venue_seat_id is not null
      and t.status in ('valid', 'used')
  ),
  held as (
    select c.venue_seat_id as seat_id, c.user_id
    from public.cart_items c
    where c.event_id = p_event_id and c.venue_seat_id is not null
      and c.expires_at > now()
  )
  select case when (select venue_map_id from ev) is null then null else
    jsonb_build_object(
      'map', to_jsonb(m) - 'created_by',
      'sections', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'colour', s.colour,
            'x', s.x, 'y', s.y, 'width', s.width, 'height', s.height,
            'ticket_type_id', s.ticket_type_id,
            'price_cents', tt.price_cents,
            'numbered', exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id),
            'available', case
              when exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id)
                then (select count(*) from public.venue_seats vs
                      where vs.venue_section_id = s.id and vs.is_sellable
                        and vs.id not in (select seat_id from sold)
                        and vs.id not in (select seat_id from held))
              else coalesce((select a.available
                             from public.ticket_type_availability(s.ticket_type_id) a), 0)
            end,
            -- How many rows, and the widest of them: the client lays the dots
            -- out from these, so an uneven row centres instead of stretching.
            'rows', (select count(distinct vs.row_label) from public.venue_seats vs
                     where vs.venue_section_id = s.id),
            'row_width', coalesce((select max(cnt) from (
                select count(*) as cnt from public.venue_seats vs
                where vs.venue_section_id = s.id group by vs.row_label) w), 0),
            'seats', coalesce((
              -- The row index is ranked in a subquery: an aggregate cannot hold
              -- a window function, so the ranking happens first and jsonb_agg
              -- reads the result.
              select jsonb_agg(jsonb_build_object(
                'id', vs.id,
                'row', vs.row_label,
                'number', vs.seat_number,
                -- Where it sits among the rows, so the client does not have to
                -- work out that B comes after A and before AA.
                'row_index', vs.row_index,
                'sellable', vs.is_sellable,
                'mine', (select h.user_id from held h where h.seat_id = vs.id) = auth.uid(),
                'taken', vs.id in (select seat_id from sold)
                         or exists (select 1 from held h
                                    where h.seat_id = vs.id and h.user_id is distinct from auth.uid()),
                'free', vs.is_sellable
                        and vs.id not in (select seat_id from sold)
                        and not exists (select 1 from held h where h.seat_id = vs.id)
              ) order by vs.row_label, vs.seat_number)
              from (
                select v.*,
                       dense_rank() over (order by v.row_label) - 1 as row_index
                from public.venue_seats v
                where v.venue_section_id = s.id
              ) vs
            ), '[]'::jsonb)
          ) order by s.sort_order, s.name
        )
        from public.venue_sections s
        left join public.ticket_types tt on tt.id = s.ticket_type_id
        where s.venue_map_id = m.id
      ), '[]'::jsonb)
    )
  end
  from ev
  left join public.venue_maps m on m.id = ev.venue_map_id;
$$;

grant execute on function public.seat_map_for_event(uuid) to anon, authenticated;
