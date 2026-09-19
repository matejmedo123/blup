-- ============================================================================
-- Kreslenie plánu: podklad, otáčanie, kopírovanie, mazanie miest, vlastné názvy
--
-- Šesť vecí z jedného hlásenia, všetky o tej istej obrazovke.
--
-- 1. Obrázok haly je PODKLAD, podľa ktorého sa kreslí — nie plán, ktorý sa
--    ukáže kupujúcim. Doteraz sa nahrával a potom sa zobrazoval ďalej.
-- 2. Sektory sa dajú otáčať. Tribúna býva šikmo a obdĺžnik na osi s tým nič
--    nespraví.
-- 3. Sektor sa dá skopírovať aj s veľkosťou a s rozložením miest — štadión má
--    štyri rovnaké tribúny, nie štyri rôzne.
-- 4. Jednotlivé miesta sa dajú zmazať. V strede býva stĺp a to miesto naozaj
--    neexistuje.
-- 5. Rady a miesta sa dajú pomenovať tak, ako sú v hale: rad 1 namiesto A,
--    miesta od 101, prefix pred radom.
-- 6. A premenovať rad dodatočne, bez toho, aby sa stratili predané vstupenky.
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Podklad, nie plán
-- ---------------------------------------------------------------------------
-- Predvolene true, lebo presne o to organizátor žiadal: nahrám fotku haly,
-- obkreslím podľa nej sektory, a kupujúci vidí sektory — nie moju fotku.
alter table public.venue_maps
  add column if not exists image_is_backdrop boolean not null default true;

comment on column public.venue_maps.image_is_backdrop is
  'Obrázok slúži len na obkreslenie v editore a kupujúcim sa neposiela.';

-- ---------------------------------------------------------------------------
-- 2. Otáčanie
-- ---------------------------------------------------------------------------
alter table public.venue_sections
  add column if not exists rotation numeric(5,1) not null default 0;

alter table public.venue_sections drop constraint if exists venue_sections_rotation_range;
alter table public.venue_sections add constraint venue_sections_rotation_range
  check (rotation > -360 and rotation < 360);

-- ---------------------------------------------------------------------------
-- 3. Rady a miesta pomenované ako v hale
-- ---------------------------------------------------------------------------
/**
 * Označenie radu podľa zvoleného štýlu.
 *
 * `letters` je A, B, C… (a po Z pokračuje AA) — tak to má väčšina divadiel.
 * `numbers` je 1, 2, 3… — tak to má väčšina štadiónov. Prefix je pre haly,
 * kde sa rad volá „S1", „S2" alebo „C-1".
 */
create or replace function public.seat_row_name(
  p_index  integer,
  p_style  text default 'letters',
  p_prefix text default null
)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select coalesce(nullif(btrim(coalesce(p_prefix, '')), ''), '')
    || case when lower(coalesce(p_style, 'letters')) = 'numbers'
            then (greatest(coalesce(p_index, 0), 0) + 1)::text
            else public.seat_row_label(p_index)
       end;
$$;

grant execute on function public.seat_row_name(integer, text, text) to anon, authenticated;

/**
 * Vyrobí mriežku miest — teraz aj s vlastným pomenovaním.
 *
 * Pribudli tri parametre a všetky majú predvolenú hodnotu, takže staré volanie
 * so štyrmi argumentmi robí presne to, čo robilo.
 *
 * `p_seat_start` je prvé číslo miesta v rade. Sektor, ktorý má miesta 101–140,
 * sa doteraz zadať nedal, a prečíslovať štyridsať vstupeniek ručne pri vchode
 * nie je riešenie.
 */
