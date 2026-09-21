-- ============================================================================
-- Diera v sektore: schodisko, výťah, stĺp
-- ============================================================================
-- Tribúna často nie je súvislá plocha. Doprostred bloku je zarezané schodisko,
-- v rohu stojí stĺp, uprostred je vchod z tunela. Na pláne je to biely
-- obdĺžnik, okolo ktorého rady pokračujú ďalej — čísla miest na ne nadväzujú a
-- stĺpce sa nerozídu.
--
-- Nakresliť to ako súčasť obrysu nejde a nejde to principiálne. Sektor je pás:
-- dve dlhé hrany a medzi nimi rady. Zárez uprostred hrany z toho spraví tvar,
-- ktorý dve dlhé hrany nemá — a rozloženie miest sa rozpadne. Zmerané na bloku
-- 0.30 širokom so zárezom: rady vyšli od 0.883 po 0.540 dlhé namiesto rovnakých
-- 0.300, začiatky radov sa rozišli o tretinu šírky a dve miesta skončili mimo.
--
-- Diera je preto niečo iné než obrys. Obrys hovorí, kde tribúna je; diera
-- hovorí, kde v nej nie je sedenie. Mriežka sa počíta z obrysu, takže rady
-- zostanú rovnaké a stĺpce držia; diera len vyhodí miesta, ktoré do nej padli.
-- ============================================================================

alter table public.venue_sections
  add column if not exists holes jsonb;

comment on column public.venue_sections.holes is
  'Polia obrysov dier v sektore — schodisko, stĺp, vchod. Mriežku neovplyvnia, '
  'len z nej vypadnú miesta, ktoré v nich ležia.';

/**
 * Leží bod v niektorej z dier?
 *
 * Bez diery vracia false, nie nič. Podmienka v `where` na tejto úrovni nefiltruje
 * riadok, ale spraví z výsledku NULL — a `not null` potom nie je pravda, takže
 * sektor bez dier prišiel o všetky miesta. Preto je to `case`, nie `where`.
 */
create or replace function public.in_any_hole(p_holes jsonb, p_point point)
returns boolean
language sql
immutable
set search_path = public, extensions
as $fn$
  select case
    when p_holes is null or jsonb_typeof(p_holes) <> 'array' or p_point is null then false
    else coalesce((
      select bool_or(public.jsonb_to_polygon(hole) @> p_point)
      from jsonb_array_elements(p_holes) hole
      where jsonb_typeof(hole) = 'array' and jsonb_array_length(hole) >= 3
    ), false)
  end;
$fn$;

grant execute on function public.in_any_hole(jsonb, point) to anon, authenticated;


/**
 * Nakresliť do sektora diery, alebo ich zrušiť.
 *
 * Rovnaké pravidlá ako obrys: zlomky plánu, aspoň tri rohy, rozumný počet.
 * Miesta, ktoré po vyrezaní ležia v diere, sa neodstránia samy — na to je
 * reflow_section_seats, ktorý vie, čo je predané a čo nie.
 */
create or replace function public.set_section_holes(p_section_id uuid, p_holes jsonb)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_map  uuid;
  v_hole jsonb;
  v_pt   jsonb;
begin
  select s.venue_map_id into v_map
  from public.venue_sections s where s.id = p_section_id;
  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  if p_holes is not null and p_holes <> 'null'::jsonb then
    if jsonb_typeof(p_holes) <> 'array' then
      raise exception 'INVALID_HOLES';
    end if;
    if jsonb_array_length(p_holes) > 12 then
      raise exception 'TOO_MANY_HOLES'
        using hint = 'Najviac dvanásť dier v jednom sektore.';
    end if;
    for v_hole in select * from jsonb_array_elements(p_holes) loop
      if jsonb_typeof(v_hole) <> 'array' or jsonb_array_length(v_hole) < 3 then
        raise exception 'HOLE_TOO_SMALL'
          using hint = 'Diera potrebuje aspoň tri rohy.';
      end if;
      if jsonb_array_length(v_hole) > 40 then
        raise exception 'HOLE_TOO_COMPLEX'
          using hint = 'Diera môže mať najviac štyridsať rohov.';
      end if;
      for v_pt in select * from jsonb_array_elements(v_hole) loop
        if (v_pt ->> 'x') is null or (v_pt ->> 'y') is null
           or (v_pt ->> 'x')::numeric < 0 or (v_pt ->> 'x')::numeric > 1
           or (v_pt ->> 'y')::numeric < 0 or (v_pt ->> 'y')::numeric > 1 then
          raise exception 'HOLE_OUT_OF_PLAN'
            using hint = 'Rohy diery musia ležať v pláne.';
        end if;
      end loop;
    end loop;
  end if;

  update public.venue_sections
  set holes = case when p_holes is null or p_holes = 'null'::jsonb
                     or jsonb_array_length(p_holes) = 0
                   then null else p_holes end
  where id = p_section_id;

  -- Vyrezané schodisko znamená, že miesta v ňom už na tribúne nie sú. Predané
  -- a držané prežijú — to rieši reflow.
  perform public.reflow_section_seats(p_section_id);

  return coalesce(jsonb_array_length(p_holes), 0);
