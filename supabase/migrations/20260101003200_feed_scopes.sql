-- ============================================================================
-- A feed that is about you.
--
-- It was every post on the platform, newest first — the same wall for
-- everybody, in which the people you actually know are a rounding error the
-- moment there are more than a few hundred users.
--
-- Three views instead:
--
--   following  people you follow and communities you are in
--   for_you    events in the categories you picked, plus what you have shown
--              interest in by going, saving and buying
--   all        everything, which is the honest fallback on an empty platform
--
-- The scope is decided in the database rather than by filtering a fetched page
-- in the app: filtering 50 rows down to the 3 from people you follow leaves a
-- feed that looks empty while the interesting posts sit on page two.
-- ============================================================================

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
  -- Categories this person has told us about, one way or another.
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
    and (
      p_scope = 'all'
      or (
        p_scope = 'following'
        and (
          exists (select 1 from public.follows f
                  where f.follower_id = (select id from me) and f.following_id = p.author_id)
          or exists (select 1 from public.community_members cm
                     where cm.user_id = (select id from me) and cm.community_id = p.community_id)
          -- Your own posts belong in the feed you asked to be personal.
          or p.author_id = (select id from me)
        )
      )
      or (
        p_scope = 'for_you'
        and (
          e.category in (select category from my_categories)
          or exists (select 1 from public.follows f
                     where f.follower_id = (select id from me) and f.following_id = p.author_id)
          -- Somebody with no interests recorded yet would otherwise get an
          -- empty "for you", which is the worst possible first impression.
          or not exists (select 1 from my_categories)
        )
      )
    )
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

revoke execute on function public.feed_posts(text, integer) from public;
grant execute on function public.feed_posts(text, integer) to anon, authenticated;

-- How full each view would be, so the app can open on one that has something
-- in it rather than showing an empty tab and letting the user hunt.
create or replace function public.feed_counts()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'following', (select count(*) from public.feed_posts('following', 100)),
    'for_you',   (select count(*) from public.feed_posts('for_you', 100)),
    'all',       (select count(*) from public.feed_posts('all', 100))
  );
$$;

revoke execute on function public.feed_counts() from public;
grant execute on function public.feed_counts() to anon, authenticated;
