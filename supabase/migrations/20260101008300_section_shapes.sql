-- ============================================================================
-- Sektor nemusí byť obdĺžnik
--
-- „Mozno dat moznost nakreslit aj abnormalny sektor.. ze ked sa zataca jak
-- keby.."
--
-- Tribúna v rohu štadióna sa zatáča. Kotol za bránou je lichobežník. Balkón
-- je oblúk. Obdĺžnikom sa to dá obkresliť len tak, že buď zaberie kus ihriska,
-- alebo nechá časť sektora vonku — a človek, ktorý si kupuje miesto, sa podľa
-- toho plánu orientuje.
--
-- `shape` je zoznam bodov (0..1), rovnako ako všetko ostatné na pláne. Keď je
-- prázdny, sektor je obdĺžnik a nič sa nemení — tak je nakreslená drvivá
-- väčšina sektorov a nie je dôvod z nich robiť päťuholníky.
--
-- Obdĺžnik x/y/width/height ZOSTÁVA aj pri tvare a je to jeho ohraničenie.
-- Nie je to duplicita: mriežka miest, zisťovanie, na čo sa klikol, a zoradenie
-- sektorov pracujú s ohraničením, a keby sa počítalo zakaždým z bodov, každá
-- z tých vecí by si ho počítala inak.
-- ============================================================================
set search_path = public, extensions;

alter table public.venue_sections
  add column if not exists shape jsonb;

alter table public.venue_sections drop constraint if exists venue_sections_shape_sane;
alter table public.venue_sections add constraint venue_sections_shape_sane
  check (
    shape is null
    or (jsonb_typeof(shape) = 'array' and jsonb_array_length(shape) between 3 and 40)
  );

comment on column public.venue_sections.shape is
  'Body obrysu (0..1) pre sektor, ktorý nie je obdĺžnik. NULL = obdĺžnik.';

/**
 * Ohraničenie zoznamu bodov.
 *
 * Aby x/y/width/height vždy sedeli s tvarom — nie preto, že by sa to nedalo
 * spočítať inde, ale preto, aby to nepočítali tri miesta troma spôsobmi.
 */
create or replace function public.shape_bounds(p_shape jsonb)
returns jsonb
language sql
immutable
set search_path = public, extensions
as $$
  select case
    when p_shape is null or jsonb_array_length(p_shape) < 3 then null
    else jsonb_build_object(
      'x', min_x, 'y', min_y,
      'width', greatest(max_x - min_x, 0.001),
      'height', greatest(max_y - min_y, 0.001)
    )
  end
  from (
    select
      min(greatest(least((p ->> 'x')::numeric, 1), 0)) as min_x,
      min(greatest(least((p ->> 'y')::numeric, 1), 0)) as min_y,
      max(greatest(least((p ->> 'x')::numeric, 1), 0)) as max_x,
      max(greatest(least((p ->> 'y')::numeric, 1), 0)) as max_y
    from jsonb_array_elements(coalesce(p_shape, '[]'::jsonb)) p
  ) b;
$$;

grant execute on function public.shape_bounds(jsonb) to authenticated;

/**
 * Nastaví (alebo zruší) tvar sektora a dorovná k nemu ohraničenie.
 *
 * Zámerne vlastná funkcia a nie ďalší parameter update_section(): tvar mení aj
 * x/y/width/height, takže volanie, ktoré posiela oboje, by si protirečilo.
 */
create or replace function public.set_section_shape(
  p_section_id uuid,
  p_shape      jsonb
)
returns public.venue_sections
language plpgsql
security definer
set search_path = public, extensions
as $$
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
$$;

