-- ============================================================================
-- Širší rad má viac miest, nie tie isté ďalej od seba
-- ============================================================================
-- Mriežka rady × miesta dávala každému radu rovnaký počet miest. V sektore,
-- ktorý sa rozširuje — a to je väčšina tribún — to znamená, že zadný rad mal
-- tých istých štrnásť miest, len roztiahnutých. Tak sa tribúna nestavia.
-- Sedadlo má svoju šírku a susedia od seba stálu vzdialenosť; do radu, ktorý
-- je o polovicu dlhší, sa ich zmestí o polovicu viac.
--
-- Rozostup teda udáva rad A a každý ďalší rad má toľko miest, koľko sa ich
-- pri tom rozostupe doň zmestí. Rozostup zostáva ten istý — čo sa do radu
-- nezmestí celé, zostane okrajom na oboch koncoch rovnako. Rozdeliť rad jeho
-- vlastným počtom miest by ho roztiahlo: rozostup by v každom rade vyšiel o
-- kúsok iný, stĺpce by sa rozišli a medzi miestami by boli vidieť medzery.
--
-- Aby to sedelo s tým, čo appka kreslí, musí sa pás merať rovnako na oboch
-- stranách. Doteraz sa po hranách obrysu chodilo po bodoch, nie po
-- vzdialenosti: pri predlohe, ktorej body sú rozložené pravidelne, je to to
-- isté, pri obryse naklikanom v editore nie. A pri krátkom naklikanom obryse
-- sa delenie na dve hrany hľadá, nie berie v polovici zoznamu — pri tvare L
-- padlo doprostred dlhšej strany.
-- ============================================================================

/**
 * Kde sa obrys delí na dve dlhé hrany pásu.
 *
 * Predloha kreslí obrys sama a delí ho presne v polovici bodov. Človek klepne
 * rohy, kde chce, a v polovici zoznamu nemusí byť koniec hrany — preto sa pri
 * krátkom obryse hľadá delenie, pri ktorom sú obe hrany najviac rovnako dlhé.
 * To je presne to, čo pás znamená.
 */
create or replace function public.band_split(p_shape jsonb)
returns integer
language plpgsql
immutable
set search_path = public, extensions
as $fn$
declare
  n    integer;
  half integer;
  k    integer;
  a    numeric;
  b    numeric;
  gap  numeric;
  best integer;
  best_gap numeric;
begin
  n := jsonb_array_length(p_shape);
  if n is null or n < 3 then
    return 2;
  end if;
  half := greatest(2, n / 2);
  if n < 4 or n > 12 then
    return half;
  end if;

  best := half;
  best_gap := null;
  for k in 2 .. n - 2 loop
    a := public.chain_length(p_shape, 0, k - 1);
    b := public.chain_length(p_shape, k, n - 1);
    gap := abs(a - b);
    if best_gap is null or gap < best_gap then
      best_gap := gap;
      best := k;
    end if;
  end loop;
  return best;
end;
$fn$;

/** Dĺžka časti obrysu od bodu p_from po bod p_to, po poradí. */
create or replace function public.chain_length(p_shape jsonb, p_from integer, p_to integer)
returns numeric
language plpgsql
immutable
set search_path = public, extensions
as $fn$
declare
  i     integer;
  total numeric := 0;
  ax numeric; ay numeric; bx numeric; by_ numeric;
begin
  if p_to <= p_from then
    return 0;
  end if;
  for i in p_from .. p_to - 1 loop
    ax := (p_shape -> i ->> 'x')::numeric;
    ay := (p_shape -> i ->> 'y')::numeric;
    bx := (p_shape -> (i + 1) ->> 'x')::numeric;
    by_ := (p_shape -> (i + 1) ->> 'y')::numeric;
    total := total + sqrt((bx - ax) ^ 2 + (by_ - ay) ^ 2);
  end loop;
  return total;
end;
$fn$;

