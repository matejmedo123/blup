-- ============================================================================
-- BLUP · 0063 · The ranker, second pass
-- ============================================================================
-- v1 worked and had four real problems, one of them a plain bug:
--
--   1. BUG. Interest matching looked only at `events.category`. Multiple
--      categories arrived in 0050, so an event tagged techno *and* art has been
--      invisible to everybody who likes art ever since. That is not a tuning
--      question, it is a row that never appeared.
--
--   2. Popularity was a total, so it measured age. An event that filled up in
--      March outranked one selling out this week, for ever. What people mean by
--      trending is a rate, not a total — so it is measured over the last three
--      days and against capacity, because "80 % full" says more than "200
--      going".
--
--   3. Nothing decayed and nothing was ever tired. An event shown twenty times
--      and never opened kept its place. Real feedback cuts both ways: taste
--      from six months ago counts less than last week's, and something you
--      keep scrolling past goes down.
--
--   4. No sense of the shape of somebody's week or wallet. If every event you
--      have ever gone to was free and on a Saturday, a €40 Tuesday is not a
--      recommendation, it is a list.
--
-- And one thing that was missing rather than wrong: a brand-new event has no
-- attendees, so under v1 it could not be popular, and not being popular kept it
-- from being seen. A feed with no way in ossifies into the same twenty events.
-- There is now a small, explicit, decaying allowance for the genuinely new —
-- exploration, named as such, not hidden inside another term.
--
-- Weights (they sum to 1.00, and the boost is added on top, still capped by the
-- table's own constraint):
--
--   interest   0.26   what you said you like, across every category and tag
--   distance   0.18   how far, smoothly — no cliff at the radius edge
--   social     0.15   who you know is going, mutual follows worth more
--   behaviour  0.13   what you have actually done, decaying over 180 days
--   momentum   0.10   how fast it is filling *now*, and how full it is
--   time       0.08   how soon
--   fit        0.06   the day of week and the price you actually go to
--   fresh      0.04   a new event's chance to be seen at all
--   fatigue   −0.15   shown and ignored, repeatedly
-- ============================================================================

set search_path = public, extensions;

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
    select i.slug, i.category
    from public.user_interests ui
    join public.interests i on i.id = ui.interest_id
    where ui.user_id = p_user_id
  ),
  -- What they have actually done, per category, with older actions worth less.
  -- A half-life of sixty days: last month's taste counts roughly twice what the
  -- month before it does, which is about how fast people's plans change.
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
        end
        * s.weight
        * exp(-extract(epoch from (now() - s.created_at)) / (60.0 * 86400.0))
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
  -- The shape of their week and their wallet, from what they have gone to.
  -- Both are "no opinion" until there is enough to have one: three events.
  habits as (
    select
      count(*) as n,
      avg(case when extract(isodow from e.start_at) >= 5 then 1.0 else 0.0 end) as weekend_share,
      avg(case when e.is_free then 1.0 else 0.0 end) as free_share,
      avg(coalesce(e.price_cents, 0))::numeric as avg_price
    from public.user_event_signals s
    join public.events e on e.id = s.event_id
    where s.user_id = p_user_id
      and s.signal in ('rsvp_going', 'ticket_purchase', 'attended')
      and s.created_at > now() - interval '365 days'
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
      -- Mutual follows are worth more than one-way ones: somebody you follow
      -- back is a friend, somebody you follow is an interest.
      (
        select count(*)::integer
        from public.event_attendees a
        join public.follows f  on f.following_id = a.user_id and f.follower_id = p_user_id
        join public.follows f2 on f2.follower_id = a.user_id and f2.following_id = p_user_id
        where a.event_id = e.id and a.status in ('going', 'checked_in')
      ) as mutuals_going,
      exists (
        select 1 from public.follows f where f.follower_id = p_user_id and f.following_id = e.creator_id
      ) as follows_creator,
      -- THE FIX: every category the event carries, not only the primary one,
      -- and its tags. An event tagged techno and art is now visible to people
      -- who like either.
      (
        select count(distinct coalesce(mi.category, mi.slug))::numeric
        from my_interests mi
        where mi.slug = e.category
           or mi.category = e.category
           or mi.category = any(coalesce(e.categories, array[e.category]))
           or mi.slug = any(coalesce(e.categories, array[e.category]))
           or mi.slug = any(e.tags)
      ) as interest_hits,
      coalesce((select b.affinity from behaviour b where b.category = e.category), 0)::numeric
        as cat_affinity,
      -- Momentum: what happened in the last three days, not since the beginning.
      (
        select count(*)::numeric
        from public.user_event_signals s
        where s.event_id = e.id
          and s.signal in ('save', 'rsvp_going', 'ticket_purchase', 'open_detail')
          and s.created_at > now() - interval '3 days'
      ) as recent_signals,
      -- Seen and ignored. Opening it counts as interest and cancels the fatigue,
      -- so this only ever punishes the genuinely scrolled-past.
      (
        select count(*)::numeric
        from public.event_views v
        where v.event_id = e.id and v.user_id = p_user_id
          and v.created_at > now() - interval '14 days'
      ) as times_seen,
      exists (
        select 1 from public.user_event_signals s
        where s.user_id = p_user_id and s.event_id = e.id
          and s.signal in ('open_detail', 'save', 'rsvp_going', 'ticket_purchase', 'like')
      ) as ever_engaged
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
      -- 1. interest match: three matching interests is a perfect fit
      least(1.0, c.interest_hits / 3.0) as s_interest,
      -- 2. distance, smooth. A half-life of a third of the radius, so the score
      --    falls away steadily instead of stepping off a cliff at the edge —
      --    an event 100 m past the line is not worthless.
      case
        when c.distance_m is null then 0.5
        else exp(-c.distance_m / greatest(nullif(p_radius_m, 0) / 3.0, 1.0))
      end as s_distance,
      -- 3. social. A mutual counts double, and following the organizer is a
      --    weaker signal than a person you know actually going.
      least(1.0,
        ((c.friends_going + c.mutuals_going)::numeric / 3.0)
        + case when c.follows_creator then 0.3 else 0 end) as s_social,
      -- 4. past behaviour (normalised, clamped to 0..1)
      greatest(0.0, least(1.0, 0.5 + (c.cat_affinity / (2.0 * (select m from behaviour_max)))))
        as s_behaviour,
      -- 5. momentum: how fast it is moving now, and how full it is. Capacity is
      --    the stronger half when it is known — a room that is 90 % gone is a
      --    reason to hurry, and 200 going to a festival is not.
      least(1.0,
        0.6 * least(1.0, c.recent_signals / 15.0)
        + 0.4 * case
                  when c.capacity is null or c.capacity = 0
                    then least(1.0, c.attendee_count::numeric / 80.0)
                  else least(1.0, c.attendee_count::numeric / c.capacity)
                end
      ) as s_momentum,
      -- 6. time relevance: soon is better, 14-day horizon
      case
        when c.start_at < now() then 0.0
        when c.start_at <= now() + interval '24 hours' then 1.0
        else greatest(0.0,
          1.0 - (extract(epoch from (c.start_at - now())) / 3600.0 - 24.0) / (24.0 * 14.0))
      end as s_time,
      -- 7. fit: the day of the week and the price band this person actually
      --    goes to. Neutral (0.5) until they have been to three things, so a
      --    new account is not boxed in by one Tuesday.
      case
        when (select n from habits) < 3 then 0.5
        else
          0.5 * (case
                   when extract(isodow from c.start_at) >= 5
                     then (select weekend_share from habits)
                   else 1.0 - (select weekend_share from habits)
                 end)
          + 0.5 * (case
                     when c.is_free then (select free_share from habits)
                     when (select avg_price from habits) = 0 then 0.2
                     else greatest(0.0, 1.0 - abs(coalesce(c.price_cents, 0)
                          - (select avg_price from habits))
                          / greatest((select avg_price from habits) * 2.0, 1.0))
                   end)
      end as s_fit,
      -- 8. freshness: a small, decaying chance for an event nobody has had the
      --    opportunity to like yet. Full for the first day, gone after a week.
      greatest(0.0,
        1.0 - extract(epoch from (now() - c.created_at)) / (7.0 * 86400.0)) as s_fresh,
      -- 9. fatigue: shown repeatedly and never opened. Capped, so it can push
      --    something down the list but never bury it entirely.
      case
        when c.ever_engaged then 0.0
        else least(1.0, greatest(0.0, (c.times_seen - 2.0) / 6.0))
      end as s_fatigue
    from candidates c
    where c.distance_m is null or c.distance_m <= p_radius_m
  ),
  weighted as (
    select
      s.*,
      public.boost_weight_for(s.id) as s_boost,
      round(
        (0.26 * s.s_interest + 0.18 * s.s_distance + 0.15 * s.s_social +
         0.13 * s.s_behaviour + 0.10 * s.s_momentum + 0.08 * s.s_time +
         0.06 * s.s_fit + 0.04 * s.s_fresh
         - 0.15 * s.s_fatigue
         + public.boost_weight_for(s.id))::numeric,
        4
      ) as total_score
    from scored s
  ),
  final as (
    select
      w.*,
      -- Interest match is still the heaviest weight, so a list sorted purely on
      -- score comes out as eight techno nights in a row for anyone who likes
      -- techno — a filter, not a recommendation. Ranking within each category
      -- first takes the best of each before the second of any. A boosted event
      -- is exempt: it was paid for to sit at the top.
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
      'engine', 'sql_ranker_v2',
      'final_score', f.total_score,
      'components', jsonb_build_object(
        'interest_match',   round(f.s_interest::numeric, 4),
        'distance_score',   round(f.s_distance::numeric, 4),
        'social_relevance', round(f.s_social::numeric, 4),
        'past_behaviour',   round(f.s_behaviour::numeric, 4),
        'momentum',         round(f.s_momentum::numeric, 4),
        'time_relevance',   round(f.s_time::numeric, 4),
        'fit',              round(f.s_fit::numeric, 4),
        'freshness',        round(f.s_fresh::numeric, 4),
        'fatigue',          round(f.s_fatigue::numeric, 4),
        'boost',            round(f.s_boost::numeric, 4)
      ),
      'weights', jsonb_build_object(
        'interest_match', 0.26, 'distance_score', 0.18, 'social_relevance', 0.15,
        'past_behaviour', 0.13, 'momentum', 0.10, 'time_relevance', 0.08,
        'fit', 0.06, 'freshness', 0.04, 'fatigue', -0.15
      ),
      'facts', jsonb_build_object(
        'interest_hits', f.interest_hits,
        'friends_going', f.friends_going,
        'mutuals_going', f.mutuals_going,
        'follows_creator', f.follows_creator,
        'distance_m', round(coalesce(f.distance_m, 0)::numeric, 0),
        'category_affinity', round(f.cat_affinity, 2),
        'recent_signals', f.recent_signals,
        'times_seen', f.times_seen,
        'is_boosted', f.s_boost > 0
      ),
      -- Why this one, in words.
      --
      -- Mostly the argmax: whichever weighted component actually carried the
      -- score is the one named, so a card cannot claim a reason the ranking did
      -- not use. v1 used a fixed order of guesses and could say "interests"
      -- about an event that was ranked on distance.
      --
      -- Two deliberate exceptions, both stated rather than hidden. A paid
      -- placement is named as paid, whatever else was true of it. And somebody
      -- you know going is named even when a bigger term carried the score:
      -- it is true, it is the most useful true thing we can put on a card, and
      -- it is how people actually decide. The reason has to be true — it does
      -- not have to be the largest number.
      'reason', case
        when f.s_boost > 0 then 'promoted'
        when f.friends_going > 0 or f.mutuals_going > 0 then 'friends'
        else (
          select r.name from (values
            ('follows',   0.15 * f.s_social),
            ('interests', 0.26 * f.s_interest),
            ('behaviour', 0.13 * f.s_behaviour),
            ('nearby',    0.18 * f.s_distance),
            ('trending',  0.10 * f.s_momentum),
            ('soon',      0.08 * f.s_time),
            ('fits',      0.06 * f.s_fit),
            ('new',       0.04 * f.s_fresh)
          ) as r(name, contribution)
          order by r.contribution desc
          limit 1
        )
      end
    )
  from final f
  join public.profiles p on p.id = f.creator_id
  left join public.organizations o on o.id = f.organization_id
  order by f.category_rank asc, f.total_score desc, f.start_at asc
  limit greatest(1, least(coalesce(p_limit, 30), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

grant execute on function public.recommend_events(uuid, double precision, double precision,
                                                  double precision, integer, integer)
  to authenticated, anon;
