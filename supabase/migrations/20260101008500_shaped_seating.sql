-- ============================================================================
-- Miesta sa prispôsobia tvaru sektora
-- ============================================================================
-- Sektor sa dal nakresliť ako zatáčajúca sa tribúna, ale miesta do neho padali
-- ako do obdĺžnika: mriežka rady × miesta cez celé ohraničenie. Na tribúne,
-- ktorá sa zatáča, to znamená sedadlá v rohoch, kde v hale nie je nič — a
-- kupujúci si kúpi miesto, ktoré neexistuje.
--
-- Po novom sa mriežka oreže tvarom: bunka, ktorej stred leží mimo nakreslenej
-- plochy, sa nevytvorí. Sektor bez tvaru sa správa presne ako doteraz.
--
-- Čísla miest si držia svoj stĺpec v mriežke. Rad tak môže začínať číslom 4 a
-- to je správne: číslo miesta je poloha v sektore, a keď sa prvé tri miesta
-- v hale nenachádzajú, nemá ich čím nahradiť. Kto chce súvislé číslovanie,
-- premenuje si rad v editore.
-- ============================================================================

/**
 * Nakreslený tvar ako polygón, s ktorým vie Postgres počítať.
 *
 * Postgres nevie postaviť polygón z poľa bodov — `polygon(point[])` neexistuje
 * a zistí sa to až pri spustení migrácie. Ide to cez textový literál, čo je
 * škaredé, ale je to jediná cesta, ktorá funguje aj v indexovateľnom výraze.
 *
 * Null pre sektor bez tvaru alebo s menej než tromi bodmi — volajúci to berie
 * ako „obyčajný obdĺžnik".
 */
create or replace function public.jsonb_to_polygon(p_shape jsonb)
returns polygon
language sql
immutable
set search_path = public, extensions
as $fn$
  select case
    when jsonb_typeof(p_shape) = 'array' and jsonb_array_length(p_shape) >= 3
    then (
      select ('(' || string_agg(
                format('(%s,%s)', (p ->> 'x')::numeric, (p ->> 'y')::numeric),
                ',' order by o) || ')')::polygon
      from jsonb_array_elements(p_shape) with ordinality t(p, o)
    )
  end;
$fn$;

grant execute on function public.jsonb_to_polygon(jsonb) to anon, authenticated;


/**
 * Ktoré bunky mriežky sú v sektore naozaj miestom.
 *
 * Vlastná funkcia preto, že generate_section_seats sa tú istú množinu pýta
 * trikrát — či sa niekomu neruší kúpené miesto, čo zmazať, čo vytvoriť. Keby
 * bola tá podmienka napísaná trikrát, raz by sa opravila a dvakrát nie.
 */
create or replace function public.section_seat_grid(
  p_section_id uuid,
  p_rows       integer,
  p_per_row    integer,
  p_start_row  integer default 0,
  p_row_style  text    default 'letters',
  p_row_prefix text    default null,
  p_seat_start integer default 1
)
returns table (row_label text, seat_number integer)
language sql
stable
set search_path = public, extensions
as $fn$
  with sec as (
    select s.x, s.y, s.width, s.height, s.shape,
           public.jsonb_to_polygon(s.shape) as poly
    from public.venue_sections s
    where s.id = p_section_id
  )
  select public.seat_row_name(p_start_row + r, coalesce(p_row_style, 'letters'), p_row_prefix),
         n::integer
  from sec,
       generate_series(0, p_rows - 1) r,
       generate_series(greatest(coalesce(p_seat_start, 1), 1),
                       greatest(coalesce(p_seat_start, 1), 1) + p_per_row - 1) n
  where sec.poly is null
     -- Stred bunky v súradniciach plánu. Mriežka sa kreslí presne takto aj na
     -- obrazovke, takže to, čo test povolí, je to, čo je vidieť.
     or sec.poly @> point(
          (sec.x + sec.width  * ((n - greatest(coalesce(p_seat_start, 1), 1) + 0.5) / p_per_row))::float8,
          (sec.y + sec.height * ((r + 0.5) / p_rows))::float8
        );
$fn$;

grant execute on function
  public.section_seat_grid(uuid, integer, integer, integer, text, text, integer)
  to authenticated;


/**
 * Vygeneruje miesta v sektore — po novom podľa toho, čo je nakreslené.
 *
 * Zvyšok sa nemení: predané a držané miesta sa nikdy nezmažú, a keď by ich
 * nový rozmer zahodil, funkcia radšej odmietne celú zmenu, než by niekoho
 * pripravila o sedadlo.
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

  select s.venue_map_id, tt.event_id into v_map, v_event
  from public.venue_sections s
  left join public.ticket_types tt on tt.id = s.ticket_type_id
  where s.id = p_section_id;

  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  -- Príde o miesto niekto? Pýtame sa skôr, než sa čokoľvek dotkne, takže
  -- odmietnutie nechá sektor presne tak, ako ho organizátor nechal.
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

  insert into public.venue_seats (venue_section_id, row_label, seat_number)
  select p_section_id, g.row_label, g.seat_number
  from public.section_seat_grid(
    p_section_id, p_rows, p_per_row, p_start_row, v_style, p_row_prefix, p_seat_start) g
  on conflict (venue_section_id, row_label, seat_number) do nothing;
  get diagnostics v_created = row_count;

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


-- ---------------------------------------------------------------------------
-- Prekreslenie tvaru prekreslí aj miesta
-- ---------------------------------------------------------------------------
-- Inak by sektor zmenil tvar a miesta by zostali tam, kde boli — plocha by
-- hovorila jedno a sedadlá druhé. Miesta, ktoré niekto drží alebo má kúpené,
-- sa nerušia nikdy: tie zostanú aj mimo novej plochy a organizátor to uvidí.
-- ---------------------------------------------------------------------------
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
    select s.x, s.y, s.width, s.height,
           public.jsonb_to_polygon(s.shape) as poly,
           (select max(vs.seat_number) from public.venue_seats vs where vs.venue_section_id = s.id) as wide,
           (select count(distinct vs.row_label) from public.venue_seats vs where vs.venue_section_id = s.id) as tall
    from public.venue_sections s
    where s.id = p_section_id
      and jsonb_typeof(s.shape) = 'array'
      and jsonb_array_length(s.shape) >= 3
  ),
  ranked as (
    select vs.id,
           dense_rank() over (order by vs.row_label) - 1 as r,
           vs.seat_number as n
    from public.venue_seats vs
    where vs.venue_section_id = p_section_id
  ),
  doomed as (
    select ranked.id
    from ranked, sec
    where sec.wide > 0 and sec.tall > 0
      and not sec.poly @> point(
        (sec.x + sec.width  * ((ranked.n - 0.5) / sec.wide))::float8,
        (sec.y + sec.height * ((ranked.r + 0.5) / sec.tall))::float8)
      -- Kúpené a držané miesta prežijú vždy.
      and (v_event is null
           or not exists (select 1 from public.seat_claims(v_event) c where c.seat_id = ranked.id))
  )
  delete from public.venue_seats vs using doomed where vs.id = doomed.id;
  get diagnostics v_removed = row_count;

  select count(*) into v_kept from public.venue_seats where venue_section_id = p_section_id;
  return jsonb_build_object('removed', v_removed, 'total', v_kept);
end;
$fn$;

revoke execute on function public.reflow_section_seats(uuid) from public, anon;
grant execute on function public.reflow_section_seats(uuid) to authenticated;
