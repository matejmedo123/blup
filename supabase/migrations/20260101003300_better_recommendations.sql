-- ============================================================================
-- Better recommendations, and something to show a guest.
--
-- Three things were wrong with what the rail served.
--
-- It had no reason. The score breakdown existed for the debug screen, but the
-- card could not say "lebo tam idú tvoji ľudia" — so a recommendation looked
-- like a random pick. The reason is now derived from whichever weighted
-- component actually carried the score, so a card cannot claim something the
-- ranking did not use.
--
-- It had no variety. Interest match is the heaviest weight, so sorting purely
-- on score gave anyone who likes techno eight techno nights in a row. That is
-- a filter, not a recommendation. Ranking within each category first takes the
-- best of each before the second of any.
--
-- And it was empty for anyone not signed in: recommend_events keys off a user
-- id, and a guest has none. A guest cannot be given personal recommendations
-- honestly, but "what is on near you, soon, that people are going to" is a
-- real answer rather than a blank section.
-- ============================================================================

create or replace function public.recommend_events(
  p_user_id  uuid default auth.uid(),
  p_lat      double precision default null,
  p_lon      double precision default null,
  p_radius_m double precision default 50000,
  p_limit    integer default 30,
  p_offset   integer default 0
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public, extensions
as $$
  with
  viewer as (
    select
      coalesce(p_lat, pr.latitude)  as lat,
      coalesce(p_lon, pr.longitude) as lon
    from public.profiles pr
    where pr.id = p_user_id
  ),
  my_interests as (
    select i.slug, i.category, ui.weight
    from public.user_interests ui
    join public.interests i on i.id = ui.interest_id
    where ui.user_id = p_user_id
  ),
  interest_total as (
    select greatest(1, count(*))::numeric as n from my_interests
  ),
  -- Category affinity learned from past behaviour.
  behaviour as (
    select
      e.category,
      sum(
        case s.signal
          when 'swipe_right'     then 1.0
          when 'save'            then 1.5
          when 'rsvp_going'      then 2.0
          when 'rsvp_interested' then 1.0
          when 'ticket_purchase' then 3.0
          when 'attended'        then 3.0
          when 'like'            then 1.0
          when 'open_detail'     then 0.4
          when 'comment'         then 1.0
          when 'share'           then 1.0
          when 'swipe_left'      then -1.5
          else 0.0
        end * s.weight
      ) as affinity
    from public.user_event_signals s
    join public.events e on e.id = s.event_id
    where s.user_id = p_user_id
      and s.created_at > now() - interval '180 days'
    group by e.category
  ),
  behaviour_max as (
    select greatest(1.0, coalesce(max(abs(affinity)), 1.0)) as m from behaviour
  ),
  candidates as (
    select
      e.*,
      case
        when (select lat from viewer) is null then null
        else public.blup_distance_m((select lat from viewer), (select lon from viewer),
                                    e.latitude, e.longitude)
      end as distance_m,
      (
        select count(*)::integer
        from public.event_attendees a
        join public.follows f on f.following_id = a.user_id
        where a.event_id = e.id and a.status in ('going', 'checked_in')
          and f.follower_id = p_user_id
      ) as friends_going,
      exists (
        select 1 from public.follows f where f.follower_id = p_user_id and f.following_id = e.creator_id
      ) as follows_creator,
      (
        select count(*)::numeric
        from my_interests mi
        where mi.slug = e.category
           or mi.category = e.category
           or mi.slug = any (e.tags)
      ) as interest_hits,
      coalesce((select b.affinity from behaviour b where b.category = e.category), 0)::numeric as cat_affinity
    from public.events e
    where e.status = 'published'
      and e.visibility in ('public', 'unlisted')
      and e.start_at > now() - interval '2 hours'
      and e.creator_id <> p_user_id
      -- exclude what the user already dismissed
      and not exists (
        select 1 from public.user_event_signals s
        where s.user_id = p_user_id and s.event_id = e.id and s.signal = 'swipe_left'
      )
  ),
  scored as (
    select
      c.*,
      -- 1. interest match: 3 matching interests == perfect
      least(1.0, c.interest_hits / 3.0) as s_interest,
      -- 2. distance: linear decay inside the radius; unknown location == neutral
      case
        when c.distance_m is null then 0.5
        when c.distance_m > p_radius_m then 0.0
        else 1.0 - (c.distance_m / nullif(p_radius_m, 0))
      end as s_distance,
      -- 3. social relevance
      least(1.0, (c.friends_going::numeric / 3.0) + case when c.follows_creator then 0.34 else 0 end)
        as s_social,
      -- 4. past behaviour (normalised, clamped to 0..1)
      greatest(0.0, least(1.0, 0.5 + (c.cat_affinity / (2.0 * (select m from behaviour_max)))))
        as s_behaviour,
      -- 5. popularity
      least(1.0, (c.attendee_count + 0.5 * c.saved_count + 0.05 * c.view_count)::numeric / 50.0)
        as s_popularity,
      -- 6. time relevance: soon is better, 14-day horizon
      case
        when c.start_at < now() then 0.0
        when c.start_at <= now() + interval '24 hours' then 1.0
        else greatest(0.0,
          1.0 - (extract(epoch from (c.start_at - now())) / 3600.0 - 24.0) / (24.0 * 14.0))
      end as s_time
    from candidates c
    where c.distance_m is null or c.distance_m <= p_radius_m
  ),
  weighted as (
    select
      s.*,
      -- A paid boost adds to the organic score; it never replaces it, it is
      -- capped at 0.5 by the table's own constraint, and the card says so.
      public.boost_weight_for(s.id) as s_boost,
      round(
        (0.30 * s.s_interest + 0.22 * s.s_distance + 0.16 * s.s_social +
         0.14 * s.s_behaviour + 0.10 * s.s_popularity + 0.08 * s.s_time
         + public.boost_weight_for(s.id))::numeric,
        4
      ) as total_score
    from scored s
  ),
  final as (
    select
      w.*,
      -- Interest match is the heaviest weight, so a list sorted purely on
      -- score came out as eight techno nights in a row for anyone who likes
      -- techno — a filter, not a recommendation. Ranking within each category
      -- first takes the best of each before the second of any. A boosted event
      -- is exempt: it was paid for to sit at the top, and burying it behind
      -- the interleave would be selling something we do not deliver.
      case when w.s_boost > 0 then 0 else
        row_number() over (partition by w.category order by w.total_score desc)
      end as category_rank
    from weighted w
  )
  select
    f.id, f.title, f.description, f.cover_image_url, f.category, f.tags,
    f.latitude, f.longitude, f.address, f.venue_name, f.city,
    f.start_at, f.end_at, f.is_free, f.price_cents, f.currency, f.capacity,
    f.attendee_count, f.saved_count, f.like_count, f.comment_count,
    f.status, f.visibility,
    f.creator_id, p.username::text, p.display_name, p.avatar_url,
    f.organization_id, o.name, (o.verification_status = 'verified'),
    f.distance_m,
    f.friends_going,
    exists (select 1 from public.saved_events se where se.event_id = f.id and se.user_id = p_user_id),
    exists (select 1 from public.event_attendees a
            where a.event_id = f.id and a.user_id = p_user_id
              and a.status in ('going', 'interested', 'checked_in')),
    f.total_score,
    jsonb_build_object(
      'engine', 'sql_ranker_v1',
      'final_score', f.total_score,
      'components', jsonb_build_object(
        'interest_match',   round(f.s_interest::numeric, 4),
        'distance_score',   round(f.s_distance::numeric, 4),
        'social_relevance', round(f.s_social::numeric, 4),
        'past_behaviour',   round(f.s_behaviour::numeric, 4),
        'popularity',       round(f.s_popularity::numeric, 4),
        'time_relevance',   round(f.s_time::numeric, 4),
        'boost',            round(f.s_boost::numeric, 4)
      ),
      'weights', jsonb_build_object(
        'interest_match', 0.30, 'distance_score', 0.22, 'social_relevance', 0.16,
        'past_behaviour', 0.14, 'popularity', 0.10, 'time_relevance', 0.08
      ),
      'facts', jsonb_build_object(
        'interest_hits', f.interest_hits,
        'friends_going', f.friends_going,
        'follows_creator', f.follows_creator,
        'distance_m', round(coalesce(f.distance_m, 0)::numeric, 0),
        'category_affinity', round(f.cat_affinity, 2),
        'is_boosted', f.s_boost > 0
      ),
      -- Why this one, in words. Taken from whichever weighted component
      -- actually carried the score, so a card cannot claim a reason the
      -- ranking did not use. A paid boost is named as a boost rather than
      -- dressed up as one of the organic reasons.
      'reason', case
        when f.friends_going > 0 then 'friends'
        when f.follows_creator then 'follows'
        when f.s_interest >= 0.34 then 'interests'
        when f.s_behaviour >= 0.7 then 'behaviour'
        when f.distance_m is not null and f.distance_m <= 1500 then 'nearby'
        when f.s_time >= 0.9 then 'soon'
        when f.s_popularity >= 0.5 then 'popular'
        when f.s_boost > 0 then 'promoted'
        else 'discover'
      end
    )
  from final f
  join public.profiles p on p.id = f.creator_id
  left join public.organizations o on o.id = f.organization_id
  order by f.category_rank, f.total_score desc, f.start_at asc
  limit greatest(1, least(coalesce(p_limit, 30), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- ---------------------------------------------------------------------------
-- What to show somebody we know nothing about.
-- ---------------------------------------------------------------------------
create or replace function public.discover_events(
  p_lat      double precision default null,
  p_lon      double precision default null,
  p_radius_m double precision default 50000,
  p_limit    integer default 12
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with candidates as (
    select
      e.*,
      case
        when p_lat is null or p_lon is null then null
        else public.blup_distance_m(p_lat, p_lon, e.latitude, e.longitude)
      end as distance_m
    from public.events e
    where e.status = 'published'
      and e.visibility = 'public'
      and e.start_at > now() - interval '2 hours'
  ),
  scored as (
    select
      c.*,
      -- Nothing personal is known, so this is only three things: is it close,
      -- is it soon, are people going.
      (
        0.40 * case
          when c.distance_m is null then 0.5
          when c.distance_m > p_radius_m then 0.0
          else 1.0 - (c.distance_m / nullif(p_radius_m, 0))
        end
        + 0.35 * case
          when c.start_at < now() then 0.0
          when c.start_at <= now() + interval '48 hours' then 1.0
          else greatest(0.0, 1.0 - (extract(epoch from (c.start_at - now())) / 3600.0 - 48.0) / (24.0 * 14.0))
        end
        + 0.25 * least(1.0, (c.attendee_count + 0.5 * c.saved_count)::numeric / 40.0)
      )::numeric as total_score
    from candidates c
    where c.distance_m is null or c.distance_m <= p_radius_m
  ),
  ranked as (
    select s.*, row_number() over (partition by s.category order by s.total_score desc) as category_rank
    from scored s
  )
  select
    r.id, r.title, r.description, r.cover_image_url, r.category, r.tags,
    r.latitude, r.longitude, r.address, r.venue_name, r.city,
    r.start_at, r.end_at, r.is_free, r.price_cents, r.currency, r.capacity,
    r.attendee_count, r.saved_count, r.like_count, r.comment_count,
    r.status, r.visibility,
    r.creator_id, p.username::text, p.display_name, p.avatar_url,
    r.organization_id, o.name, (o.verification_status = 'verified'),
    r.distance_m,
    0,
    false,
    false,
    round(r.total_score, 4),
    jsonb_build_object(
      'engine', 'discover_v1',
      'final_score', round(r.total_score, 4),
      'reason', case
        when r.distance_m is not null and r.distance_m <= 1500 then 'nearby'
        when r.start_at <= now() + interval '48 hours' then 'soon'
        when r.attendee_count >= 10 then 'popular'
        else 'discover'
      end
    )
  from ranked r
  join public.profiles p on p.id = r.creator_id
  left join public.organizations o on o.id = r.organization_id
  order by r.category_rank, r.total_score desc, r.start_at asc
  limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

revoke execute on function public.discover_events(double precision, double precision, double precision, integer) from public;
grant execute on function public.discover_events(double precision, double precision, double precision, integer) to anon, authenticated;
