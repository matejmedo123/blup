-- ---------------------------------------------------------------------------
-- Text cez príbeh — a video, ktoré sa nahráva malé.
--
-- TEXT. Neukladá sa vypálený do obrázka. Vypálenie znamená, že text sa nedá
-- opraviť, nedá sa prečítať čítačkou pre nevidiacich, nedá sa preložiť a pri
-- videu by ho bolo treba prekódovať do každého snímku. Ukladá sa ako údaj a
-- vykresľuje sa nad médiom — takže funguje rovnako nad fotkou aj nad videom a
-- `caption` zostáva obyčajným textom pre náhľady a upozornenia.
--
-- VEĽKOSŤ. Strop 25 MB bol zlá páka: pätnásť sekúnd z telefónu má bežne 20–30
-- MB, takže odmietal skoro všetko. Správne miesto na riešenie je záznam, nie
-- kontrola po ňom — appka nahráva v 720p s obmedzeným tokom, čo je pri 15
-- sekundách okolo 5 MB. Strop tu zostáva ako poistka proti tomu, čo príde
-- inou cestou (výber z knižnice na webe, kde sa nedá prekódovať), a dvíha sa
-- na hodnotu, ktorá takúto cestu neblokuje zbytočne.
-- ---------------------------------------------------------------------------
alter table public.stories
  add column if not exists overlay jsonb;

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
        -- Zvislá poloha 0..1, aby sa text nedal poslať mimo obrazovku.
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

  -- Only somewhere we actually store pictures. Without this the column is an
  -- open redirect with a 24-hour audience attached to it.
  if p_image_url !~ '^https://[a-z0-9.-]+/storage/v1/object/(public|sign)/' then
    raise exception 'INVALID_IMAGE_URL';
  end if;

  -- Posting under a brand's name is the brand's decision, not the poster's.
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

-- Predchádzajúca päťargumentová verzia by po pridaní šiesteho s defaultom
-- zostala ležať vedľa novej a volanie by sa stalo nejednoznačným.
drop function if exists public.create_story(text, text, uuid, uuid, text);

drop function if exists public.stories_of(uuid);

create or replace function public.stories_of(p_author uuid)
returns table (
  id              uuid,
  author_id       uuid,
  organization_id uuid,
  image_url       text,
  media_type      text,
  caption         text,
  -- V úvodzovkách: OVERLAY je v SQL rezervované slovo (funkcia
  -- `overlay(reťazec placing ...)`), takže v zozname stĺpcov sa bez nich
  -- neparsuje. Meno stĺpca zostáva `overlay`, klient ho vidí rovnako.
  "overlay"       jsonb,
  event_id        uuid,
  event_title     text,
  event_slug      text,
  created_at      timestamptz,
  expires_at      timestamptz,
  view_count      integer,
  seen_by_me      boolean
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    s.id, s.author_id, s.organization_id, s.image_url, s.media_type, s.caption,
    s.overlay, s.event_id, e.title, e.slug, s.created_at, s.expires_at,
    case when s.author_id = auth.uid() then s.view_count else 0 end,
    exists (
      select 1 from public.story_views v
      where v.story_id = s.id and v.viewer_id = auth.uid()
    )
  from public.stories s
  left join public.events e on e.id = s.event_id
  where s.author_id = p_author
    and s.expires_at > now()
    and (
      s.author_id = auth.uid()
      or exists (
        select 1 from public.follows f
        where f.follower_id = auth.uid() and f.following_id = s.author_id
      )
    )
  order by s.created_at;
$$;

revoke execute on function public.stories_of(uuid) from public;
grant execute on function public.stories_of(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Strop ako poistka, nie ako hlavný nástroj. Appka nahráva malé; toto zachytí
-- len to, čo príde inou cestou.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present – skipping stories bucket update';
    return;
  end if;

  update storage.buckets
    set file_size_limit = 78643200  -- 75 MB
    where id = 'stories';
end
$$;