/**
 * Bod v zlomku u DĹŽKY hrany obrysu — nie v zlomku počtu jej bodov.
 *
 * Chodiť po lomenej čiare po bodoch nie je to isté ako chodiť po nej po
 * vzdialenosti: kde sú dva body blízko, chôdza sa vlečie, kde sú ďaleko,
 * skáče. Miesta rozložené tak sa v rade zhŕkli a rozostúpili.
 *
 * p_first a p_last sú indexy v obryse; keď je p_last menšie, ide sa odzadu.
 */
create or replace function public.edge_point(
  p_shape jsonb, p_first integer, p_last integer, u numeric)
returns point
language plpgsql
immutable
set search_path = public, extensions
as $fn$
declare
  step  integer;
  i     integer;
  total numeric := 0;
  want  numeric;
  run   numeric := 0;
  seg   numeric;
  ax numeric; ay numeric; bx numeric; by_ numeric;
  f numeric;
begin
  if p_first = p_last then
    return point(((p_shape -> p_first ->> 'x')::numeric)::float8,
                 ((p_shape -> p_first ->> 'y')::numeric)::float8);
  end if;
  step := case when p_last > p_first then 1 else -1 end;

  i := p_first;
  while i <> p_last loop
    ax := (p_shape -> i ->> 'x')::numeric;
    ay := (p_shape -> i ->> 'y')::numeric;
    bx := (p_shape -> (i + step) ->> 'x')::numeric;
    by_ := (p_shape -> (i + step) ->> 'y')::numeric;
    total := total + sqrt((bx - ax) ^ 2 + (by_ - ay) ^ 2);
    i := i + step;
  end loop;

  if total <= 0 then
    return point(((p_shape -> p_first ->> 'x')::numeric)::float8,
                 ((p_shape -> p_first ->> 'y')::numeric)::float8);
  end if;
  want := least(1, greatest(0, u)) * total;

  i := p_first;
  while i <> p_last loop
    ax := (p_shape -> i ->> 'x')::numeric;
    ay := (p_shape -> i ->> 'y')::numeric;
    bx := (p_shape -> (i + step) ->> 'x')::numeric;
    by_ := (p_shape -> (i + step) ->> 'y')::numeric;
    seg := sqrt((bx - ax) ^ 2 + (by_ - ay) ^ 2);
    if run + seg >= want or i + step = p_last then
      f := case when seg <= 0 then 0 else least(1, (want - run) / seg) end;
      return point((ax + (bx - ax) * f)::float8, (ay + (by_ - ay) * f)::float8);
    end if;
    run := run + seg;
    i := i + step;
  end loop;

  return point(((p_shape -> p_last ->> 'x')::numeric)::float8,
               ((p_shape -> p_last ->> 'y')::numeric)::float8);
end;
$fn$;

/**
 * Bod na páse sektora.
 *
 * u ide 0..1 pozdĺž pásu, v ide 0..1 naprieč ním — 0 je prvá dlhá hrana.
 * Obe hrany sa prechádzajú po vzdialenosti, rovnako ako ich prechádza appka.
 */
create or replace function public.band_point(p_shape jsonb, u numeric, v numeric)
returns point
language plpgsql
immutable
set search_path = public, extensions
as $fn$
declare
  n    integer;
  half integer;
  a    point;
  b    point;
begin
  n := jsonb_array_length(p_shape);
  if n is null or n < 3 then
    return null;
  end if;
  half := public.band_split(p_shape);

  a := public.edge_point(p_shape, 0, half - 1, u);
  if n - half < 1 then
    b := a;
  else
    b := public.edge_point(p_shape, n - 1, half, u);
  end if;

  return point((a[0] + (b[0] - a[0]) * v)::float8,
               (a[1] + (b[1] - a[1]) * v)::float8);
end;
$fn$;