revoke execute on function public.set_section_shape(uuid, jsonb) from public, anon;
grant execute on function public.set_section_shape(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Tvar musí prísť aj ku kupujúcemu
-- ---------------------------------------------------------------------------
create or replace function public.seat_map_for_event(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
$$;

grant execute on function public.seat_map_for_event(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- A kópia sektora musí kopírovať aj tvar
-- ---------------------------------------------------------------------------
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

  if src.x + 2 * src.width <= 1 then
    v_dx := src.width; v_dy := 0;
  elsif src.y + 2 * src.height <= 1 then
    v_dx := 0; v_dy := src.height;
  else
    v_dx := least(0.02, greatest(1 - (src.x + src.width), 0));
    v_dy := least(0.02, greatest(1 - (src.y + src.height), 0));
  end if;

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
    x, y, width, height, rotation, sort_order, kind, note, shape
  )
  values (
    src.venue_map_id, null, v_name, src.colour,
    least(src.x + v_dx, 1 - src.width), least(src.y + v_dy, 1 - src.height),
    src.width, src.height, src.rotation, src.sort_order + 1, src.kind, src.note,
    -- Body sa posunú s ňou, inak by kópia mala tvar na starom mieste a
    -- ohraničenie na novom.
    case when src.shape is null then null else (
      select jsonb_agg(jsonb_build_object(
        'x', least(greatest((p ->> 'x')::numeric + v_dx, 0), 1),
        'y', least(greatest((p ->> 'y')::numeric + v_dy, 0), 1)
      ))
      from jsonb_array_elements(src.shape) p
    ) end
  )
  returning * into copy;

  insert into public.venue_seats (venue_section_id, row_label, seat_number, is_sellable, kind, note)
  select copy.id, vs.row_label, vs.seat_number, vs.is_sellable, vs.kind, vs.note
  from public.venue_seats vs
  where vs.venue_section_id = src.id;

  return copy;
end;
$$;

revoke execute on function public.duplicate_section(uuid) from public, anon;
grant execute on function public.duplicate_section(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Predlohy s oblúkmi
-- ---------------------------------------------------------------------------
-- Pôvodných päť predlôh bolo zo samých obdĺžnikov, lebo iný tvar vtedy
-- neexistoval. Teraz existuje, takže tribúny na štadióne sa zatáčajú okolo
-- ihriska a balkón je oblúk — čo je to, ako tie haly naozaj vyzerajú, a to je
-- jediný dôvod, prečo plán niekomu pomôže sa zorientovať.
--
-- Zvyšok zostáva pravouhlý zámerne: parket v klube ani rady v kine sa
-- nezatáčajú a päťuholník navyše by nepovedal nič.
create or replace function public.venue_presets()
returns jsonb
language sql
immutable
set search_path = public, extensions
as $fn$
  select '[
  {
    "code": "theatre",
    "name": "Divadlo",
    "description": "Parter, oblúkový balkón, dve lóže a pódium.",
    "sections": [
      {
        "name": "Pódium",
        "kind": "stage",
        "colour": "#A855F7",
        "rotation": 0,
        "x": 0.2,
        "y": 0.04,
        "width": 0.6,
        "height": 0.12,
        "shape": null
      },
      {
        "name": "Parter",
        "kind": "standard",
        "colour": "#0080FF",
        "rotation": 0,
        "x": 0.16,
        "y": 0.22,
        "width": 0.68,
        "height": 0.38,
        "shape": null
      },
      {
        "name": "Balkón",
        "kind": "standard",
        "colour": "#22D3EE",
        "rotation": 0,
        "x": 0.1016,
        "y": 0.53,
        "width": 0.7968,
        "height": 0.2869,
        "shape": [
          {
            "x": 0.8984,
            "y": 0.59
          },
          {
            "x": 0.8346,
            "y": 0.6757
          },
          {
            "x": 0.7528,
            "y": 0.7443
          },
          {
            "x": 0.6573,
            "y": 0.7923
          },
          {
            "x": 0.5534,
            "y": 0.8169
          },
          {
            "x": 0.4466,
            "y": 0.8169
          },
          {
            "x": 0.3427,
            "y": 0.7923
          },
          {
            "x": 0.2472,
            "y": 0.7443
          },
          {
            "x": 0.1654,
            "y": 0.6757
          },
          {
            "x": 0.1016,
            "y": 0.59
          },
          {
            "x": 0.2056,
            "y": 0.53
          },
          {
            "x": 0.2527,
            "y": 0.5933
          },
          {
            "x": 0.3132,
            "y": 0.6441
          },
          {
            "x": 0.3837,
            "y": 0.6795
          },
          {
            "x": 0.4605,
            "y": 0.6977
          },
          {
            "x": 0.5395,
            "y": 0.6977
          },
          {
            "x": 0.6163,
            "y": 0.6795
          },
          {
            "x": 0.6868,
            "y": 0.6441
          },
          {
            "x": 0.7473,
            "y": 0.5933
          },
          {
            "x": 0.7944,
            "y": 0.53
          }
        ]
      },
      {
        "name": "Lóža vľavo",
        "kind": "box",
        "colour": "#FF8A3D",
        "rotation": 0,
        "x": 0.03,
        "y": 0.26,
        "width": 0.09,
        "height": 0.28,
        "shape": null
      },
      {
        "name": "Lóža vpravo",
        "kind": "box",
        "colour": "#FF8A3D",
        "rotation": 0,
        "x": 0.88,
        "y": 0.26,
        "width": 0.09,
        "height": 0.28,
        "shape": null
      }
    ]
  },
  {
    "code": "arena",
    "name": "Hala / koncert",
    "description": "Státie na ploche, oblúková tribúna vzadu, pódium.",
    "sections": [
      {
        "name": "Pódium",
        "kind": "stage",
        "colour": "#A855F7",
        "rotation": 0,
        "x": 0.25,
        "y": 0.03,
        "width": 0.5,
        "height": 0.12,
        "shape": null
      },
      {
        "name": "Státie pred pódiom",
        "kind": "standing",
        "colour": "#22C55E",
        "rotation": 0,
        "x": 0.27,
        "y": 0.18,
        "width": 0.46,
        "height": 0.3,
        "shape": null
      },
      {
        "name": "Tribúna oblúk",
        "kind": "standard",
        "colour": "#FF4D8D",
        "rotation": 0,
        "x": 0.0667,
        "y": 0.4721,
        "width": 0.8666,
        "height": 0.3826,
        "shape": [
          {
            "x": 0.9333,
            "y": 0.4964
          },
          {
            "x": 0.8893,
            "y": 0.6251
          },
          {
            "x": 0.8081,
            "y": 0.7341
          },
          {
            "x": 0.6975,
            "y": 0.8132
          },
          {
            "x": 0.568,
            "y": 0.8547
          },
          {
            "x": 0.432,
            "y": 0.8547
          },
          {
            "x": 0.3025,
            "y": 0.8132
          },
          {
            "x": 0.1919,
            "y": 0.7341
          },
          {
            "x": 0.1107,
            "y": 0.6251
          },
          {
            "x": 0.0667,
            "y": 0.4964
          },
          {
            "x": 0.2046,
            "y": 0.4721
          },
          {
            "x": 0.2346,
            "y": 0.5598
          },
          {
            "x": 0.2899,
            "y": 0.6342
          },
          {
            "x": 0.3654,
            "y": 0.6881
          },
          {
            "x": 0.4536,
            "y": 0.7164
          },
          {
            "x": 0.5464,
            "y": 0.7164
          },
          {
            "x": 0.6346,
            "y": 0.6881
          },
          {
            "x": 0.7101,
            "y": 0.6342
          },
          {
            "x": 0.7654,
            "y": 0.5598
          },
          {
            "x": 0.7954,
            "y": 0.4721
          }
        ]
      },
      {
        "name": "Tribúna vľavo",
        "kind": "standard",
        "colour": "#0080FF",
        "rotation": 0,
        "x": 0.04,
        "y": 0.18,
        "width": 0.18,
        "height": 0.34,
        "shape": null
      },
      {
        "name": "Tribúna vpravo",
        "kind": "standard",
        "colour": "#22D3EE",
        "rotation": 0,
        "x": 0.78,
        "y": 0.18,
        "width": 0.18,
        "height": 0.34,
        "shape": null
      },
      {
        "name": "Bar",
        "kind": "bar",
        "colour": "#FF8A3D",
        "rotation": 0,
        "x": 0.41,
        "y": 0.9,
        "width": 0.18,
        "height": 0.07,
        "shape": null
      }
    ]
  },
  {
    "code": "stadium",
    "name": "Štadión",
    "description": "Štyri zatáčajúce sa tribúny okolo hracej plochy.",
    "sections": [
      {
        "name": "Hracia plocha",
        "kind": "stage",
        "colour": "#22C55E",
        "rotation": 0,
        "x": 0.3,
        "y": 0.3,
        "width": 0.4,
        "height": 0.4,
        "shape": null
      },
      {
        "name": "Tribúna sever",
        "kind": "standard",
        "colour": "#FF4D8D",
        "rotation": 0,
        "x": 0.1553,
        "y": 0.0535,
        "width": 0.6894,
        "height": 0.2537,
        "shape": [
          {
            "x": 0.1553,
            "y": 0.2107
          },
          {
            "x": 0.2373,
            "y": 0.1346
          },
          {
            "x": 0.3356,
            "y": 0.0811
          },
          {
            "x": 0.444,
            "y": 0.0535
          },
          {
            "x": 0.556,
            "y": 0.0535
          },
          {
            "x": 0.6644,
            "y": 0.0811
          },
          {
            "x": 0.7627,
            "y": 0.1346
          },
          {
            "x": 0.8447,
            "y": 0.2107
          },
          {
            "x": 0.7298,
            "y": 0.3072
          },
          {
            "x": 0.6751,
            "y": 0.2564
          },
          {
            "x": 0.6096,
            "y": 0.2207
          },
          {
            "x": 0.5373,
            "y": 0.2023
          },
          {
            "x": 0.4627,
            "y": 0.2023
          },
          {
            "x": 0.3904,
            "y": 0.2207
          },
          {
            "x": 0.3249,
            "y": 0.2564
          },
          {
            "x": 0.2702,
            "y": 0.3072
          }
        ]
      },
      {
        "name": "Tribúna juh",
        "kind": "standard",
        "colour": "#0080FF",
        "rotation": 0,
        "x": 0.1553,
        "y": 0.6928,
        "width": 0.6894,
        "height": 0.2537,
        "shape": [
          {
            "x": 0.8447,
            "y": 0.7893
          },
          {
            "x": 0.7627,
            "y": 0.8654
          },
          {
            "x": 0.6644,
            "y": 0.9189
          },
          {
            "x": 0.556,
            "y": 0.9465
          },
          {
            "x": 0.444,
            "y": 0.9465
          },
          {
            "x": 0.3356,
            "y": 0.9189
          },
          {
            "x": 0.2373,
            "y": 0.8654
          },
          {
            "x": 0.1553,
            "y": 0.7893
          },
          {
            "x": 0.2702,
            "y": 0.6928
          },
          {
            "x": 0.3249,
            "y": 0.7436
          },
          {
            "x": 0.3904,
            "y": 0.7793
          },
          {
            "x": 0.4627,
            "y": 0.7977
          },
          {
            "x": 0.5373,
            "y": 0.7977
          },
          {
            "x": 0.6096,
            "y": 0.7793
          },
          {
            "x": 0.6751,
            "y": 0.7436
          },
          {
            "x": 0.7298,
            "y": 0.6928
          }
        ]
      },
      {
        "name": "Tribúna západ",
        "kind": "standard",
        "colour": "#22D3EE",
        "rotation": 0,
        "x": 0.0535,
        "y": 0.1553,
        "width": 0.2537,
        "height": 0.6894,
        "shape": [
          {
            "x": 0.2107,
            "y": 0.8447
          },
          {
            "x": 0.1346,
            "y": 0.7627
          },
          {
            "x": 0.0811,
            "y": 0.6644
          },
          {
            "x": 0.0535,
            "y": 0.556
          },
          {
            "x": 0.0535,
            "y": 0.444
          },
          {
            "x": 0.0811,
            "y": 0.3356
          },
          {
            "x": 0.1346,
            "y": 0.2373
          },
          {
            "x": 0.2107,
            "y": 0.1553
          },
          {
            "x": 0.3072,
            "y": 0.2702
          },
          {
            "x": 0.2564,
            "y": 0.3249
          },
          {
            "x": 0.2207,
            "y": 0.3904
          },
          {
            "x": 0.2023,
            "y": 0.4627
          },
          {
            "x": 0.2023,
            "y": 0.5373
          },
          {
            "x": 0.2207,
            "y": 0.6096
          },
          {
            "x": 0.2564,
            "y": 0.6751
          },
          {
            "x": 0.3072,
            "y": 0.7298
          }
        ]
      },
      {
        "name": "Tribúna východ",
        "kind": "standard",
        "colour": "#FF8A3D",
        "rotation": 0,
        "x": 0.6928,
        "y": 0.1553,
        "width": 0.2537,
        "height": 0.6894,
        "shape": [
          {
            "x": 0.7893,
            "y": 0.1553
          },
          {
            "x": 0.8654,
            "y": 0.2373
          },
          {
            "x": 0.9189,
            "y": 0.3356
          },
          {
            "x": 0.9465,
            "y": 0.444
          },
          {
            "x": 0.9465,
            "y": 0.556
          },
          {
            "x": 0.9189,
            "y": 0.6644
          },
          {
            "x": 0.8654,
            "y": 0.7627
          },
          {
            "x": 0.7893,
            "y": 0.8447
          },
          {
            "x": 0.6928,
            "y": 0.7298
          },
          {
            "x": 0.7436,
            "y": 0.6751
          },
          {
            "x": 0.7793,
            "y": 0.6096
          },
          {
            "x": 0.7977,
            "y": 0.5373
          },
          {
            "x": 0.7977,
            "y": 0.4627
          },
          {
            "x": 0.7793,
            "y": 0.3904
          },
          {
            "x": 0.7436,
            "y": 0.3249
          },
          {
            "x": 0.6928,
            "y": 0.2702
          }
        ]
      }
    ]
  },
  {
    "code": "club",
    "name": "Klub",
    "description": "Pódium, parket na státie, bar a VIP pri stene.",
    "sections": [
      {
        "name": "Pódium",
        "kind": "stage",
        "colour": "#A855F7",
        "rotation": 0,
        "x": 0.1,
        "y": 0.04,
        "width": 0.55,
        "height": 0.14,
        "shape": null
      },
      {
        "name": "Parket",
        "kind": "standing",
        "colour": "#22C55E",
        "rotation": 0,
        "x": 0.1,
        "y": 0.24,
        "width": 0.55,
        "height": 0.5,
        "shape": null
      },
      {
        "name": "VIP pri stene",
        "kind": "vip",
        "colour": "#FF4D8D",
        "rotation": 0,
        "x": 0.72,
        "y": 0.24,
        "width": 0.2,
        "height": 0.5,
        "shape": null
      },
      {
        "name": "Bar",
        "kind": "bar",
        "colour": "#FF8A3D",
        "rotation": 0,
        "x": 0.1,
        "y": 0.8,
        "width": 0.35,
        "height": 0.1,
        "shape": null
      },
      {
        "name": "Vstup",
        "kind": "entrance",
        "colour": "#22D3EE",
        "rotation": 0,
        "x": 0.72,
        "y": 0.8,
        "width": 0.2,
        "height": 0.1,
        "shape": null
      }
    ]
  },
  {
    "code": "seated",
    "name": "Kino / konferencia",
    "description": "Jeden blok radov oproti plátnu, ulička v strede.",
    "sections": [
      {
        "name": "Plátno",
        "kind": "stage",
        "colour": "#A855F7",
        "rotation": 0,
        "x": 0.15,
        "y": 0.04,
        "width": 0.7,
        "height": 0.1,
        "shape": null
      },
      {
        "name": "Vľavo",
        "kind": "standard",
        "colour": "#0080FF",
        "rotation": 0,
        "x": 0.1,
        "y": 0.2,
        "width": 0.37,
        "height": 0.62,
        "shape": null
      },
      {
        "name": "Vpravo",
        "kind": "standard",
        "colour": "#22D3EE",
        "rotation": 0,
        "x": 0.53,
        "y": 0.2,
        "width": 0.37,
        "height": 0.62,
        "shape": null
      },
      {
        "name": "Vstup",
        "kind": "entrance",
        "colour": "#FF8A3D",
        "rotation": 0,
        "x": 0.42,
        "y": 0.88,
        "width": 0.16,
        "height": 0.08,
        "shape": null
      }
    ]
  }
]'::jsonb;
$fn$;

grant execute on function public.venue_presets() to authenticated;

/** Predloha teraz kreslí aj tvar, nielen obdĺžnik. */
create or replace function public.apply_venue_preset(
  p_event_id uuid,
  p_preset   text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_event  public.events%rowtype;
  v_preset jsonb;
  v_map    uuid;
  v_sec    jsonb;
  v_order  integer := 0;
begin
  perform public.assert_can_manage_venue_map(null);

  select * into v_event from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;
  if v_event.organization_id is null then
    raise exception 'EVENT_HAS_NO_ORGANIZATION'
      using hint = 'Plán patrí organizácii, aby sa dal použiť aj na ďalšie večery.';
  end if;
  if v_event.venue_map_id is not null then
    raise exception 'PLAN_ALREADY_EXISTS'
      using hint = 'Event už plán má. Najprv ho odpoj alebo zmaž.';
  end if;

  select value into v_preset
  from jsonb_array_elements(public.venue_presets()) value
  where value ->> 'code' = p_preset;

  if v_preset is null then
    raise exception 'UNKNOWN_PRESET';
  end if;

  insert into public.venue_maps (organization_id, name, image_width, image_height, created_by)
  values (v_event.organization_id, v_preset ->> 'name', 1600, 1200, auth.uid())
  returning id into v_map;

  for v_sec in select * from jsonb_array_elements(v_preset -> 'sections')
  loop
    v_order := v_order + 1;
    insert into public.venue_sections (
      venue_map_id, ticket_type_id, name, colour,
      x, y, width, height, rotation, kind, sort_order, shape
    )
    values (
      v_map,
      (select tt.id from public.ticket_types tt
       where tt.event_id = p_event_id and tt.name = v_sec ->> 'name'
       limit 1),
      v_sec ->> 'name',
      v_sec ->> 'colour',
      (v_sec ->> 'x')::numeric,
      (v_sec ->> 'y')::numeric,
      (v_sec ->> 'width')::numeric,
      (v_sec ->> 'height')::numeric,
      coalesce((v_sec ->> 'rotation')::numeric, 0),
      v_sec ->> 'kind',
      v_order,
      case when jsonb_typeof(v_sec -> 'shape') = 'array' then v_sec -> 'shape' else null end
    );
  end loop;

  update public.events set venue_map_id = v_map where id = p_event_id;
  return v_map;
end;
$fn$;

revoke execute on function public.apply_venue_preset(uuid, text) from public, anon;
grant execute on function public.apply_venue_preset(uuid, text) to authenticated;
