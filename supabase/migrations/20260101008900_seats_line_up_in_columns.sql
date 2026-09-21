-- ============================================================================
-- Stĺpce sedia v jednej línii
-- ============================================================================
-- Rozostup už bol pevný a do širšieho radu pribudli miesta. Rad sa ale
-- vycentroval na stred sektora, a to je presne o pol rozostupu vedľa: keď má
-- jeden rad štrnásť miest a ten nad ním trinásť, ich stredy sedia, ale samotné
-- miesta sú navzájom posunuté o polovicu. Stĺpce sa tak kľukatia a medzi
-- miestami to vyzerá ako nepravidelné medzery.
--
-- Miesta teda nesadajú kamkoľvek, ale na mriežku: pevné body vzdialené o
-- rozostup, spoločné pre celý sektor. Rad dostane tie body, ktoré sa doň
-- zmestia. Stĺpce potom idú rovno naprieč sektorom a rad, ktorý je širší,
-- jednoducho siahne o bod ďalej na obe strany.
--
-- Mriežka má dve podoby podľa toho, koľko miest si organizátor vypýtal do radu
-- A: párny počet znamená body po oboch stranách stredu, nepárny znamená jeden
-- bod presne v strede. Vďaka tomu zostane počet miest v každom rade rovnakej
-- parity a rady pribúdajú po dvoch — symetricky, tak ako sa tribúna rozširuje.
-- ============================================================================

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
    -- Rozostup udáva rad A: toľko miest, koľko si organizátor vypýtal.
    select case when p_per_row > 0 then (select len from lens where r = 0) / p_per_row end as step
  ),
  counts as (
    -- Koľko bodov mriežky sa do radu zmestí. Mriežka je súmerná okolo stredu
    -- radu, takže sa počíta polovica a zdvojnásobí — pri nepárnom počte plus
    -- ten jeden bod v strede. Počet tak zostane rovnakej parity vo všetkých
    -- radoch a stĺpce si sadnú na seba.
    select lens.r,
           lens.len,
           pitch.step,
           case
             when lens.len is null or pitch.step is null or pitch.step <= 0 then p_per_row
             -- Rad užší než jedno sedadlo nedostane žiadne. Je to klin
             -- dobiehajúci do špica a vtlačiť doň miesto by znamenalo predať
             -- vstupenku na sedadlo, ktoré tam nie je.
             when lens.len < pitch.step then 0
             -- Miesto potrebuje celý rozostup, nie polovicu. Zaokrúhlene nahor
             -- vyšlo posledné miesto stredom presne na okraj sektora, čiže
             -- polovicou von — a na pláne to vyzerá ako sedadlo mimo tribúny.
             -- Nadol sa jeho stred zastaví aspoň pol rozostupu pred okrajom a
             -- celé sedadlo zostane vnútri.
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
    -- Miesto k sedí na mriežke: (k - (počet+1)/2) rozostupov od stredu radu.
    -- Pri párnom počte to vychádza na pol rozostupu od stredu, pri nepárnom
    -- presne naň — a v oboch prípadoch na tie isté body vo všetkých radoch.
    select counts.r,
           n::integer as n,
           case
             when counts.len is null or counts.len <= 0 or counts.step is null
               then (n - greatest(coalesce(p_seat_start, 1), 1) + 0.5) / counts.per
             else 0.5 + (n - greatest(coalesce(p_seat_start, 1), 1) + 1
                         - (counts.per + 1)::numeric / 2) * counts.step / counts.len
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