-- Stará štvorargumentová verzia musí zmiznúť, nie zostať vedľa. Nová má na
-- posledných troch miestach predvolené hodnoty, takže volanie s tromi
-- argumentmi by sedelo na obe a Postgres by ho odmietol ako nejednoznačné —
-- čo je horšie než zmena signatúry: prestal by fungovať aj starý kód.
drop function if exists public.generate_section_seats(uuid, integer, integer, integer);

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
as $$
declare
  v_map     uuid;
  v_event   uuid;
  v_created integer := 0;
  v_removed integer := 0;
  v_clash   record;
  v_style   text := lower(coalesce(p_row_style, 'letters'));
  v_first   integer := greatest(coalesce(p_seat_start, 1), 1);
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
  -- Osem znakov je limit stĺpca; dlhší prefix by padol až pri zápise.
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

  -- Would anybody lose a seat? Asked before anything is touched, so a refusal
  -- leaves the sector exactly as the organizer left it.
  if v_event is not null then
    select vs.row_label, count(*) as n into v_clash
    from public.venue_seats vs
    join public.seat_claims(v_event) c on c.seat_id = vs.id
    where vs.venue_section_id = p_section_id
      and not exists (
        select 1
        from generate_series(0, p_rows - 1) r
        cross join generate_series(v_first, v_first + p_per_row - 1) n
        where public.seat_row_name(p_start_row + r, v_style, p_row_prefix) = vs.row_label
          and n = vs.seat_number
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
      select 1
      from generate_series(0, p_rows - 1) r
      cross join generate_series(v_first, v_first + p_per_row - 1) n
      where public.seat_row_name(p_start_row + r, v_style, p_row_prefix) = vs.row_label
        and n = vs.seat_number
    );
  get diagnostics v_removed = row_count;

  insert into public.venue_seats (venue_section_id, row_label, seat_number)
  select p_section_id, public.seat_row_name(p_start_row + r, v_style, p_row_prefix), n
  from generate_series(0, p_rows - 1) r
  cross join generate_series(v_first, v_first + p_per_row - 1) n
  on conflict (venue_section_id, row_label, seat_number) do nothing;
  get diagnostics v_created = row_count;

  return jsonb_build_object(
    'total', (select count(*) from public.venue_seats where venue_section_id = p_section_id),
    'created', v_created,
    'removed', v_removed
  );
end;
$$;

revoke execute on function
  public.generate_section_seats(uuid, integer, integer, integer, text, text, integer)
  from public, anon;
grant execute on function
  public.generate_section_seats(uuid, integer, integer, integer, text, text, integer)
  to authenticated;

/**
 * Premenuje rad, a nechá miestam ich identitu.
 *
 * Práve preto je to UPDATE a nie zmazať-a-vyrobiť: predaná vstupenka ukazuje
 * na konkrétne miesto. Prekreslenie sektora by ho zahodilo a vstupenka by
 * zrazu nemala sedadlo — s premenovaním človek sedí tam, kde sedel, len sa to
 * volá tak, ako je to napísané v hale.
 */
