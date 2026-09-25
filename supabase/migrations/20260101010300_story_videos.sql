-- ---------------------------------------------------------------------------
-- Príbeh môže byť aj video.
--
-- `image_url` zostáva, lebo v ňom už príbehy sú a premenovať stĺpec kvôli
-- názvu nestojí za migráciu, ktorá by sa dala pokaziť. Pribúda `media_type`,
-- aby appka nemusela hádať z prípony — prípona je vec, ktorú vie ktokoľvek
-- napísať do URL inak, než ako súbor naozaj vyzerá.
--
-- Miesto: príbeh žije 24 hodín a potom ho cron zmaže aj s riadkom, takže
-- videá sa nekopia. Zvyšok rieši klient — vyberá sa cez systémový výber, ktorý
-- video rovno prekóduje na menšie, a dlhšie než 15 sekúnd sa neberie. Tvrdý
-- strop na veľkosť je tu, v bucketе, aby ho nešlo obísť.
-- ---------------------------------------------------------------------------
alter table public.stories
  add column if not exists media_type text not null default 'image';

do $$
begin
  alter table public.stories drop constraint if exists stories_media_type_known;
  alter table public.stories
    add constraint stories_media_type_known check (media_type in ('image', 'video'));
end
$$;

create or replace function public.create_story(
  p_image_url    text,
  p_caption      text default null,
  p_event_id     uuid default null,
  p_organization uuid default null,
  p_media_type   text default 'image'
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

  -- A cap, because a story costs nothing to post and the row is what everybody
  -- who follows you has to page through.
  select count(*) into v_live
  from public.stories s
  where s.author_id = v_me and s.expires_at > now();

  if v_live >= 20 then
    raise exception 'TOO_MANY_STORIES';
  end if;

  insert into public.stories
    (author_id, organization_id, image_url, caption, event_id, expires_at, media_type)
  values (
    v_me, p_organization, trim(p_image_url), nullif(trim(coalesce(p_caption, '')), ''),
    p_event_id, now() + interval '24 hours', v_kind
  )
  returning id into v_story;

  return v_story;
end;
$$;

revoke execute on function public.create_story(text, text, uuid, uuid, text) from public;
grant execute on function public.create_story(text, text, uuid, uuid, text) to authenticated;

-- Staršia štvorargumentová verzia by po pridaní piateho argumentu s defaultom
-- zostala ležať vedľa novej a volanie by sa stalo nejednoznačným.
drop function if exists public.create_story(text, text, uuid, uuid);

-- Prehrávač potrebuje vedieť, čo dostane, ešte než to začne načítavať.
-- `create or replace` nestačí: pribúda stĺpec vo výsledku, a to je zmena
-- návratového typu, ktorú Postgres odmietne.
drop function if exists public.stories_of(uuid);

create or replace function public.stories_of(p_author uuid)
returns table (
  id              uuid,
  author_id       uuid,
  organization_id uuid,
  image_url       text,
  media_type      text,
  caption         text,
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
    s.event_id, e.title, e.slug, s.created_at, s.expires_at,
    -- The counter is the author's business; everybody else gets zero rather
    -- than a number that turns watching into a public act.
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
-- Bucket berie aj video. Strop je tu, nie v appke: appka sa dá obísť.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present – skipping stories bucket update';
    return;
  end if;

  update storage.buckets
    set file_size_limit = 26214400,  -- 25 MB: pätnásť sekúnd z telefónu sa zmestí
        allowed_mime_types = array[
          'image/jpeg', 'image/png', 'image/webp', 'image/heic',
          'video/mp4', 'video/quicktime', 'video/webm'
        ]
    where id = 'stories';
end
$$;
