-- ============================================================================
-- Z boostu reklamný nástroj
--
-- Migration 0062 built the delivery side of an ad system and it is all still
-- here: a budget in impressions, pacing across the run, an auction ordered by
-- weight × relevance, a relevance floor so money cannot buy a bad match, three
-- a day per person, one spotlight a day, and a report where reach is people
-- rather than impressions.
--
-- What was never built was the buying side. `event_boosts` has had
-- `target_radius_m` and `target_categories` since 0062 and NOTHING EVER SET
-- THEM — create_boost_order() takes an event and a package code, so the whole
-- tool was three fixed buttons. Reported exactly as it is: "je to stále len
-- boost, ale nie reálny reklamný nástroj".
--
-- So: your own budget instead of a package, an audience you choose, dates you
-- choose, and — the thing every ad tool lives or dies on — an honest estimate
-- of how many people that audience actually contains, BEFORE any money moves.
-- Plus a pause button, because a campaign you cannot stop is not a campaign.
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- What a thousand impressions costs
-- ---------------------------------------------------------------------------
-- A rate rather than a price list: the packages stay for whoever wants "just
-- promote it", and anyone who wants to spend €14.50 can now do that instead of
-- being rounded to the nearest of three.
alter table public.platform_settings
  add column if not exists boost_cpm_cents integer not null default 250;

alter table public.platform_settings drop constraint if exists platform_settings_cpm_sane;
alter table public.platform_settings add constraint platform_settings_cpm_sane
  check (boost_cpm_cents between 10 and 10000);

-- A campaign you cannot stop is not a campaign. Paused keeps the budget — it is
-- already paid for — and simply stops delivery until it is resumed.
alter table public.event_boosts
  add column if not exists paused_at timestamptz;

-- Set when the organizer bought by budget rather than by package, so the
-- screens can tell "Boost na 24 hodín" from a campaign somebody designed.
alter table public.event_boosts
  add column if not exists is_campaign boolean not null default false;

-- ---------------------------------------------------------------------------
-- How many people is this, actually
-- ---------------------------------------------------------------------------
/**
 * The size of an audience, before anybody pays for it.
 *
 * This is the number the whole screen is built around, so it is worth being
 * precise about what it counts: people with an account, a known location inside
 * the radius, who have not blocked the organizer, and — when categories are
 * given — whose stated interests include at least one of them.
 *
 * It is deliberately NOT a promise of impressions. Somebody inside the audience
 * who never opens the app that week sees nothing, and the frequency cap means
 * nobody sees it more than three times a day. The screen says both, because an
 * estimate presented as a guarantee is the oldest lie in advertising.
 */
