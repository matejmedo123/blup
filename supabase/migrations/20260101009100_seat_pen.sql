-- ============================================================================
-- Miesto sa dá pridať aj tam, kam ukážeš
-- ============================================================================
-- Pridávať miesta len na koniec radu je málo. Tribúna, ktorá nevychádza,
-- nevychádza obvykle niekde vnútri: pri schodisku chýba jedno miesto, v strede
-- radu je vozíkové miesto za dve, jeden rad je odsadený. Organizátor to vidí
-- na pláne a chce tam ukázať.
--
-- Funkcia preto berie aj konkrétny bod mriežky. Rad sa potom prečísluje podľa
-- poradia — inak by číslo na vstupenke nesedelo s tým, ako sa v rade sedí — a
-- to sa nesmie stať v rade, kde už niekto vstupenku má. Keď ale miesto pribudne
-- ZA posledné v rade, žiadne číslo sa nemení a rad môže pokojne bežať v predaji.
-- ============================================================================

create or replace function public.add_section_seat(
  p_section_id uuid,
  p_row_label  text,
  p_side       text    default 'right',
  p_slot       integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_map    uuid;
  v_event  uuid;
  v_kind   text;
  v_slot   integer;
  v_max    integer;
  v_shifts boolean;
  v_id     uuid;
  v_n      integer;
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

  -- Staré miesta ešte nemajú bod mriežky; dopočíta sa z poradia.
  update public.venue_seats vs
  set slot = known.slot
  from (
    select id, 2 * row_number() over (order by seat_number)
           - count(*) over () - 1 as slot
    from public.venue_seats
    where venue_section_id = p_section_id and row_label = p_row_label
  ) known
  where vs.id = known.id and vs.slot is null;

  select max(slot) into v_max
  from public.venue_seats
  where venue_section_id = p_section_id and row_label = p_row_label;

  if p_slot is null then
    select case when lower(coalesce(p_side, 'right')) = 'left'
                then min(slot) - 2 else max(slot) + 2 end
      into v_slot
    from public.venue_seats
    where venue_section_id = p_section_id and row_label = p_row_label;
  else
    v_slot := p_slot;
    if exists (select 1 from public.venue_seats
               where venue_section_id = p_section_id
                 and row_label = p_row_label and slot = v_slot) then
      raise exception 'SLOT_TAKEN'
        using hint = 'Na tomto mieste už miesto je.';
    end if;
  end if;

  -- Čísla sa posunú len vtedy, keď miesto nepribúda za posledné v rade.
  v_shifts := v_slot < v_max;

  if v_shifts and v_event is not null and exists (
    select 1 from public.venue_seats vs
    join public.seat_claims(v_event) c on c.seat_id = vs.id
    where vs.venue_section_id = p_section_id and vs.row_label = p_row_label
  ) then
    raise exception 'SEATS_IN_USE'
      using hint = 'Rad ' || p_row_label || ' má predané alebo držané miesta. '
                || 'Miesto vnútri radu by im posunulo čísla — pridaj ho na koniec '
                || 'alebo tie vstupenky najprv zruš.';
  end if;

  if v_shifts then
    -- Prečíslovanie v dvoch krokoch: čísla v rade sú jedinečné.
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
  else
    insert into public.venue_seats (venue_section_id, row_label, seat_number, slot)
    values (p_section_id, p_row_label,
            (select max(seat_number) + 1 from public.venue_seats
             where venue_section_id = p_section_id and row_label = p_row_label),
            v_slot)
    returning id into v_id;
  end if;

  select seat_number into v_n from public.venue_seats where id = v_id;

  return jsonb_build_object(
    'seat_id', v_id,
    'row', p_row_label,
    'number', v_n,
    'slot', v_slot,
    'renumbered', v_shifts,
    'total', (select count(*) from public.venue_seats
              where venue_section_id = p_section_id and row_label = p_row_label)
  );
end;
$fn$;

drop function if exists public.add_section_seat(uuid, text, text);

revoke execute on function public.add_section_seat(uuid, text, text, integer) from public, anon;
grant execute on function public.add_section_seat(uuid, text, text, integer) to authenticated;