create or replace function public.rename_section_row(
  p_section_id uuid,
  p_old_label  text,
  p_new_label  text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_map     uuid;
  v_new     text := btrim(coalesce(p_new_label, ''));
  v_changed integer;
begin
  if char_length(v_new) < 1 or char_length(v_new) > 8 then
    raise exception 'INVALID_ROW_LABEL'
      using hint = 'Názov radu môže mať 1 až 8 znakov.';
  end if;

  select venue_map_id into v_map from public.venue_sections where id = p_section_id;
  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  if exists (
    select 1 from public.venue_seats
    where venue_section_id = p_section_id and row_label = v_new
  ) then
    raise exception 'ROW_EXISTS'
      using hint = 'Rad ' || v_new || ' v tomto sektore už je.';
  end if;

  update public.venue_seats
  set row_label = v_new
  where venue_section_id = p_section_id and row_label = p_old_label;
  get diagnostics v_changed = row_count;

  if v_changed = 0 then
    raise exception 'ROW_NOT_FOUND';
  end if;
  return v_changed;
end;
$$;

revoke execute on function public.rename_section_row(uuid, text, text) from public, anon;
grant execute on function public.rename_section_row(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Zmazať miesta, kde v skutočnosti nie sú
-- ---------------------------------------------------------------------------
/**
 * Zmaže konkrétne miesta — stĺp uprostred, priechod, čokoľvek, čo tam nie je.
 *
 * `set_seat_state(..., p_sellable => false)` je iná vec a obe treba: miesto,
 * ktoré existuje a nepredáva sa, má na pláne zostať vidieť (človek pri ňom
 * sedí a vidí, že je prázdne). Miesto, ktoré neexistuje, má zmiznúť.
 *
 * Predané a držané miesta sa nemažú. Vstupenka, ktorá zrazu nemá sedadlo, je
 * horší problém než zle nakreslený plán.
 */
create or replace function public.delete_seats(p_seat_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_map     uuid;
  v_event   uuid;
  v_taken   integer;
  v_deleted integer;
begin
  if p_seat_ids is null or array_length(p_seat_ids, 1) is null then
    return 0;
  end if;

  select distinct s.venue_map_id into v_map
  from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  where vs.id = any (p_seat_ids);

  if v_map is null then
    raise exception 'SEAT_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  select tt.event_id into v_event
  from public.venue_seats vs
  join public.venue_sections s on s.id = vs.venue_section_id
  left join public.ticket_types tt on tt.id = s.ticket_type_id
  where vs.id = any (p_seat_ids)
  limit 1;

  if v_event is not null then
    select count(*) into v_taken
    from public.seat_claims(v_event) c
    where c.seat_id = any (p_seat_ids);

    if coalesce(v_taken, 0) > 0 then
      raise exception 'SEATS_IN_USE'
        using hint = 'Niektoré z týchto miest sú predané alebo držané v košíku.';
    end if;
  end if;

  delete from public.venue_seats where id = any (p_seat_ids);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.delete_seats(uuid[]) from public, anon;
grant execute on function public.delete_seats(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Skopírovať sektor
-- ---------------------------------------------------------------------------
/**
 * Kópia sektora — rovnaká veľkosť, farba, druh, otočenie aj rozloženie miest.
 *
 * Štadión má štyri rovnaké tribúny. Kresliť ich štyrikrát znamená štyri mierne
 * odlišné obdĺžniky, a to je na pláne vidieť.
 *
 * Kópia zámerne NEDOSTANE typ vstupenky. Sektor, ktorý predáva, by sa
 * skopírovaním zdvojil na tej istej cene a v tom istom sklade vstupeniek —
 * organizátor mu má vybrať vlastný.
 */
create or replace function public.duplicate_section(p_section_id uuid)
returns public.venue_sections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  src   public.venue_sections;
  copy  public.venue_sections;
  v_dx  numeric;
  v_dy  numeric;
  v_n   integer := 2;
  v_name text;
begin
  select * into src from public.venue_sections where id = p_section_id;
  if not found then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(src.venue_map_id);

  -- Posunutá o vlastnú šírku, aby kópia neležala presne na origináli a nedala
  -- sa chytiť. Keď sa vedľa nezmestí, ide pod.
  if src.x + 2 * src.width <= 1 then
    v_dx := src.width; v_dy := 0;
  elsif src.y + 2 * src.height <= 1 then
    v_dx := 0; v_dy := src.height;
  else
    v_dx := least(0.02, greatest(1 - (src.x + src.width), 0));
    v_dy := least(0.02, greatest(1 - (src.y + src.height), 0));
  end if;

  -- „Tribúna A" → „Tribúna A 2", a ďalej, kým je názov voľný.
  loop
    v_name := left(src.name || ' ' || v_n::text, 60);
    exit when not exists (
      select 1 from public.venue_sections
      where venue_map_id = src.venue_map_id and name = v_name
    );
    v_n := v_n + 1;
    if v_n > 50 then
      raise exception 'TOO_MANY_COPIES';
    end if;
  end loop;

  insert into public.venue_sections (
    venue_map_id, ticket_type_id, name, colour,
    x, y, width, height, rotation, sort_order, kind, note
  )
  values (
    src.venue_map_id, null, v_name, src.colour,
    least(src.x + v_dx, 1 - src.width), least(src.y + v_dy, 1 - src.height),
    src.width, src.height, src.rotation, src.sort_order + 1, src.kind, src.note
  )
  returning * into copy;

  -- Rovnaké rozloženie miest, vrátane toho, ktoré miesta sú vynechané a ktoré
  -- nie sú na predaj — to je na tribúne to isté rozloženie, nie podobné.
  insert into public.venue_seats (venue_section_id, row_label, seat_number, is_sellable, kind, note)
  select copy.id, vs.row_label, vs.seat_number, vs.is_sellable, vs.kind, vs.note
  from public.venue_seats vs
  where vs.venue_section_id = src.id;

  return copy;
end;
$$;

revoke execute on function public.duplicate_section(uuid) from public, anon;
grant execute on function public.duplicate_section(uuid) to authenticated;
