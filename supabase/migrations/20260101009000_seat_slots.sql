-- ============================================================================
-- Miesto si pamätá, na ktorom bode mriežky stojí
-- ============================================================================
-- Kde miesto v rade leží sa doteraz odvodzovalo z toho, koľké je a koľko ich v
-- rade celkovo je. Pre mriežku, ktorú vygeneruje appka, to stačí. Nestačí to
-- vo chvíli, keď má organizátor do radu jedno miesto pridať alebo ubrať —
-- lebo tým sa zmení počet, a s ním by sa pohli všetky ostatné miesta v rade.
-- Rad by sa posunul o pol rozostupu a stĺpce by sa rozišli, čo je presne to,
-- čo sa práve opravilo.
--
-- Miesto si preto pamätá svoj bod: `slot` je dvojnásobok vzdialenosti od
-- stredu radu v rozostupoch, takže je to vždy celé číslo a susedia sa líšia o
-- dva. Pri párnom počte miest v rade vychádzajú nepárne sloty (±1, ±3, …),
-- pri nepárnom párne (0, ±2, …) — a v oboch prípadoch na tých istých bodoch
-- vo všetkých radoch sektora.
--
-- A rozostup si pamätá sektor, nie sa dopočítava z prvého radu: keby do prvého
-- radu niekto pridal miesto, zmenil by tým rozostup celého sektora.
-- ============================================================================

alter table public.venue_seats
  add column if not exists slot integer;

comment on column public.venue_seats.slot is
  'Dvojnásobok vzdialenosti od stredu radu v rozostupoch. NULL = staré miesto, '
  'poloha sa dopočíta z poradia a počtu miest v rade.';

alter table public.venue_sections
  add column if not exists seat_pitch numeric;

comment on column public.venue_sections.seat_pitch is
  'Vzdialenosť medzi susednými miestami pozdĺž radu, v zlomkoch plánu.';

-- Mriežka teraz vracia aj slot, takže sa musí prekresliť celá.
drop function if exists public.section_seat_grid(uuid, integer, integer, integer, text, text, integer);