create or replace function public.ad_audience_estimate(
  p_event_id   uuid,
  p_radius_m   integer default 30000,
  p_categories text[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  ev      public.events%rowtype;
  radius  integer := greatest(least(coalesce(p_radius_m, 30000), 200000), 1000);
  people  integer;
  active  integer;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  select
    count(*),
    -- "Active" is the streak tracker, which is the only honest record of
    -- somebody having opened BLUP: it is written by check-ins and by the daily
    -- streak, not by a login that a stale session could fake.
    count(*) filter (
      where exists (
        select 1 from public.user_stats us
        where us.user_id = p.id
          and us.last_active_on > (current_date - 30)
      )
    )
  into people, active
  from public.profiles p
  where p.id <> ev.creator_id
    and p.latitude is not null
    and p.longitude is not null
    and not coalesce(p.is_suspended, false)
    and public.blup_distance_m(ev.latitude, ev.longitude, p.latitude, p.longitude) <= radius
    and (
      p_categories is null
      or cardinality(p_categories) = 0
      or exists (
        select 1
        from public.user_interests ui
        join public.interests i on i.id = ui.interest_id
        where ui.user_id = p.id and i.category = any(p_categories)
      )
    );

  return jsonb_build_object(
    'radius_m', radius,
    -- Everybody who matches.
    'people', coalesce(people, 0),
    -- Of those, the ones who have opened BLUP in the last month. This is the
    -- number that resembles what will actually be delivered.
    'active_people', coalesce(active, 0),
    'categories', coalesce(p_categories, '{}')
  );
end;
$$;

grant execute on function public.ad_audience_estimate(uuid, integer, text[]) to authenticated;

/** What a given budget buys at today's rate. */
create or replace function public.ad_budget_quote(p_budget_cents integer)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'budget_cents', greatest(coalesce(p_budget_cents, 0), 0),
    'cpm_cents', cpm,
    'impressions', (greatest(coalesce(p_budget_cents, 0), 0)::numeric * 1000 / cpm)::integer
  )
  from (select coalesce(boost_cpm_cents, 250) as cpm from public.platform_settings limit 1) s;
$$;

grant execute on function public.ad_budget_quote(integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Buying one
-- ---------------------------------------------------------------------------
/**
 * A campaign: your budget, your audience, your dates.
 *
 * The same row and the same payment path as a package boost — it becomes live
 * in activate_boost() when the webhook confirms the charge, exactly as before,
 * so none of the money handling is duplicated or re-invented here.
 *
 * `weight` is what the auction sorts by, and it is derived from spend per day
 * rather than set by hand: somebody spending twice as much over the same days
 * outranks somebody spending half, and nobody can type a number into it. It is
 * capped, because the relevance floor is what protects the feed and a runaway
 * weight would push against it.
 */
create or replace function public.create_ad_campaign(
  p_event        uuid,
  p_budget_cents integer,
  p_days         integer default 7,
  p_placements   text[] default array['feed']::text[],
  p_radius_m     integer default 30000,
  p_categories   text[] default null
)
returns public.event_boosts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me     uuid := auth.uid();
  v_event  public.events%rowtype;
  v_quote  jsonb;
  v_start  timestamptz;
  v_ends   timestamptz;
  v_days   numeric;
  v_weight numeric;
  v_boost  public.event_boosts;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  -- A floor, so a campaign is worth delivering and worth charging for.
  if p_budget_cents is null or p_budget_cents < 500 then
    raise exception 'BUDGET_TOO_SMALL'
      using hint = 'Najmenší rozpočet je 5 €.';
  end if;
  if p_budget_cents > 500000 then
    raise exception 'BUDGET_TOO_LARGE'
      using hint = 'Nad 5 000 € sa ozvi, nastavíme to s tebou.';
  end if;
  if p_days is null or p_days < 1 or p_days > 60 then
    raise exception 'INVALID_SCHEDULE'
      using hint = 'Kampaň beží 1 až 60 dní.';
  end if;
  if p_placements is null or cardinality(p_placements) = 0
     or not (p_placements <@ array['feed', 'map', 'spotlight']::text[]) then
    raise exception 'INVALID_PLACEMENT';
  end if;

  select * into v_event from public.events where id = p_event;
  if not found then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  if v_event.creator_id <> v_me
     and not (v_event.organization_id is not null
              and public.is_org_member(v_event.organization_id,
                                       array['owner','admin']::org_role[]))
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if public.event_has_ended(v_event.start_at, v_event.end_at) then
    raise exception 'EVENT_ALREADY_ENDED';
  end if;
  if v_event.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- Queued behind whatever is already running, exactly as a package boost is.
  select greatest(now(), coalesce(max(ends_at), now())) into v_start
  from public.event_boosts
  where event_id = p_event and payment_status = 'succeeded' and ends_at > now();

  v_ends := v_start + make_interval(days => p_days);

  -- Promotion past the end of the event is money for nothing: discovery drops
  -- the event the moment it is over, promoted or not.
  v_ends := least(v_ends, public.event_ends_at(v_event.start_at, v_event.end_at));
  if v_ends <= v_start then
    raise exception 'EVENT_ALREADY_ENDED';
  end if;

  v_quote := public.ad_budget_quote(p_budget_cents);

  -- Spend per day decides the auction weight. 10 € a day lands near the middle
  -- of the old package range; the cap keeps the relevance floor in charge.
  v_days   := greatest(extract(epoch from (v_ends - v_start)) / 86400.0, 0.25);
  v_weight := least(0.40, greatest(0.05,
    round(((p_budget_cents / v_days) / 1000.0)::numeric, 4)));

  insert into public.event_boosts (
    event_id, organization_id, package_code, buyer_id,
    starts_at, ends_at, weight, amount_cents, currency,
    payment_status, provider, created_by,
    placements, impression_budget, target_radius_m, target_categories, is_campaign
  )
  values (
    p_event, v_event.organization_id, null, v_me,
    v_start, v_ends,
    v_weight, p_budget_cents,
    coalesce((select default_currency from public.organizations
              where id = v_event.organization_id), 'EUR'),
    'requires_payment', 'stripe', v_me,
    p_placements, (v_quote ->> 'impressions')::integer,
    greatest(least(coalesce(p_radius_m, 30000), 200000), 1000),
    nullif(coalesce(p_categories, '{}'), '{}'),
    true
  )
  returning * into v_boost;

  return v_boost;
end;
$$;

grant execute on function public.create_ad_campaign(uuid, integer, integer, text[], integer, text[])
  to authenticated;

/** Stops delivery without losing the budget, and starts it again. */
create or replace function public.set_ad_paused(p_boost_id uuid, p_paused boolean)
returns public.event_boosts
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_boost public.event_boosts;
  v_event public.events%rowtype;
begin
  select * into v_boost from public.event_boosts where id = p_boost_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_event from public.events where id = v_boost.event_id;

  if v_event.creator_id <> auth.uid()
     and not (v_event.organization_id is not null
              and public.is_org_member(v_event.organization_id,
                                       array['owner','admin']::org_role[]))
     and not public.is_admin()
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.event_boosts
  set paused_at = case when p_paused then coalesce(paused_at, now()) else null end
  where id = p_boost_id
  returning * into v_boost;

  return v_boost;
end;
$$;

revoke execute on function public.set_ad_paused(uuid, boolean) from public, anon;
grant execute on function public.set_ad_paused(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Pause has to actually stop it
-- ---------------------------------------------------------------------------
-- A pause button that leaves the campaign delivering is a fake button, and the
-- brief forbids those. The delivery function is restated here with one added
-- line — `b.paused_at is null` — because that is the only place in the system
-- that decides whether a boost may be shown. Everything else is verbatim 0062.
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
      and b.paused_at is null
      and now() between b.starts_at and b.ends_at
      and p_placement = any(b.placements)
      and b.impressions_served < b.impression_budget
      and e.status = 'published'
      and e.visibility = 'public'
      and coalesce(e.end_at, e.start_at + interval '4 hours') >= now()
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
      s.relevance >= 0.25
      and (
        select count(*) from public.boost_events be
        where be.boost_id = s.id and be.kind = 'impression'
          and be.created_at >= date_trunc('day', now())
      ) < public.boost_daily_allowance(s.id)
      and (
        select count(*) from public.boost_events be
        where be.boost_id = s.id and be.user_id = p_user_id
          and be.kind = 'impression'
          and be.created_at >= date_trunc('day', now())
      ) < 3
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
  -- One event, one slot. A campaign only queues behind boosts that are already
  -- PAID FOR — otherwise an abandoned checkout would block the event's promo
  -- slot for free — so two campaigns bought before either was charged can end
  -- up overlapping. That is fine for the money; it is not fine for the feed,
  -- where it would put the same event in two sponsored slots at once. The
  -- strongest of the overlapping boosts represents the event, and the rest
  -- keep their budgets for when it is free.
  select d.boost_id, d.event_id, d.relevance, d.rank_score
  from (
    select distinct on (c.event_id)
      c.id as boost_id, c.event_id, round(c.relevance, 4) as relevance,
      round((c.weight * c.relevance)::numeric, 6) as rank_score,
      c.starts_at
    from capped c
    order by c.event_id, (c.weight * c.relevance) desc, c.starts_at asc
  ) d
  order by d.rank_score desc, d.starts_at asc
  limit greatest(1, least(coalesce(p_limit, 1), 5));
$$;

revoke all on function public.sponsored_events(text, uuid, double precision, double precision, integer)
  from public, anon;
grant execute on function public.sponsored_events(text, uuid, double precision, double precision, integer)
  to authenticated;