/** Ako dlhý je rad v hĺbke v — v zlomkoch plánu. */
create or replace function public.band_row_length(p_shape jsonb, v numeric)
returns numeric
language plpgsql
immutable
set search_path = public, extensions
as $fn$
declare
  i     integer;
  total numeric := 0;
  prev  point;
  here  point;
begin
  prev := public.band_point(p_shape, 0, v);
  if prev is null then
    return 0;
  end if;
  for i in 1 .. 64 loop
    here := public.band_point(p_shape, i::numeric / 64, v);
    total := total + sqrt((here[0] - prev[0]) ^ 2 + (here[1] - prev[1]) ^ 2);
    prev := here;
  end loop;
  return total;
end;
$fn$;

grant execute on function public.band_split(jsonb) to anon, authenticated;
grant execute on function public.chain_length(jsonb, integer, integer) to anon, authenticated;
grant execute on function public.edge_point(jsonb, integer, integer, numeric) to anon, authenticated;
grant execute on function public.band_point(jsonb, numeric, numeric) to anon, authenticated;
grant execute on function public.band_row_length(jsonb, numeric) to anon, authenticated;


/**
 * Ktoré miesta v sektore existujú.
 *
 * Obdĺžnikový sektor: mriežka cez celú plochu, každý rad rovnako široký.
 *
 * Nakreslený sektor: rozostup udá rad A — toľko miest, koľko si organizátor
 * vypýtal — a každý ďalší rad dostane toľko miest, koľko sa ich doň pri tom
 * rozostupe zmestí. Počet je zastropovaný na štvornásobok vypýtaného, aby
 * sektor zbiehajúci sa do špica nevyrobil tisíce miest v zadnom rade.
 *
 * Orezanie tvarom zostáva ako poistka: pri páse nevypadne nič, pri podivnom
 * obryse (L, sektor s dierou) sa miesto mimo plochy nevytvorí.
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
    select case when p_per_row > 0 then (select len from lens where r = 0) / p_per_row end as step
  ),
  counts as (
    -- Koľko celých rozostupov sa do radu zmestí. Nie zaokrúhlene: zaokrúhlene
    -- by posledné miesto vytŕčalo z okraja, a hlavne by sa rozostup v každom
    -- rade o kúsok líšil — a to je presne tá medzera, ktorú vidno.
    select lens.r,
           case
             when lens.len is null or pitch.step is null or pitch.step <= 0 then p_per_row
             else least(p_per_row * 4,
                        greatest(1, floor(lens.len / pitch.step + 0.000000001)::integer))
           end as per,
           lens.len,
           pitch.step
    from lens, pitch
  ),
  grid as (
    -- Rozostup je pevný; čo do radu nevyjde, zostane okrajom na oboch
    -- koncoch rovnako. Rady tak držia stĺpce a medzi miestami je všade to
    -- isté, nech je rad akokoľvek dlhý.
    select counts.r,
           n::integer as n,
           case
             when counts.len is null or counts.len <= 0 or counts.step is null
               then (n - greatest(coalesce(p_seat_start, 1), 1) + 0.5) / counts.per
             else ((counts.len - counts.per * counts.step) / 2
                   + (n - greatest(coalesce(p_seat_start, 1), 1) + 0.5) * counts.step)
                  / counts.len
           end as u,
           (counts.r + 0.5)::numeric / p_rows as v
    from counts,
         generate_series(greatest(coalesce(p_seat_start, 1), 1),
                         greatest(coalesce(p_seat_start, 1), 1) + counts.per - 1) n
  )
  select public.seat_row_name(p_start_row + grid.r, coalesce(p_row_style, 'letters'), p_row_prefix),
         grid.n
  from grid, sec
  where sec.poly is null
     or sec.poly @> public.band_point(sec.shape, grid.u, grid.v);
$fn$;

grant execute on function
  public.section_seat_grid(uuid, integer, integer, integer, text, text, integer)
  to authenticated;
