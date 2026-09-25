-- ============================================================================
-- Feed sa musí pýtať na to isté, na čo sa pýta RLS
-- ============================================================================
-- `feed_posts` je `security definer`. To znamená, že beží s právami vlastníka
-- a politika `posts_select` sa naň nevzťahuje — funkcia si musí viditeľnosť
-- ustrážiť sama. Nerobila to: pýtala sa len na `not is_deleted`.
--
-- Dôsledok bol, že príspevok v súkromnej komunite videl ktokoľvek, kto otvoril
-- feed. Aj neprihlásený. Súkromná komunita teda nebola súkromná a jediné, čo
-- ju chránilo, bolo, že sa nikto nepozrel.
--
-- Oprava nie je skopírovať podmienku z politiky do funkcie — dve kópie toho
-- istého pravidla sa rozídu pri prvej zmene a jedna z nich bude tá, ktorá
-- stráži dáta. Pravidlo dostane meno a obe miesta sa pýtajú jeho.
--
-- Druhá vec v tomto súbore: „Pre teba" a „Sledujem" nemajú pre neprihláseného
-- zmysel. „Pre teba" mu pritom vracalo úplne všetko, lebo podmienka
-- „nemá zaznamenané žiadne záujmy" platí aj na niekoho, kto nemá ani účet.
-- Celý web pod nadpisom, ktorý tvrdí, že je vybraný osobne preňho.
-- ============================================================================

-- --- pravidlo, ktoré má meno -------------------------------------------------
--
-- Berie id-čka ako argumenty a sama sa do `posts` nepozerá, takže sa smie
-- použiť aj v politike nad `posts` bez toho, aby sa zacyklila.
create or replace function public.can_see_post(
  p_event_id     uuid,
  p_community_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (p_event_id is null or public.can_view_event(p_event_id))
    and (
      p_community_id is null
      or public.is_community_member(p_community_id)
      or exists (
        select 1 from public.communities c
        where c.id = p_community_id and not c.is_private
      )
    );
$$;

revoke execute on function public.can_see_post(uuid, uuid) from public;
grant execute on function public.can_see_post(uuid, uuid) to anon, authenticated;

-- --- politika sa pýta toho istého pravidla -----------------------------------
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select using (
    not is_deleted
    and public.can_see_post(event_id, community_id)
  );

-- --- a feed tiež ------------------------------------------------------------
create or replace function public.feed_posts(
  p_scope text default 'for_you',
  p_limit integer default 50
)
returns setof public.posts
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as id),
  my_categories as (
    select distinct i.category
    from public.user_interests ui
    join public.interests i on i.id = ui.interest_id
    where ui.user_id = (select id from me)
    union
    select distinct e.category
    from public.event_attendees a
    join public.events e on e.id = a.event_id
    where a.user_id = (select id from me) and a.status in ('going', 'checked_in')
    union
    select distinct e.category
    from public.saved_events s
    join public.events e on e.id = s.event_id
    where s.user_id = (select id from me)
  )
  select p.*
  from public.posts p
  left join public.events e on e.id = p.event_id
  where not p.is_deleted
    -- Toto je tu nové a je to celá pointa súboru.
    and public.can_see_post(p.event_id, p.community_id)
    and (
      p_scope = 'all'
      or (
        p_scope = 'following'
        -- Bez účtu niet koho sledovať, takže tento pohľad je prázdny — nie
        -- „prázdny, a preto ti ukážeme všetko".
        and (select id from me) is not null
        and (
          exists (select 1 from public.follows f
                  where f.follower_id = (select id from me) and f.following_id = p.author_id)
          or exists (select 1 from public.community_members cm
                     where cm.user_id = (select id from me) and cm.community_id = p.community_id)
          or p.author_id = (select id from me)
        )
      )
      or (
        p_scope = 'for_you'
        and (select id from me) is not null
        and (
          e.category in (select category from my_categories)
          or exists (select 1 from public.follows f
                     where f.follower_id = (select id from me) and f.following_id = p.author_id)
          -- Prihlásený človek, ktorý si ešte nevybral záujmy, dostane všetko —
          -- prázdne „Pre teba" hneď po registrácii je horšie než široké.
          -- Neprihláseného sem už nepustí podmienka vyššie.
          or not exists (select 1 from my_categories)
        )
      )
    )
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke execute on function public.feed_posts(text, integer) from public;
grant execute on function public.feed_posts(text, integer) to anon, authenticated;
