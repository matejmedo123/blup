-- ============================================================================
-- Sektor na státie sa predáva na počet, nie po sedadlách
-- ============================================================================
-- Státie pred pódiom je plocha, nie rad stoličiek. Doteraz sa doň dali
-- vygenerovať miesta — mriežka rady × miesta ako do hľadiska — a kupujúci
-- potom vyberal „rad C, miesto 14" na mieste, kde sa stojí. Číslo na
-- vstupenke, ktoré v hale nikde nie je, je horšie než žiadne: človek ho
-- pri vstupe hľadá.
--
-- Pravidlo je odteraz v databáze, nie v obrazovke:
--   * generate_section_seats sektor na státie odmietne
--   * apply_venue_preset mu miesta negeneruje
--   * a trigger nepustí miesta do sektora na státie ani priamo cez PostgREST
--
-- Sektor bez miest appka sama predáva na počet (`numbered` je odvodené od
-- toho, či nejaké miesta má), takže na fronte netreba meniť nič.
--
-- Prepnúť už zasadený sektor na státie ide len vtedy, keď v ňom miesta nie sú.
-- Inak by sa ticho zahodili sedadlá, na ktoré niekto môže mať vstupenku.
-- ============================================================================

create or replace function public.forbid_seats_in_standing()
returns trigger
language plpgsql
set search_path = public, extensions
as $fn$
declare
  v_kind text;
  v_name text;
begin
  select kind, name into v_kind, v_name
  from public.venue_sections where id = new.venue_section_id;

  if v_kind = 'standing' then
    raise exception 'STANDING_HAS_NO_SEATS'
      using hint = 'Sektor „' || coalesce(v_name, '?') || '" je na státie — predáva sa na počet vstupeniek, '
                || 'nie po sedadlách. Keď má mať sedadlá, zmeň mu typ na sedenie.';
  end if;

  return new;
end;
$fn$;

drop trigger if exists venue_seats_not_in_standing on public.venue_seats;
create trigger venue_seats_not_in_standing
  before insert or update of venue_section_id on public.venue_seats
  for each row execute function public.forbid_seats_in_standing();


-- Druhá strana toho istého pravidla: sektor sa nesmie prepnúť na státie,
-- keď v ňom miesta sú.
create or replace function public.forbid_standing_with_seats()
returns trigger
language plpgsql
set search_path = public, extensions
as $fn$
begin
  if new.kind = 'standing' and coalesce(old.kind, '') <> 'standing'
     and exists (select 1 from public.venue_seats where venue_section_id = new.id) then
    raise exception 'SECTION_HAS_SEATS'
      using hint = 'Tento sektor má vygenerované miesta. Najprv ich zmaž, potom ho prepni na státie.';
  end if;
  return new;
end;
$fn$;

drop trigger if exists venue_sections_standing_is_empty on public.venue_sections;
create trigger venue_sections_standing_is_empty
  before update of kind on public.venue_sections
  for each row execute function public.forbid_standing_with_seats();


-- A jasná hláška skôr, než sa o to trigger vôbec obtrie.
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

  -- Orientačný bod sa nepredáva vôbec, tak ani nemá čo mať sedadlá.
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
