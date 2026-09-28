-- ============================================================================
-- Príbeh má dve vrstvy a text pristane tam, kam ho dáš
-- ============================================================================
-- Doteraz sa z polohy textu ukladala len výška (`y`) a obrazovky, ktoré text
-- kreslili, sa navyše nezhodovali: editor ho ukazoval na 42 % výšky, uložil
-- 50 % a prehrávač nakreslil 50 %. Text sa teda objavil inde, než kde ho
-- človek nechal, a nedalo sa zistiť prečo.
--
-- Poloha je odteraz úplná: `x` aj `y`, oboje ako ZLOMOK rámčeka. Zlomok preto,
-- že rámček má pri písaní inú veľkosť než pri pozeraní — v bodoch by to isté
-- číslo znamenalo iné miesto.
--
-- `x` smie chýbať. Príbehy napísané predtým, než sa dal text ťahať do strán,
-- ho nemajú a kreslia sa na stred; dopočítavať im niečo by bolo hádanie.
-- ============================================================================
set search_path = public, extensions;

do $$
begin
  alter table public.stories drop constraint if exists stories_overlay_shape;
  alter table public.stories
    add constraint stories_overlay_shape check (
      overlay is null
      or (
        jsonb_typeof(overlay) = 'object'
        and jsonb_typeof(overlay -> 'text') = 'string'
        and char_length(overlay ->> 'text') between 1 and 200
        -- Poloha 0..1 v oboch osiach, aby sa text nedal poslať mimo obrazovku.
        and (overlay -> 'x' is null
             or (jsonb_typeof(overlay -> 'x') = 'number'
                 and (overlay ->> 'x')::numeric between 0 and 1))
        and (overlay -> 'y' is null
             or (jsonb_typeof(overlay -> 'y') = 'number'
                 and (overlay ->> 'y')::numeric between 0 and 1))
        -- Farba len z našej palety: ľubovoľný reťazec je cesta, ako do štýlu
        -- prepašovať čokoľvek, čo appka potom vykreslí.
        and (overlay -> 'color' is null
             or overlay ->> 'color' in ('white', 'black', 'accent', 'pink', 'amber'))
        and (overlay -> 'size' is null
             or overlay ->> 'size' in ('s', 'm', 'l'))
      )
    );
end
$$;

create or replace function public.create_story(
  p_image_url    text,
  p_caption      text default null,
  p_event_id     uuid default null,
  p_organization uuid default null,
  p_media_type   text default 'image',
  p_overlay      jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me    uuid := auth.uid();
  v_story uuid;
  v_live  integer;
  v_kind  text := lower(coalesce(nullif(trim(p_media_type), ''), 'image'));
  v_text  text := nullif(trim(coalesce(p_overlay ->> 'text', '')), '');
  v_over  jsonb;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if v_kind not in ('image', 'video') then
    raise exception 'INVALID_MEDIA_TYPE';
  end if;

  if p_image_url is null or char_length(trim(p_image_url)) = 0 then
    raise exception 'IMAGE_REQUIRED';
  end if;

  -- Len tam, kde naozaj ukladáme obrázky. Bez tohto je stĺpec otvorené
  -- presmerovanie s 24-hodinovým publikom.
  if p_image_url !~ '^https://[a-z0-9.-]+/storage/v1/object/(public|sign)/' then
    raise exception 'INVALID_IMAGE_URL';
  end if;

  -- Písať pod menom značky je rozhodnutie značky, nie pisateľa.
  if p_organization is not null
     and not public.is_org_member(
       p_organization, array['owner', 'admin', 'event_manager']::org_role[], v_me
     ) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select count(*) into v_live
  from public.stories s
  where s.author_id = v_me and s.expires_at > now();

  if v_live >= 20 then
    raise exception 'TOO_MANY_STORIES';
  end if;

  -- Prázdny text nie je text. Skladá sa tu, aby sa do stĺpca nedostalo nič
  -- iné než to, čo obmedzenie vyššie pustí.
  if v_text is not null then
    v_over := jsonb_build_object('text', left(v_text, 200))
      || case when p_overlay -> 'x' is null then '{}'::jsonb
              else jsonb_build_object('x', least(1, greatest(0, (p_overlay ->> 'x')::numeric))) end
      || case when p_overlay -> 'y' is null then '{}'::jsonb
              else jsonb_build_object('y', least(1, greatest(0, (p_overlay ->> 'y')::numeric))) end
      || case when p_overlay -> 'color' is null then '{}'::jsonb
              else jsonb_build_object('color', p_overlay ->> 'color') end
      || case when p_overlay -> 'size' is null then '{}'::jsonb
              else jsonb_build_object('size', p_overlay ->> 'size') end;
  end if;

  insert into public.stories
    (author_id, organization_id, image_url, caption, event_id, expires_at,
     media_type, overlay)
  values (
    v_me, p_organization, trim(p_image_url),
    -- Popis pod príbehom a text cez príbeh sú to isté slovo na dvoch miestach;
    -- keď je napísaný cez príbeh, nech sa aspoň dá prečítať aj v náhľade.
    coalesce(nullif(trim(coalesce(p_caption, '')), ''), v_text),
    p_event_id, now() + interval '24 hours', v_kind, v_over
  )
  returning id into v_story;

  return v_story;
end;
$$;

revoke execute on function public.create_story(text, text, uuid, uuid, text, jsonb) from public;
grant execute on function public.create_story(text, text, uuid, uuid, text, jsonb) to authenticated;
