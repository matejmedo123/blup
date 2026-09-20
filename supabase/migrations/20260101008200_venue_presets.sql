-- ============================================================================
-- Päť hotových hál — vyber si tvar a už len upravuj
--
-- Kresliť halu od nuly je najťažšia časť celého nastavovania a zároveň tá
-- najmenej zaujímavá: divadlo má parter a balkón, štadión má štyri tribúny
-- okolo ihriska, klub má pódium, parket a bar. Sú to stále tie isté tvary a
-- nikto ich nechce klikať znova.
--
-- Predloha teda nakreslí tvar a organizátorovi (respektíve adminovi) zostane
-- to, čo je na každej hale naozaj iné: názvy sektorov, koľko je radov, ako sa
-- volajú a ktorý typ vstupenky sa v ktorom sektore predáva.
--
-- Sektory zámerne vznikajú BEZ typu vstupenky, okrem tých, ktorých názov sa
-- presne zhoduje s typom, ktorý na evente už je. Hádať podľa poradia alebo
-- ceny by znamenalo predať lacné miesta za drahé.
-- ============================================================================
set search_path = public, extensions;

/**
 * Tvary predlôh.
 *
 * Súradnice sú zlomky plánu (0..1), rovnako ako všade inde — plán tak nie je
 * viazaný na žiadny konkrétny obrázok ani rozlíšenie.
 */
create or replace function public.venue_presets()
returns jsonb
language sql
immutable
set search_path = public, extensions
as $$
  select '[
    {
      "code": "theatre",
      "name": "Divadlo",
      "description": "Parter, balkón, dve lóže a pódium.",
      "sections": [
        {"name":"Pódium","kind":"stage","colour":"#A855F7","x":0.20,"y":0.04,"width":0.60,"height":0.12,"rotation":0},
        {"name":"Parter","kind":"standard","colour":"#0080FF","x":0.16,"y":0.22,"width":0.68,"height":0.40,"rotation":0},
        {"name":"Balkón","kind":"standard","colour":"#22D3EE","x":0.20,"y":0.68,"width":0.60,"height":0.22,"rotation":0},
        {"name":"Lóža vľavo","kind":"box","colour":"#FF8A3D","x":0.03,"y":0.26,"width":0.10,"height":0.30,"rotation":0},
        {"name":"Lóža vpravo","kind":"box","colour":"#FF8A3D","x":0.87,"y":0.26,"width":0.10,"height":0.30,"rotation":0}
      ]
    },
    {
      "code": "arena",
      "name": "Hala / koncert",
      "description": "Státie na ploche, štyri tribúny okolo, pódium.",
      "sections": [
        {"name":"Pódium","kind":"stage","colour":"#A855F7","x":0.25,"y":0.03,"width":0.50,"height":0.12,"rotation":0},
        {"name":"Státie pred pódiom","kind":"standing","colour":"#22C55E","x":0.28,"y":0.19,"width":0.44,"height":0.30,"rotation":0},
        {"name":"Tribúna vľavo","kind":"standard","colour":"#FF4D8D","x":0.05,"y":0.19,"width":0.18,"height":0.62,"rotation":0},
        {"name":"Tribúna vpravo","kind":"standard","colour":"#0080FF","x":0.77,"y":0.19,"width":0.18,"height":0.62,"rotation":0},
        {"name":"Tribúna oproti","kind":"standard","colour":"#22D3EE","x":0.28,"y":0.54,"width":0.44,"height":0.27,"rotation":0},
        {"name":"Bar","kind":"bar","colour":"#FF8A3D","x":0.40,"y":0.87,"width":0.20,"height":0.08,"rotation":0}
      ]
    },
    {
      "code": "stadium",
      "name": "Štadión",
      "description": "Štyri tribúny okolo hracej plochy.",
      "sections": [
        {"name":"Hracia plocha","kind":"stage","colour":"#22C55E","x":0.26,"y":0.26,"width":0.48,"height":0.48,"rotation":0},
        {"name":"Tribúna sever","kind":"standard","colour":"#FF4D8D","x":0.26,"y":0.05,"width":0.48,"height":0.16,"rotation":0},
        {"name":"Tribúna juh","kind":"standard","colour":"#0080FF","x":0.26,"y":0.79,"width":0.48,"height":0.16,"rotation":0},
        {"name":"Tribúna západ","kind":"standard","colour":"#22D3EE","x":0.05,"y":0.26,"width":0.16,"height":0.48,"rotation":0},
        {"name":"Tribúna východ","kind":"standard","colour":"#FF8A3D","x":0.79,"y":0.26,"width":0.16,"height":0.48,"rotation":0}
      ]
    },
    {
      "code": "club",
      "name": "Klub",
      "description": "Pódium, parket na státie, bar a VIP pri stene.",
      "sections": [
        {"name":"Pódium","kind":"stage","colour":"#A855F7","x":0.10,"y":0.04,"width":0.55,"height":0.14,"rotation":0},
        {"name":"Parket","kind":"standing","colour":"#22C55E","x":0.10,"y":0.24,"width":0.55,"height":0.50,"rotation":0},
        {"name":"VIP pri stene","kind":"vip","colour":"#FF4D8D","x":0.72,"y":0.24,"width":0.20,"height":0.50,"rotation":0},
        {"name":"Bar","kind":"bar","colour":"#FF8A3D","x":0.10,"y":0.80,"width":0.35,"height":0.10,"rotation":0},
        {"name":"Vstup","kind":"entrance","colour":"#22D3EE","x":0.72,"y":0.80,"width":0.20,"height":0.10,"rotation":0}
      ]
    },
    {
      "code": "seated",
      "name": "Kino / konferencia",
      "description": "Jeden blok radov oproti plátnu, ulička v strede.",
      "sections": [
        {"name":"Plátno","kind":"stage","colour":"#A855F7","x":0.15,"y":0.04,"width":0.70,"height":0.10,"rotation":0},
        {"name":"Vľavo","kind":"standard","colour":"#0080FF","x":0.10,"y":0.20,"width":0.37,"height":0.62,"rotation":0},
        {"name":"Vpravo","kind":"standard","colour":"#22D3EE","x":0.53,"y":0.20,"width":0.37,"height":0.62,"rotation":0},
        {"name":"Vstup","kind":"entrance","colour":"#FF8A3D","x":0.42,"y":0.88,"width":0.16,"height":0.08,"rotation":0}
      ]
    }
  ]'::jsonb;