create function public.section_seat_grid(
  p_section_id uuid,
  p_rows       integer,
  p_per_row    integer,
  p_start_row  integer default 0,
  p_row_style  text    default 'letters',
  p_row_prefix text    default null,
  p_seat_start integer default 1
)
returns table (row_label text, seat_number integer, slot integer)
language sql
stable
set search_path = public, extensions
as $fn$
  with sec as (
    select s.shape,
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
  where sec.poly is null
     or grid.len is null or grid.len <= 0 or grid.step is null
     or sec.poly @> public.band_point(
          sec.shape, 0.5 + (grid.slot::numeric / 2) * grid.step / grid.len, grid.v);
$fn$;

grant execute on function
  public.section_seat_grid(uuid, integer, integer, integer, text, text, integer)
  to authenticated;


/**
 * Vygenerovanie miest do sektora — teraz aj s bodom mriežky a rozostupom.
 *
 * Oproti predošlej verzii sa líši dvoma riadkami: miesto si uloží svoj slot a
 * sektor si uloží rozostup. Zvyšok — kontroly typu sektora, ochrana predaných
 * miest — zostáva.
 */
create or replace function public.generate_section_seats(
  p_section_id uuid,
  p_rows       integer,
  p_per_row    integer,
  p_start_row  integer default 0,
  p_row_style  text    default 'letters',
  p_row_prefix text    default null,
  p_seat_start integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_map     uuid;
  v_event   uuid;
  v_kind    text;
  v_shape   jsonb;
  v_created integer := 0;
  v_removed integer := 0;
  v_clash   record;
  v_style   text := lower(coalesce(p_row_style, 'letters'));
begin
  if p_rows is null or p_per_row is null or p_rows < 1 or p_per_row < 1 then
    raise exception 'INVALID_GRID';
  end if;
  if p_rows > 200 or p_per_row > 200 then
    raise exception 'GRID_TOO_BIG';
  end if;
  if v_style not in ('letters', 'numbers') then
    raise exception 'INVALID_ROW_STYLE';
  end if;
  if char_length(coalesce(p_row_prefix, '')) > 4 then
    raise exception 'ROW_PREFIX_TOO_LONG'
      using hint = 'Predpona radu môže mať najviac 4 znaky.';
  end if;

  select s.venue_map_id, s.kind, s.shape, tt.event_id
    into v_map, v_kind, v_shape, v_event
  from public.venue_sections s
  left join public.ticket_types tt on tt.id = s.ticket_type_id
  where s.id = p_section_id;

  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  if v_kind = 'standing' then
    raise exception 'STANDING_HAS_NO_SEATS'
      using hint = 'Sektor na státie sa predáva na počet vstupeniek. Miesta doň nepatria.';
  end if;

  if v_kind in ('stage', 'bar', 'entrance', 'other') then
    raise exception 'LANDMARK_HAS_NO_SEATS'
      using hint = 'Pódium, bar ani vstup sa nepredávajú — sú na pláne kvôli orientácii.';
  end if;

  if v_event is not null then
    select vs.row_label, count(*) as n into v_clash
    from public.venue_seats vs
    join public.seat_claims(v_event) c on c.seat_id = vs.id
    where vs.venue_section_id = p_section_id
      and not exists (
        select 1 from public.section_seat_grid(
          p_section_id, p_rows, p_per_row, p_start_row, v_style, p_row_prefix, p_seat_start) g
        where g.row_label = vs.row_label and g.seat_number = vs.seat_number
      )
    group by vs.row_label
    order by vs.row_label
    limit 1;

    if found then
      raise exception 'SEATS_IN_USE'
        using hint = 'Rad ' || v_clash.row_label || ' má predané alebo držané miesta. '
                  || 'Zmenši plán tak, aby ostal, alebo tie vstupenky najprv zruš.';
    end if;
  end if;

  delete from public.venue_seats vs
  where vs.venue_section_id = p_section_id
    and not exists (
      select 1 from public.section_seat_grid(
        p_section_id, p_rows, p_per_row, p_start_row, v_style, p_row_prefix, p_seat_start) g
      where g.row_label = vs.row_label and g.seat_number = vs.seat_number
    );
  get diagnostics v_removed = row_count;

  insert into public.venue_seats (venue_section_id, row_label, seat_number, slot)
  select p_section_id, g.row_label, g.seat_number, g.slot
  from public.section_seat_grid(
    p_section_id, p_rows, p_per_row, p_start_row, v_style, p_row_prefix, p_seat_start) g
  on conflict (venue_section_id, row_label, seat_number) do update
    set slot = excluded.slot;
  get diagnostics v_created = row_count;

  -- Rozostup si pamätá sektor. Dopočítavať ho z prvého radu by znamenalo, že
  -- pridanie jedného miesta do radu A posunie celý sektor.
  update public.venue_sections s
  set seat_pitch = case
        when jsonb_typeof(v_shape) = 'array' and jsonb_array_length(v_shape) >= 3
          then public.band_row_length(v_shape, 0.5 / p_rows) / p_per_row
        else s.width / p_per_row
      end
  where s.id = p_section_id;

  return jsonb_build_object(
    'total', (select count(*) from public.venue_seats where venue_section_id = p_section_id),
    'created', v_created,
    'removed', v_removed
  );
end;
$fn$;

revoke execute on function
  public.generate_section_seats(uuid, integer, integer, integer, text, text, integer)
  from public, anon;
grant execute on function
  public.generate_section_seats(uuid, integer, integer, integer, text, text, integer)
  to authenticated;


/**
 * Po prekreslení sektora: čo vypadlo z obrysu, zmizne.
 *
 * Doteraz sa to počítalo cez ohraničenie sektora, nie cez jeho pás — čiže inak,
 * než sa miesta kreslia. Sektor prekreslený do klinu tak mohol miesta nechať
 * tam, kde už nie je tribúna. Teraz sa pýta na ten istý bod, na ktorom miesto
 * stojí.
 *
 * Kúpené a držané miesta prežijú vždy: zmazať miesto, na ktoré niekto má
 * vstupenku, by z plánu urobilo lož.
 */
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
      and not placed.poly @> public.band_point(
            placed.shape,
            0.5 + (placed.slot::numeric / 2) * placed.seat_pitch / w.len,
            placed.v)
      and (v_event is null
           or not exists (select 1 from public.seat_claims(v_event) c where c.seat_id = placed.id))
  )
  delete from public.venue_seats vs using doomed where vs.id = doomed.id;
  get diagnostics v_removed = row_count;

  select count(*) into v_kept from public.venue_seats where venue_section_id = p_section_id;
  return jsonb_build_object('removed', v_removed, 'total', v_kept);
end;
$fn$;

revoke execute on function public.reflow_section_seats(uuid) from public, anon;
grant execute on function public.reflow_section_seats(uuid) to authenticated;


/**
 * Pridať do radu jedno miesto — ručne, keď mriežka nevychádza.
 *
 * Tribúny nie sú pravidelné. Rad býva na jednej strane o sedadlo dlhší, pri
 * schodisku jedno chýba, niekde je medzi nimi vozíkové miesto širšie než
 * ostatné. Mriežka to nemá ako vedieť, tak to musí vedieť organizátor.
 *
 * Miesto pribudne na ďalší bod mriežky za posledným v rade — vľavo alebo
 * vpravo — takže ostatné miesta v rade zostanú presne tam, kde boli, a stĺpce
 * sa nerozídu.
 *
 * Čísla v rade sa potom prečíslujú podľa poradia, aby číslo na vstupenke
 * sedelo s tým, ako sa v rade sedí. Preto to nejde spraviť v rade, kde už má
 * niekto vstupenku: zmeniť mu číslo miesta by znamenalo poslať ho inam.
 */
create or replace function public.add_section_seat(
  p_section_id uuid,
  p_row_label  text,
  p_side       text default 'right'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_map   uuid;
  v_event uuid;
  v_kind  text;
  v_slot  integer;
  v_id    uuid;
  v_n     integer;
begin
  if lower(coalesce(p_side, 'right')) not in ('left', 'right') then
    raise exception 'INVALID_SIDE';
  end if;

  select s.venue_map_id, s.kind, tt.event_id into v_map, v_kind, v_event
  from public.venue_sections s
  left join public.ticket_types tt on tt.id = s.ticket_type_id
  where s.id = p_section_id;

  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  if v_kind = 'standing' then
    raise exception 'STANDING_HAS_NO_SEATS'
      using hint = 'Sektor na státie sa predáva na počet vstupeniek. Miesta doň nepatria.';
  end if;
  if v_kind in ('stage', 'bar', 'entrance', 'other') then
    raise exception 'LANDMARK_HAS_NO_SEATS'
      using hint = 'Pódium, bar ani vstup sa nepredávajú — sú na pláne kvôli orientácii.';
  end if;

  if not exists (select 1 from public.venue_seats
                 where venue_section_id = p_section_id and row_label = p_row_label) then
    raise exception 'ROW_NOT_FOUND'
      using hint = 'Rad ' || coalesce(p_row_label, '?') || ' v tomto sektore nie je.';
  end if;

  if v_event is not null and exists (
    select 1 from public.venue_seats vs
    join public.seat_claims(v_event) c on c.seat_id = vs.id
    where vs.venue_section_id = p_section_id and vs.row_label = p_row_label
  ) then
    raise exception 'SEATS_IN_USE'
      using hint = 'Rad ' || p_row_label || ' má predané alebo držané miesta. '
                || 'Pridaním sa čísla v rade posunú, tak to najprv zruš.';
  end if;

  -- Staré miesta ešte nemajú slot; dopočíta sa z poradia, kým sa niečo zmení.
  update public.venue_seats vs
  set slot = known.slot
  from (
    select id, 2 * row_number() over (order by seat_number)
           - count(*) over () - 1 as slot
    from public.venue_seats
    where venue_section_id = p_section_id and row_label = p_row_label
  ) known
  where vs.id = known.id and vs.slot is null;

  select case when lower(coalesce(p_side, 'right')) = 'left'
              then min(slot) - 2 else max(slot) + 2 end
    into v_slot
  from public.venue_seats
  where venue_section_id = p_section_id and row_label = p_row_label;

  -- Prečíslovanie v dvoch krokoch: čísla v rade sú jedinečné, takže sa najprv
  -- odpracú nahor a až potom sadnú na svoje miesto.
  update public.venue_seats
  set seat_number = seat_number + 10000
  where venue_section_id = p_section_id and row_label = p_row_label;

  insert into public.venue_seats (venue_section_id, row_label, seat_number, slot)
  values (p_section_id, p_row_label, 9999, v_slot)
  returning id into v_id;

  update public.venue_seats vs
  set seat_number = ordered.n
  from (
    select id, row_number() over (order by slot)::integer as n
    from public.venue_seats
    where venue_section_id = p_section_id and row_label = p_row_label
  ) ordered
  where vs.id = ordered.id;

  select seat_number into v_n from public.venue_seats where id = v_id;

  return jsonb_build_object(
    'seat_id', v_id,
    'row', p_row_label,
    'number', v_n,
    'slot', v_slot,
    'total', (select count(*) from public.venue_seats
              where venue_section_id = p_section_id and row_label = p_row_label)
  );
end;
$fn$;

revoke execute on function public.add_section_seat(uuid, text, text) from public, anon;
grant execute on function public.add_section_seat(uuid, text, text) to authenticated;


-- Ubrať miesto netreba osobitne: na to je delete_seats, ktoré už existuje a
-- ostatným miestam v rade nechá ich čísla. Sedadlo, ktoré v hale nie je, nemá
-- prečíslovať tie, ktoré tam sú — človek s lístkom na číslo 12 na ňom sedí
-- ďalej.



/**
 * Miesta sektora — teraz aj s bodom mriežky, na ktorom stoja.
 *
 * Bez neho by si appka polohu musela dopočítať z poradia a počtu miest v rade,
 * a to je presne to, čo prestane platiť, keď do radu niekto jedno pridá.
 */
create or replace function public.section_seats(p_event_id uuid, p_section_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with claims as (
    select
      c.seat_id,
      bool_or(c.claimed_by is not distinct from auth.uid() and auth.uid() is not null) as is_mine,
      -- 'held' < 'ordered' < 'sold' alphabetically, which is also weakest to
      -- strongest. Luck rather than design, so: max() picks the strongest claim
      -- and renaming one of those three strings breaks it.
      max(case when c.claimed_by is not distinct from auth.uid() and auth.uid() is not null
               then c.claim end) as mine_claim,
      max(case when c.claimed_by is not distinct from auth.uid() and auth.uid() is not null
               then c.hold_until end) as mine_until
    from public.seat_claims(p_event_id) c
    group by c.seat_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', vs.id,
    'row', vs.row_label,
    'number', vs.seat_number,
    'row_index', vs.row_index,
    'slot', vs.slot,
    'sellable', vs.is_sellable,
    'kind', vs.kind,
    'note', vs.note,
    'mine', coalesce(cl.is_mine, false),
    'mine_claim', cl.mine_claim,
    'hold_until', cl.mine_until,
    'taken', cl.seat_id is not null and not coalesce(cl.is_mine, false),
    'free', vs.is_sellable and cl.seat_id is null
  ) order by vs.row_label, vs.seat_number), '[]'::jsonb)
  from (
    select v.*, dense_rank() over (order by v.row_label) - 1 as row_index
    from public.venue_seats v
    where v.venue_section_id = p_section_id
  ) vs
  left join claims cl on cl.seat_id = vs.id;
$function$;



/**
 * Plán pre kupujúceho — a k nemu rozostup miest v sektore.
 *
 * Rozostup je vlastnosť sektora, nie prvého radu: dopočítavať ho z prvého radu
 * znamená, že pridanie jedného miesta doň posunie celý sektor.
 */
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
