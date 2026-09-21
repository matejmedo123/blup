-- ============================================================================
-- Prekreslenie sektora meria rad raz, nie raz za každé sedadlo
-- ============================================================================
-- Vyrezanie diery do sektora so 185 miestami trvalo 5,6 sekundy. Nie preto, že
-- by mazanie miest bolo ťažké — reflow si pre KAŽDÉ sedadlo nanovo odmeral
-- dĺžku jeho radu, a meranie radu je šesťdesiatštyri bodov po páse, každý
-- prejdením celého obrysu. Pri 185 miestach je to vyše dvanásťtisíc prechodov
-- obrysu namiesto tisíc.
--
-- Na štadióne s dvanástimi tisícmi miest by to prekreslenie jedného sektora
-- natiahlo na minúty a appka by len čakala. V prehliadači to vyzeralo, že sa
-- nestalo nič: požiadavka odišla, odpoveď neprišla, plán zostal, aký bol.
--
-- Rad sa teda odmeria raz a všetky jeho miesta si tú dĺžku podajú. A rovnako
-- raz sa zistí, čo je predané: seat_claims prehľadáva vstupenky aj košíky a v
-- `not exists` sa volalo na každé miesto zvlášť.
-- ============================================================================

create or replace function public.reflow_section_seats(p_section_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_map     uuid;
  v_event   uuid;
  v_removed integer := 0;
  v_kept    integer := 0;
begin
  select s.venue_map_id, tt.event_id into v_map, v_event
  from public.venue_sections s
  left join public.ticket_types tt on tt.id = s.ticket_type_id
  where s.id = p_section_id;

  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  with sec as (
    select s.shape,
           s.holes,
           public.jsonb_to_polygon(s.shape) as poly,
           s.seat_pitch,
           (select count(distinct vs.row_label) from public.venue_seats vs
            where vs.venue_section_id = s.id) as tall
    from public.venue_sections s
    where s.id = p_section_id
      and jsonb_typeof(s.shape) = 'array'
      and jsonb_array_length(s.shape) >= 3
      and s.seat_pitch is not null
  ),
  ranked as (
    select vs.id,
           dense_rank() over (order by vs.row_label) - 1 as r,
           coalesce(vs.slot, 2 * vs.seat_number
                             - count(*) over (partition by vs.row_label) - 1) as slot
    from public.venue_seats vs
    where vs.venue_section_id = p_section_id
  ),
  -- Tu je tá zmena: dĺžka radu raz za rad, nie raz za miesto.
  lens as materialized (
    select r,
           (r + 0.5)::numeric / nullif(sec.tall, 0) as v,
           public.band_row_length(sec.shape, (r + 0.5)::numeric / nullif(sec.tall, 0)) as len
    from (select distinct r from ranked) rows_of, sec
  ),
  spots as materialized (
    select ranked.id,
           sec.poly,
           sec.holes,
           public.band_point(
             sec.shape,
             0.5 + (ranked.slot::numeric / 2) * sec.seat_pitch / lens.len,
             lens.v) as pt
    from ranked
    join lens on lens.r = ranked.r
    cross join sec
    where lens.len > 0
  ),
  -- Aj toto raz: seat_claims prehľadáva vstupenky a košíky, a v `not exists`
  -- na každé miesto zvlášť to bol ten zvyšok tých piatich sekúnd.
  claimed as materialized (
    select c.seat_id from public.seat_claims(v_event) c where v_event is not null
  ),
  doomed as (
    select spots.id
    from spots
    where (not spots.poly @> spots.pt or public.in_any_hole(spots.holes, spots.pt))
      and not exists (select 1 from claimed c where c.seat_id = spots.id)
  )
  delete from public.venue_seats vs using doomed where vs.id = doomed.id;
  get diagnostics v_removed = row_count;

  select count(*) into v_kept from public.venue_seats where venue_section_id = p_section_id;
  return jsonb_build_object('removed', v_removed, 'total', v_kept);
end;
$fn$;

revoke execute on function public.reflow_section_seats(uuid) from public, anon;
grant execute on function public.reflow_section_seats(uuid) to authenticated;
