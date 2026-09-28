-- ============================================================================
-- Farebný krúžok zhasne aj na tvojom vlastnom príbehu
-- ============================================================================
-- Krúžok okolo tváre znamená jedinú vec: „tu je niečo, čo si nevidel". Pri
-- cudzom príbehu to fungovalo. Pri vlastnom nie — ten svietil až do vypršania,
-- nech si ho pozrel koľkokrát chcel, a keďže to isté číslo kreslí krúžok
-- všade, kde je tvoja tvár, svietila ti všade.
--
-- Príčina je v `mark_story_seen`: pri vlastnom príbehu sa vrátila hneď a
-- nezapísala nič. Zámer bol správny — vlastné pozretie nemá nafukovať počítadlo
-- „koľkí to videli" a ani sa nemá objaviť v zozname divákov. Chyba bola v tom,
-- že sa jednou tabuľkou odpovedalo na dve rôzne otázky:
--
--   „koľkí to videli"       → autor sa nepočíta, a to zostáva
--   „videl som to už ja?"   → autor sa počítať MUSÍ, inak krúžok nikdy nezhasne
--
-- Zápis teda vzniká vždy, ale počítadlo sa dvíha len pri cudzom divákovi a
-- autor sa zo zoznamu divákov vynecháva. Nikto sa tak nedozvie nič nové o tom,
-- kto sa na čo pozeral.
-- ============================================================================
set search_path = public, extensions;

create or replace function public.mark_story_seen(p_story uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me     uuid := auth.uid();
  v_author uuid;
begin
  if v_me is null then
    return;
  end if;

  select s.author_id into v_author
  from public.stories s
  where s.id = p_story and s.expires_at > now();

  if v_author is null then
    return;                      -- neexistuje alebo už vypršal
  end if;

  -- Zápis vzniká aj pre autora. Je to odpoveď na „videl som to už ja?", nie
  -- na „koľkí to videli" — a bez neho vlastný krúžok nikdy nezhasne.
  insert into public.story_views (story_id, viewer_id)
  values (p_story, v_me)
  on conflict do nothing;

  -- Počítadlo sa dvíha len pri cudzom divákovi. Vlastné pozretie v ňom nemá
  -- čo hľadať: autor by videl jednotku, ktorú si tam sám dal.
  if found and v_author <> v_me then
    update public.stories set view_count = view_count + 1 where id = p_story;
  end if;
end;
$$;

revoke execute on function public.mark_story_seen(uuid) from public;
grant execute on function public.mark_story_seen(uuid) to authenticated;

-- Zoznam divákov autora nevypisuje. Doteraz tam nemal ako byť, lebo sa jeho
-- zápis vôbec nevytvoril; odteraz sa vytvára, takže sa musí vynechať tu.
create or replace function public.story_viewers(p_story uuid, p_limit integer default 100)
returns table (
  viewer_id    uuid,
  display_name text,
  username     text,
  avatar_url   text,
  seen_at      timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p.id, p.display_name, p.username, p.avatar_url, v.seen_at
  from public.story_views v
  join public.stories s on s.id = v.story_id and s.author_id = auth.uid()
  join public.profiles p on p.id = v.viewer_id
  where v.story_id = p_story
    and v.viewer_id <> s.author_id
  order by v.seen_at desc
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.story_viewers(uuid, integer) from public;
grant execute on function public.story_viewers(uuid, integer) to authenticated;