end;
$fn$;

revoke execute on function public.set_section_holes(uuid, jsonb) from public, anon;
grant execute on function public.set_section_holes(uuid, jsonb) to authenticated;


/**
 * Mriežka sektora — teraz aj s dierami.
 *
 * Diera nie je súčasťou obrysu a nesmie ním byť: pás má dve dlhé hrany a zárez
 * uprostred jednej z nich z neho spraví tvar, ktorý ich nemá. Rady sa preto
 * počítajú z obrysu a diera len vyhodí miesta, ktoré do nej padli.
 */
create or replace function public.section_seat_grid(p_section_id uuid, p_rows integer, p_per_row integer, p_start_row integer DEFAULT 0, p_row_style text DEFAULT 'letters'::text, p_row_prefix text DEFAULT NULL::text, p_seat_start integer DEFAULT 1)
 RETURNS TABLE(row_label text, seat_number integer, slot integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  with sec as (
    select s.shape,
           s.holes,
           public.jsonb_to_polygon(s.shape) as poly
    from public.venue_sections s
    where s.id = p_section_id
  ),
  lens as (
    select r,
           case when sec.shape is null then null
                else public.band_row_length(sec.shape, (r + 0.5)::numeric / p_rows) end as len
    from generate_series(0, p_rows - 1) r, sec
  ),
  pitch as (
    -- Rozostup udáva rad A: toľko miest, koľko si organizátor vypýtal.
    select case when p_per_row > 0 then (select len from lens where r = 0) / p_per_row end as step
  ),
  counts as (
    select lens.r,
           lens.len,
           pitch.step,
           case
             when lens.len is null or pitch.step is null or pitch.step <= 0 then p_per_row
             -- Rad užší než jedno sedadlo nedostane žiadne.
             when lens.len < pitch.step then 0
             -- Miesto potrebuje celý rozostup, nie polovicu: inak posledné
             -- sedadlo vyjde stredom na okraj sektora, čiže polovicou von.
             when p_per_row % 2 = 0 then
               least(p_per_row * 4,
                 2 * floor(lens.len / (2 * pitch.step) + 0.000000001)::integer)
             else
               least(p_per_row * 4,
                 2 * floor((lens.len / pitch.step - 1) / 2 + 0.000000001)::integer + 1)
           end as per
    from lens, pitch
  ),
  grid as (
    select counts.r,
           n::integer as n,
           -- slot = 2·(poradie − (počet+1)/2), čiže celé číslo, susedia o dva.
           (2 * (n - greatest(coalesce(p_seat_start, 1), 1) + 1) - counts.per - 1)::integer as slot,
           counts.len,
           counts.step,
           (counts.r + 0.5)::numeric / p_rows as v
    from counts,
         generate_series(greatest(coalesce(p_seat_start, 1), 1),
                         greatest(coalesce(p_seat_start, 1), 1) + counts.per - 1) n
  )
  select public.seat_row_name(p_start_row + grid.r, coalesce(p_row_style, 'letters'), p_row_prefix),
         grid.n,
         grid.slot
  from grid, sec
  cross join lateral (
    select case when grid.len is null or grid.len <= 0 or grid.step is null then null
                else public.band_point(
                  sec.shape, 0.5 + (grid.slot::numeric / 2) * grid.step / grid.len, grid.v)
           end as spot
  ) at
  where (sec.poly is null or at.spot is null or sec.poly @> at.spot)
    -- Diera sektor nekreslí, len z neho uberá: mriežka je rovnaká, len miesta,
    -- ktoré padli do schodiska, nevzniknú.
    and not public.in_any_hole(sec.holes, at.spot);
$function$;


/** Plán pre kupujúceho — a k nemu diery, aby ich vedel nakresliť. */
create or replace function public.seat_map_for_event(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with ev as (
    select e.id, e.venue_map_id from public.events e where e.id = p_event_id
  ),
  claims as (
    select c.seat_id from public.seat_claims(p_event_id) c
  )
  select case when (select venue_map_id from ev) is null then null else
    jsonb_build_object(
      'map', (to_jsonb(m) - 'created_by' - 'updated_by')
             || case when m.image_is_backdrop
                     then jsonb_build_object('image_url', null)
                     else '{}'::jsonb end,
      'sections', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'colour', s.colour,
            'kind', s.kind,
            'note', s.note,
            'landmark', public.section_is_landmark(s.kind),
            'x', s.x, 'y', s.y, 'width', s.width, 'height', s.height,
            'rotation', s.rotation,
            'seat_pitch', s.seat_pitch,
            'shape', s.shape,
            'holes', s.holes,
            'ticket_type_id', s.ticket_type_id,
            'price_cents', tt.price_cents,
            'numbered', exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id),
            'seat_count', (select count(*) from public.venue_seats vs where vs.venue_section_id = s.id),
            'available', case
              when public.section_is_landmark(s.kind) then 0
              when exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id)
                then (select count(*) from public.venue_seats vs
                      where vs.venue_section_id = s.id and vs.is_sellable
                        and not exists (select 1 from claims cl where cl.seat_id = vs.id))
              else coalesce((select a.available
                             from public.ticket_type_availability(s.ticket_type_id) a), 0)
            end,
            'rows', (select count(distinct vs.row_label) from public.venue_seats vs
                     where vs.venue_section_id = s.id),
            'row_width', coalesce((select max(cnt) from (
                select count(*) as cnt from public.venue_seats vs
                where vs.venue_section_id = s.id group by vs.row_label) w), 0)
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
$function$;


/**
 * Po vyrezaní diery (alebo prekreslení obrysu) zmiznú miesta, ktoré tam už nie
 * sú — okrem tých, na ktoré niekto má vstupenku.
 */
create or replace function public.reflow_section_seats(p_section_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  ),
  ranked as (
    select vs.id,
           dense_rank() over (order by vs.row_label) - 1 as r,
           vs.seat_number as n,
           vs.slot,
           count(*) over (partition by vs.row_label) as per
    from public.venue_seats vs
    where vs.venue_section_id = p_section_id
  ),
  placed as (
    select ranked.id,
           sec.poly,
           sec.shape,
           sec.holes,
           (ranked.r + 0.5)::numeric / nullif(sec.tall, 0) as v,
           coalesce(ranked.slot, 2 * ranked.n - ranked.per - 1) as slot,
           sec.seat_pitch
    from ranked, sec
  ),
  doomed as (
    select placed.id
    from placed
    cross join lateral (
      select public.band_row_length(placed.shape, placed.v) as len
    ) w
    where placed.v is not null
      and w.len > 0
      and placed.seat_pitch is not null
      and (not placed.poly @> public.band_point(
             placed.shape,
             0.5 + (placed.slot::numeric / 2) * placed.seat_pitch / w.len,
             placed.v)
           -- Vyrezaná diera je ten istý prípad ako prekreslený obrys: miesto,
           -- ktoré je teraz v schodisku, tam nie je.
           or public.in_any_hole(placed.holes, public.band_point(
             placed.shape,
             0.5 + (placed.slot::numeric / 2) * placed.seat_pitch / w.len,
             placed.v)))
      and (v_event is null
           or not exists (select 1 from public.seat_claims(v_event) c where c.seat_id = placed.id))
  )
  delete from public.venue_seats vs using doomed where vs.id = doomed.id;
  get diagnostics v_removed = row_count;

  select count(*) into v_kept from public.venue_seats where venue_section_id = p_section_id;
  return jsonb_build_object('removed', v_removed, 'total', v_kept);
end;
$function$;


/** Prekreslený obrys odteraz naozaj zhodí miesta, ktoré vypadli z tribúny. */
create or replace function public.set_section_shape(p_section_id uuid, p_shape jsonb)
 RETURNS venue_sections
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_map    uuid;
  v_bounds jsonb;
  v_out    public.venue_sections;
begin
  select venue_map_id into v_map from public.venue_sections where id = p_section_id;
  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  if p_shape is null or jsonb_array_length(p_shape) = 0 then
    -- Späť na obdĺžnik. Ohraničenie zostáva tam, kde tvar bol, takže sektor
    -- nikam neskočí.
    update public.venue_sections set shape = null
    where id = p_section_id
    returning * into v_out;
    return v_out;
  end if;

  if jsonb_array_length(p_shape) < 3 then
    raise exception 'SHAPE_TOO_SHORT'
      using hint = 'Tvar potrebuje aspoň tri body.';
  end if;
  if jsonb_array_length(p_shape) > 40 then
    raise exception 'SHAPE_TOO_COMPLEX'
      using hint = 'Najviac 40 bodov — plán sa kreslí na telefóne.';
  end if;

  v_bounds := public.shape_bounds(p_shape);

  update public.venue_sections
  set shape  = p_shape,
      x      = (v_bounds ->> 'x')::numeric,
      y      = (v_bounds ->> 'y')::numeric,
      width  = least((v_bounds ->> 'width')::numeric,  1 - (v_bounds ->> 'x')::numeric),
      height = least((v_bounds ->> 'height')::numeric, 1 - (v_bounds ->> 'y')::numeric),
      -- Nakreslený tvar UŽ natočenie obsahuje — body sú tam, kam ich človek
      -- naklikal. Nechať k tomu ešte `rotation` znamená otočiť to dvakrát:
      -- obrys by sa posunul preč od miest, na ktoré sa klikalo. Jeden zdroj
      -- pravdy, a je ním tvar.
      rotation = 0
  where id = p_section_id
  returning * into v_out;

  return v_out;
end;
$function$;