$$;

grant execute on function public.venue_presets() to authenticated;

/**
 * Nakreslí predlohu na event, ktorý ešte plán nemá.
 *
 * Odmietne event, ktorý už plán má. Prepísať existujúci plán predlohou by
 * znamenalo zahodiť sektory, na ktoré sú predané vstupenky — a to je presne
 * ten druh „pomoci", po ktorej sa už nedá nič vrátiť.
 */
create or replace function public.apply_venue_preset(
  p_event_id uuid,
  p_preset   text
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_event  public.events%rowtype;
  v_preset jsonb;
  v_map    uuid;
  v_sec    jsonb;
  v_order  integer := 0;
begin
  -- Oprávnenie ako prvé, pred akýmkoľvek pravidlom o tom, či sa to dá.
  -- Inak by sa cudzí človek z odpovede dozvedel, či event plán má — a dostal
  -- by inú chybu podľa toho, čo je v databáze.
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
      x, y, width, height, rotation, kind, sort_order
    )
    values (
      v_map,
      -- Iba presná zhoda názvu. Hádať podľa poradia alebo ceny by predalo
      -- lacné miesta za drahé.
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
      v_order
    );
  end loop;

  update public.events set venue_map_id = v_map where id = p_event_id;
  return v_map;
end;
$$;

revoke execute on function public.apply_venue_preset(uuid, text) from public, anon;
grant execute on function public.apply_venue_preset(uuid, text) to authenticated;
