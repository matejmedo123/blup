-- ============================================================================
-- Keď niekto, koho sledujem, vytvorí event — nech to vidím vo feede.
--
-- The feed held posts and nothing else, so the single most useful thing a
-- person you follow ever does — announce that they are putting something on —
-- reached you only if you happened to open their profile.
--
-- No post row is written for this. Fabricating a post the organizer never
-- typed would put words in their mouth, and it would be a second copy of the
-- event that could drift out of date the moment they edited the real one. The
-- feed instead asks two questions and interleaves the answers by time: what
-- did people write, and what did they put on.
-- ============================================================================

create or replace function public.feed_new_events(
  p_scope text default 'following',
  p_limit integer default 20
)
returns table (
  id              uuid,
  slug            text,
  title           text,
  category        text,
  cover_image_url text,
  city            text,
  venue_name      text,
  start_at        timestamptz,
  is_free         boolean,
  price_cents     integer,
  currency        text,
  attendee_count  integer,
  created_at      timestamptz,
  creator_id      uuid,
  creator_name    text,
  creator_username text,
  creator_avatar_url text,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  organization_logo_url text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (select auth.uid() as id),
  -- Whose announcements count as mine to see: people I follow, organizations
  -- whose events I follow through their people, and myself.
  followed as (
    select f.following_id as person
    from public.follows f
    where f.follower_id = (select id from me)
    union
    select (select id from me)
  )
  select
    e.id, e.slug, e.title, e.category, e.cover_image_url, e.city, e.venue_name,
    e.start_at, e.is_free, e.price_cents, e.currency, e.attendee_count, e.created_at,
    p.id, p.display_name, p.username, p.avatar_url,
    o.id, o.name, o.slug, o.logo_url
  from public.events e
  join public.profiles p on p.id = e.creator_id
  left join public.organizations o on o.id = e.organization_id
  where e.status = 'published'
    and e.visibility = 'public'
    -- An announcement is news for as long as it is news. A month-old event
    -- that is still in the future does not belong at the top of a feed.
    and e.created_at > now() - interval '14 days'
    -- And there is no point announcing something that has already happened.
    and coalesce(e.end_at, e.start_at) > now()
    and (
      p_scope = 'all'
      or e.creator_id in (select person from followed)
    )
    -- "Pre teba" is about categories, the same way the posts half of it is.
    and (
      p_scope <> 'for_you'
      or e.creator_id in (select person from followed)
      or e.category in (
        select distinct i.category
        from public.user_interests ui
        join public.interests i on i.id = ui.interest_id
        where ui.user_id = (select id from me)
      )
    )
    and not p.is_suspended
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

revoke execute on function public.feed_new_events(text, integer) from public;
grant execute on function public.feed_new_events(text, integer) to anon, authenticated;

-- The counts that decide which tab opens first have to count what the tab
-- actually shows, or "Sledujem" reads as empty while it holds three events.
create or replace function public.feed_counts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'following', (select count(*) from public.feed_posts('following', 100))
               + (select count(*) from public.feed_new_events('following', 50)),
    'for_you',   (select count(*) from public.feed_posts('for_you', 100))
               + (select count(*) from public.feed_new_events('for_you', 50)),
    'all',       (select count(*) from public.feed_posts('all', 100))
               + (select count(*) from public.feed_new_events('all', 50))
  );
$$;

revoke execute on function public.feed_counts() from public;
grant execute on function public.feed_counts() to anon, authenticated;
