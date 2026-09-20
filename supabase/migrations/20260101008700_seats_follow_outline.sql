-- ============================================================================
-- Miesta kopírujú obrys sektora, nie jeho ohraničenie
-- ============================================================================
-- Doteraz sa mriežka rady × miesta položila cez ohraničenie sektora a orezala
-- sa tvarom. Pre tribúnu, ktorá stojí vodorovne, to vyzeralo dobre. Pre bočnú
-- tribúnu nie: rady jej viedli naprieč, nie pozdĺž, takže miesta stáli v radoch
-- kolmo na to, ako sa v hale naozaj sedí. A z rohovej sa stal pás.
--
-- Sektor je pás: dve dlhé hrany — pri ihrisku a vzadu — a dva krátke konce.
-- Rad ide POZDĹŽ neho, číslo radu sa počíta NAPRIEČ. Z toho vyplynie samo, že
-- bočnej tribúne idú rady zvislo, rohovej sa zatáčajú a predný rad výseče je
-- kratší než zadný — bez toho, aby ktorýkoľvek z nich bol zvláštny prípad.
--
-- Obrys sa kreslí po obvode — tak ho kreslí editor aj predlohy — takže jeho
-- prvá polovica je jedna dlhá hrana a druhá polovica je tá druhá, odzadu.
-- To je celý dohovor a appka kreslí miesta presne podľa neho.
--
-- Orezanie tvarom zostáva ako poistka: pri páse nevypadne nič, ale pri
-- podivnom obryse (L, sektor s dierou) sa miesto mimo plochy nevytvorí.
-- ============================================================================

/**
 * Bod na páse sektora.
 *
 * u ide 0..1 pozdĺž pásu, v ide 0..1 naprieč ním — 0 je prvá polovica obrysu.
 * Vracia súradnice v zlomkoch plánu, rovnako ako všetko ostatné.
 */
create or replace function public.band_point(p_shape jsonb, u numeric, v numeric)
returns point
language plpgsql
immutable
set search_path = public, extensions
as $fn$
declare
  n     integer;
  half  integer;
  fx numeric; fy numeric;   -- bod na prvej dlhej hrane
  sx numeric; sy numeric;   -- bod na druhej
  ax numeric; ay numeric;
  cx numeric; cy numeric;
  i  integer;
  f  numeric;
  t  numeric;
begin
  n := jsonb_array_length(p_shape);
  if n is null or n < 3 then
    return null;
  end if;
  half := greatest(2, n / 2);

  -- prvá hrana: body 0 .. half-1, zľava doprava
  t := least(0.999999, greatest(0, u)) * (half - 1);
  i := floor(t)::integer;
  f := t - i;
  ax := (p_shape -> i ->> 'x')::numeric;
  ay := (p_shape -> i ->> 'y')::numeric;
  cx := (p_shape -> least(half - 1, i + 1) ->> 'x')::numeric;
  cy := (p_shape -> least(half - 1, i + 1) ->> 'y')::numeric;
  fx := ax + (cx - ax) * f;
  fy := ay + (cy - ay) * f;

  -- druhá hrana: body n-1 .. half, teda odzadu, aby šla tým istým smerom
  if n - half < 1 then
    sx := fx;
    sy := fy;
  elsif n - half = 1 then
    sx := (p_shape -> half ->> 'x')::numeric;
    sy := (p_shape -> half ->> 'y')::numeric;
  else
    t := least(0.999999, greatest(0, u)) * (n - half - 1);
    i := floor(t)::integer;
    f := t - i;
    ax := (p_shape -> (n - 1 - i) ->> 'x')::numeric;
    ay := (p_shape -> (n - 1 - i) ->> 'y')::numeric;
    cx := (p_shape -> (n - 1 - least(n - half - 1, i + 1)) ->> 'x')::numeric;
    cy := (p_shape -> (n - 1 - least(n - half - 1, i + 1)) ->> 'y')::numeric;
    sx := ax + (cx - ax) * f;
    sy := ay + (cy - ay) * f;
  end if;

  return point((fx + (sx - fx) * v)::float8, (fy + (sy - fy) * v)::float8);
end;
$fn$;

grant execute on function public.band_point(jsonb, numeric, numeric) to anon, authenticated;


/**
 * Ktoré bunky mriežky sú v sektore naozaj miestom.
 *
 * Obdĺžnikový sektor: mriežka cez celú plochu, ako doteraz.
 * Nakreslený sektor: mriežka položená na jeho pás — a ponechá sa bunka, ktorej
 * bod leží vnútri obrysu. Pri páse to platí pre všetky; pri podivnom obryse to
 * odfiltruje tie, ktoré by stáli mimo.
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
  grid as (
    select r,
           n::integer as n,
           (n - greatest(coalesce(p_seat_start, 1), 1) + 0.5) / p_per_row as u,
           (r + 0.5) / p_rows as v
    from generate_series(0, p_rows - 1) r,
         generate_series(greatest(coalesce(p_seat_start, 1), 1),
                         greatest(coalesce(p_seat_start, 1), 1) + p_per_row - 1) n
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
