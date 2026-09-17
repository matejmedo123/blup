-- ============================================================================
-- BLUP · 0062 · Boost as an ad system, not as a number added to a score
-- ============================================================================
-- A boost used to be one thing: +0.10 to +0.22 on the ranking score for N
-- hours. Whatever that did, nobody could see it, the organizer got no report,
-- and it was sold by the hour rather than by how many people it reached. If
-- nothing was happening on the app that week, the money bought nothing.
--
-- This is the policy, and it is deliberately the one the big ad systems
-- converged on, for the reasons they converged on it:
--
--   1. PLACEMENTS.  A boost buys a *place*: the top of the feed, a highlighted
--      pin on the map, or one spotlight card a day. Not a nudge somewhere in
--      a list.
--
--   2. BUDGET, NOT HOURS.  A package buys a number of impressions. Time still
--      bounds it, but what is delivered is counted, and what is not delivered
--      is not charged for.
--
--   3. PACING.  The budget is spread across the remaining days instead of
--      burning out on the first evening. An organizer who boosts a week before
--      the event should still be visible on the day.
--
--   4. RELEVANCE FLOOR.  Money buys position, never relevance. A boosted event
--      is shown only to people it actually fits — right area, right kind of
--      thing, still in the future. Below the floor it is not shown at all, and
--      not charged for. This is the rule that keeps the feed worth opening,
--      which is the thing being sold in the first place.
--
--   5. AUCTION.  When several boosts qualify for one slot, the one that wins is
--      `weight × relevance`, not `weight`. Paying more cannot buy a worse match
--      past a better one.
--
--   6. FREQUENCY CAP.  The same person sees the same boosted event at most
--      three times a day, and at most one spotlight a day in total. Without
--      this, "pops up sometimes" becomes "pops up always" within a week.
--
--   7. LABELLED, ALWAYS.  Every sponsored placement says so on its face.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. What a boost buys
-- ---------------------------------------------------------------------------
alter table public.boost_packages
  add column if not exists impressions integer not null default 1000
    check (impressions > 0),
  add column if not exists placements text[] not null default array['feed']::text[];

alter table public.boost_packages
  drop constraint if exists boost_packages_placements_known;
alter table public.boost_packages
  add constraint boost_packages_placements_known check (
    placements <@ array['feed', 'map', 'spotlight']::text[] and cardinality(placements) > 0
  );

-- Priced so the cost per thousand impressions falls as the package grows, which
-- is both what an advertiser expects and what makes the weekly one worth
-- buying. €7 / 2500 ≈ €2.80 CPM.
update public.boost_packages set impressions = 2500,  placements = array['feed']
  where code = 'boost_24';
update public.boost_packages set impressions = 6000,  placements = array['feed', 'map']
  where code = 'boost_48';
update public.boost_packages set impressions = 25000, placements = array['feed', 'map', 'spotlight']
  where code = 'boost_7d';

alter table public.event_boosts
  add column if not exists placements          text[] not null default array['feed']::text[],
  add column if not exists impression_budget   integer not null default 1000,
  add column if not exists impressions_served  integer not null default 0,
  add column if not exists clicks              integer not null default 0,
  -- Who it may be shown to. Null means "the organic audience of this event",
  -- which is what an organizer means by leaving targeting alone.
  add column if not exists target_radius_m     integer,
  add column if not exists target_categories   text[];

-- ---------------------------------------------------------------------------
-- 2. What was actually delivered
-- ---------------------------------------------------------------------------
-- One row per impression and per click. It is the frequency cap, the pacing
-- and the report all at once, and it is the only honest basis for saying "your
-- boost reached 2 140 people" — a number derived from anything else is a guess
-- with a decimal point.
create table if not exists public.boost_events (
  id         bigserial primary key,
  boost_id   uuid not null references public.event_boosts (id) on delete cascade,
  event_id   uuid not null references public.events (id) on delete cascade,
  user_id    uuid references public.profiles (id) on delete set null,
  placement  text not null check (placement in ('feed', 'map', 'spotlight')),
  kind       text not null check (kind in ('impression', 'click')),
  created_at timestamptz not null default now()
);

create index if not exists boost_events_cap_idx
  on public.boost_events (boost_id, user_id, created_at desc);
create index if not exists boost_events_report_idx
  on public.boost_events (event_id, kind, created_at desc);
create index if not exists boost_events_spotlight_idx
  on public.boost_events (user_id, placement, created_at desc)
  where placement = 'spotlight';

alter table public.boost_events enable row level security;

-- Nobody reads this table directly. The organizer reads boost_report(), which
-- is where "only your own events" lives.
drop policy if exists boost_events_none on public.boost_events;
create policy boost_events_none on public.boost_events for select using (false);

-- ---------------------------------------------------------------------------
-- 3. Pacing
-- ---------------------------------------------------------------------------
/**
 * How much of the budget today's share is.
 *
 * Remaining budget divided by remaining days, with a floor so the last hours of
 * a boost are not throttled to nothing. Spending it evenly is not a nicety: an
 * organizer who boosts a week out and burns the whole budget on the first
 * evening has paid to be invisible on the day of the event.
 */
create or replace function public.boost_daily_allowance(p_boost_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $$
  select greatest(
    1,
    ceil(
      (b.impression_budget - b.impressions_served)::numeric
      / greatest(1, ceil(extract(epoch from (b.ends_at - greatest(now(), b.starts_at))) / 86400.0))
    )::integer
  )
  from public.event_boosts b
  where b.id = p_boost_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Who may be shown what
-- ---------------------------------------------------------------------------
/**
 * The sponsored slots for this person, right now, in order.
 *
 * Everything in the header is applied here, in one place, so there is exactly
 * one answer to "why did I see this": it was paid for, it had budget left, it
 * had not been shown to me too often, and it actually fits me.
 *
 * Relevance is deliberately a *subset* of the organic ranker — area, category,
 * and how soon it is. Running the full ranker per candidate would be slower and
 * would not change the outcome: the floor exists to exclude the obviously
 * wrong, not to re-sort the plausibly right.
 */
create or replace function public.sponsored_events(
  p_placement text,
  p_user_id   uuid default auth.uid(),
  p_lat       double precision default null,
  p_lon       double precision default null,
  p_limit     integer default 1
)
returns table (
  boost_id   uuid,
  event_id   uuid,
  relevance  numeric,
  rank_score numeric
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (
    select
      coalesce(p_lat, pr.latitude)  as lat,
      coalesce(p_lon, pr.longitude) as lon
    from public.profiles pr
    where pr.id = p_user_id
  ),
  taste as (
    select distinct i.category
    from public.user_interests ui
    join public.interests i on i.id = ui.interest_id
    where ui.user_id = p_user_id and i.category is not null
  ),
  live as (
    select b.*, e.category, e.categories, e.latitude, e.longitude, e.start_at, e.end_at,
           e.status, e.visibility, e.creator_id
    from public.event_boosts b
    join public.events e on e.id = b.event_id
    where b.payment_status = 'succeeded'
      and now() between b.starts_at and b.ends_at
      and p_placement = any(b.placements)
      -- Budget, and today's share of it.
      and b.impressions_served < b.impression_budget
      and e.status = 'published'
      and e.visibility = 'public'
      and coalesce(e.end_at, e.start_at + interval '4 hours') >= now()
      -- Never to the person who is paying for it.
      and e.creator_id is distinct from p_user_id
  ),
  eligible as (
    select
      l.*,
      case
        when m.lat is null or l.latitude is null then null
        else public.blup_distance_m(m.lat, m.lon, l.latitude, l.longitude)
      end as distance_m,
      exists (
        select 1 from taste t
        where t.category = l.category
           or t.category = any(coalesce(l.categories, array[l.category]))
      ) as matches_taste
    from live l, me m
  ),
  scored as (
    select
      e.*,
      -- The floor, as a number. Area is worth more than taste here: an event
      -- two hours away that matches perfectly is still not somewhere most
      -- people are going on a Tuesday.
      (
        case
          when e.distance_m is null then 0.35
          when e.distance_m <= coalesce(e.target_radius_m, 30000) then
            0.65 * (1.0 - (e.distance_m / greatest(coalesce(e.target_radius_m, 30000), 1))::numeric)
          else 0.0
        end
        + case when e.matches_taste then 0.35 else 0.0 end
      )::numeric as relevance
    from eligible e
    where
      -- Explicit targeting, when the organizer set any.
      (e.target_categories is null
       or e.category = any(e.target_categories)
       or e.categories && e.target_categories)
      and (e.target_radius_m is null or e.distance_m is null
           or e.distance_m <= e.target_radius_m)
  ),
  capped as (
    select s.*
    from scored s
    where
      -- The floor. Below it the money buys nothing, which is the point.
      s.relevance >= 0.25
      -- Today's pacing share.
      and (
        select count(*) from public.boost_events be
        where be.boost_id = s.id and be.kind = 'impression'
          and be.created_at >= date_trunc('day', now())
      ) < public.boost_daily_allowance(s.id)
      -- The same event, at most three times a day, to the same person.
      and (
        select count(*) from public.boost_events be
        where be.boost_id = s.id and be.user_id = p_user_id
          and be.kind = 'impression'
          and be.created_at >= date_trunc('day', now())
      ) < 3
      -- And at most one spotlight a day in total, across every advertiser.
      and (
        p_placement <> 'spotlight'
        or not exists (
          select 1 from public.boost_events be
          where be.user_id = p_user_id and be.placement = 'spotlight'
            and be.kind = 'impression'
            and be.created_at >= date_trunc('day', now())
        )
      )
  )
  select
    c.id, c.event_id, round(c.relevance, 4),
    -- The auction. Weight is what was paid for; relevance is how well it fits.
    -- Multiplied, so paying more cannot buy a worse match past a better one.
    round((c.weight * c.relevance)::numeric, 6) as rank_score
  from capped c
  order by rank_score desc, c.starts_at asc
  limit greatest(1, least(coalesce(p_limit, 1), 5));
$$;

revoke all on function public.sponsored_events(text, uuid, double precision, double precision, integer)
  from public, anon;
grant execute on function public.sponsored_events(text, uuid, double precision, double precision, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Counting it
-- ---------------------------------------------------------------------------
/**
 * Records that a sponsored placement was actually on screen, or clicked.
 *
 * Called by the app, which is why it is not the basis for anything the app
 * could profit from lying about: it can only *spend* somebody's budget, never
 * extend it. A double-counted impression costs the advertiser reach; an
 * uncounted one costs them nothing.
 *
 * An impression that would take the boost past its budget is still recorded —
 * the alternative is a race where two screens both check "is there budget" and
 * both show it. Overshooting by one is cheaper than a lock on every view.
 */
create or replace function public.record_boost_event(
  p_boost_id  uuid,
  p_placement text,
  p_kind      text default 'impression'
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  b public.event_boosts;
begin
  if auth.uid() is null or p_boost_id is null then
    return;
  end if;
  if p_kind not in ('impression', 'click') then
    raise exception 'INVALID_KIND';
  end if;
  if p_placement not in ('feed', 'map', 'spotlight') then
    raise exception 'INVALID_PLACEMENT';
  end if;

  select * into b from public.event_boosts where id = p_boost_id;
  if not found or b.payment_status <> 'succeeded' then
    return;
  end if;

  -- The organizer's own screens do not spend their own budget.
  if exists (
    select 1 from public.events e
    where e.id = b.event_id and e.creator_id = auth.uid()
  ) then
    return;
  end if;

  insert into public.boost_events (boost_id, event_id, user_id, placement, kind)
  values (p_boost_id, b.event_id, auth.uid(), p_placement, p_kind);

  if p_kind = 'impression' then
    update public.event_boosts
    set impressions_served = impressions_served + 1
    where id = p_boost_id;
  else
    update public.event_boosts set clicks = clicks + 1 where id = p_boost_id;
  end if;
end;
$$;

revoke all on function public.record_boost_event(uuid, text, text) from public, anon;
grant execute on function public.record_boost_event(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. What the organizer gets back
-- ---------------------------------------------------------------------------
/**
 * The report. Reach, clicks, what it cost per click, and how many tickets came
 * out of it.
 *
 * Attribution is deliberately narrow and stated: a ticket counts only when the
 * same person clicked the boost first and ordered within 24 hours. Every wider
 * definition flatters the ad, and an organizer deciding whether to spend again
 * deserves the number that is defensible rather than the one that sells another
 * boost.
 */
create or replace function public.boost_report(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  out_json jsonb;
begin
  perform public.assert_can_read_event_stats(p_event_id);

  select coalesce(jsonb_agg(row_to_json(r)::jsonb order by r.starts_at desc), '[]'::jsonb)
  into out_json
  from (
    select
      b.id,
      b.package_code,
      b.starts_at,
      b.ends_at,
      b.placements,
      b.amount_cents,
      b.currency,
      b.impression_budget,
      b.impressions_served,
      b.clicks,
      (select count(distinct be.user_id) from public.boost_events be
        where be.boost_id = b.id and be.kind = 'impression') as people_reached,
      case when b.impressions_served = 0 then 0
           else round(100.0 * b.clicks / b.impressions_served, 2) end as ctr_pct,
      case when b.clicks = 0 then null
           else round(b.amount_cents::numeric / b.clicks, 1) end as cost_per_click_cents,
      -- Tickets, narrowly: clicked, then bought, within a day.
      (
        select count(*)
        from public.orders o
        where o.event_id = b.event_id
          and o.paid_at is not null
          and o.buyer_id is not null
          and exists (
            select 1 from public.boost_events be
            where be.boost_id = b.id and be.kind = 'click'
              and be.user_id = o.buyer_id
              and be.created_at <= o.paid_at
              and be.created_at >= o.paid_at - interval '24 hours'
          )
      ) as tickets_attributed
    from public.event_boosts b
    where b.event_id = p_event_id and b.payment_status = 'succeeded'
  ) r;

  return out_json;
end;
$$;

revoke all on function public.boost_report(uuid) from public, anon;
grant execute on function public.boost_report(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. A boost carries its package's budget and placements
-- ---------------------------------------------------------------------------
-- A trigger rather than an edit to create_boost_order(), so every path that
-- ever creates a boost — the checkout, an admin, the free Premium one below —
-- gets the same budget without three copies of the same lookup drifting apart.
create or replace function public.apply_boost_package()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  pkg public.boost_packages;
begin
  if new.package_code is null then
    return new;
  end if;

  select * into pkg from public.boost_packages where code = new.package_code;
  if not found then
    return new;
  end if;

  -- Only when the caller did not say otherwise: an admin handing out a custom
  -- boost, or the weekly Premium one, sets its own and must keep it.
  if new.impression_budget is null or new.impression_budget = 1000 then
    new.impression_budget := pkg.impressions;
  end if;
  if new.placements is null or new.placements = array['feed']::text[] then
    new.placements := pkg.placements;
  end if;

  return new;
end;
$$;

drop trigger if exists event_boosts_apply_package on public.event_boosts;
create trigger event_boosts_apply_package
  before insert on public.event_boosts
  for each row execute function public.apply_boost_package();

-- ---------------------------------------------------------------------------
-- 8. The free boost that comes with Premium
-- ---------------------------------------------------------------------------
-- One a week, for one of your own events. Not a discount code and not a
-- balance: a right that either has been used this week or has not, which is the
-- version somebody can hold in their head.
create table if not exists public.boost_credits (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  boost_id   uuid references public.event_boosts (id) on delete set null,
  event_id   uuid references public.events (id) on delete set null,
  -- The Monday of the week it was spent in, so "one a week" needs no cron and
  -- cannot be reset by anything the client does.
  week_start date not null,
  created_at timestamptz not null default now(),
  constraint boost_credits_one_per_week unique (user_id, week_start)
);

alter table public.boost_credits enable row level security;

drop policy if exists boost_credits_select on public.boost_credits;
create policy boost_credits_select on public.boost_credits
  for select using (user_id = auth.uid() or public.is_admin());

create or replace function public.my_free_boost()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'is_premium', public.is_premium(auth.uid()),
    'available', public.is_premium(auth.uid()) and not exists (
      select 1 from public.boost_credits c
      where c.user_id = auth.uid()
        and c.week_start = date_trunc('week', now())::date
    ),
    'used_at', (
      select c.created_at from public.boost_credits c
      where c.user_id = auth.uid()
        and c.week_start = date_trunc('week', now())::date
    ),
    'renews_at', (date_trunc('week', now()) + interval '7 days')
  );
$$;

revoke all on function public.my_free_boost() from public, anon;
grant execute on function public.my_free_boost() to authenticated;

/**
 * Spends this week's free boost on one of your own events.
 *
 * Deliberately the smallest package: the free one is a taste of the thing, not
 * a replacement for it. The unique index on (user_id, week_start) is what
 * enforces "one a week" — a check-then-insert would race with itself the moment
 * somebody double-taps.
 */
create or replace function public.claim_free_boost(p_event_id uuid)
returns public.event_boosts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me    uuid := auth.uid();
  ev    public.events;
  pkg   public.boost_packages;
  boost public.event_boosts;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  if not public.is_premium(me) then
    raise exception 'PREMIUM_REQUIRED'
      using hint = 'Boost zadarmo raz za týždeň má Premium.';
  end if;

  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if ev.creator_id <> me
     and not (ev.organization_id is not null
              and public.is_org_member(ev.organization_id,
                    array['owner', 'admin', 'event_manager']::org_role[]))
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if public.event_has_ended(ev.start_at, ev.end_at) then
    raise exception 'EVENT_ALREADY_ENDED';
  end if;
  if ev.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  select * into pkg from public.boost_packages
  where is_active order by price_cents limit 1;
  if not found then
    raise exception 'NO_PACKAGE';
  end if;

  insert into public.event_boosts (
    event_id, organization_id, package_code, buyer_id,
    starts_at, ends_at, weight, amount_cents, currency,
    payment_status, provider, provider_reference, paid_at, created_by
  )
  values (
    ev.id, ev.organization_id, pkg.code, me,
    now(), now() + make_interval(hours => pkg.hours),
    pkg.weight, 0, pkg.currency,
    'succeeded', 'manual', 'premium_free_' || me || '_' || date_trunc('week', now())::date,
    now(), me
  )
  returning * into boost;

  -- The unique index is the rule. A second call in the same week fails here,
  -- and the boost above goes with it.
  insert into public.boost_credits (user_id, boost_id, event_id, week_start)
  values (me, boost.id, ev.id, date_trunc('week', now())::date);

  return boost;
end;
$$;

revoke all on function public.claim_free_boost(uuid) from public, anon;
grant execute on function public.claim_free_boost(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Feed rows for a handful of ids
-- ---------------------------------------------------------------------------
-- A sponsored card is an ordinary card, so it needs an ordinary feed row —
-- distance, whether it is saved, how many friends are going. Fetching the
-- *detail* shape instead and reshaping it in the client is how two cards of the
-- same event end up looking different.
create or replace function public.events_for_cards(
  p_ids uuid[],
  p_lat double precision default null,
  p_lon double precision default null
)
returns setof public.event_feed_item
language sql
stable
security definer
set search_path = public, extensions
as $$
  with me as (select auth.uid() as uid)
  select
    e.id, e.title, e.description, e.cover_image_url, e.category, e.tags,
    e.latitude, e.longitude, e.address, e.venue_name, e.city,
    e.start_at, e.end_at, e.is_free, e.price_cents, e.currency, e.capacity,
    e.attendee_count, e.saved_count, e.like_count, e.comment_count,
    e.status, e.visibility,
    e.creator_id, p.username::text, p.display_name, p.avatar_url,
    e.organization_id, o.name, (o.verification_status = 'verified'),
    public.blup_distance_m(
      coalesce(p_lat, (select pr.latitude from public.profiles pr where pr.id = (select uid from me))),
      coalesce(p_lon, (select pr.longitude from public.profiles pr where pr.id = (select uid from me))),
      e.latitude, e.longitude) as distance_m,
    (
      select count(*)::integer from public.event_attendees a
      join public.follows f on f.following_id = a.user_id
      where a.event_id = e.id and a.status in ('going', 'checked_in')
        and f.follower_id = (select uid from me)
    ) as friends_going,
    exists (select 1 from public.saved_events s
            where s.event_id = e.id and s.user_id = (select uid from me)) as is_saved,
    exists (select 1 from public.event_attendees a
            where a.event_id = e.id and a.user_id = (select uid from me)
              and a.status in ('going', 'interested', 'checked_in')) as is_attending,
    null::numeric as score,
    -- Named as sponsored, so the card cannot accidentally present a paid
    -- placement as an editorial one.
    jsonb_build_object('facts', jsonb_build_object('is_boosted', true),
                       'reason', 'promoted') as score_breakdown
  from public.events e
  join public.profiles p on p.id = e.creator_id
  left join public.organizations o on o.id = e.organization_id
  where e.id = any(p_ids)
    and e.status = 'published'
    and e.visibility in ('public', 'unlisted');
$$;

revoke all on function public.events_for_cards(uuid[], double precision, double precision)
  from public, anon;
grant execute on function public.events_for_cards(uuid[], double precision, double precision)
  to authenticated;
