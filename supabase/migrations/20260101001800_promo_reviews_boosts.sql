-- ============================================================================
-- BLUP · 0018 · Organizer promo tools, post-event feedback, event boosts
-- ============================================================================
-- Three things the concept document asks for on the organizer side:
--
--   promo_codes    "promo kódy" — a discount applied server-side at checkout
--   event_reviews  "feedback po evente" — a rating only an attendee can leave
--   event_boosts   "boost" — paid visibility, which the ranker reads
--
-- The discount is deliberately NOT something the client computes. The app may
-- preview a code, but the price that is charged is recalculated by the database
-- when the order is created, exactly like the base price already is.
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'discount_kind') then
    create type discount_kind as enum ('percent', 'fixed');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Promo codes
-- ---------------------------------------------------------------------------
create table if not exists public.promo_codes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  event_id        uuid references public.events (id) on delete cascade,
  code            citext not null,
  kind            discount_kind not null default 'percent',
  -- percent → 1..100, fixed → minor units off the total
  value           integer not null check (value > 0),
  max_uses        integer check (max_uses > 0),
  used_count      integer not null default 0,
  starts_at       timestamptz,
  ends_at         timestamptz,
  is_active       boolean not null default true,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),

  constraint promo_codes_percent_range check (kind <> 'percent' or value between 1 and 100),
  -- A code belongs to an event or to an organization, not to nothing.
  constraint promo_codes_scope check (event_id is not null or organization_id is not null),
  constraint promo_codes_code_format check (code ~ '^[A-Za-z0-9_-]{3,24}$')
);

create unique index if not exists promo_codes_event_code_idx
  on public.promo_codes (event_id, code) where event_id is not null;
create unique index if not exists promo_codes_org_code_idx
  on public.promo_codes (organization_id, code) where event_id is null;

create table if not exists public.promo_redemptions (
  id            uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.promo_codes (id) on delete cascade,
  order_id      uuid references public.orders (id) on delete set null,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  amount_off    integer not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists promo_redemptions_code_idx
  on public.promo_redemptions (promo_code_id);

/**
 * What a code is worth on a given subtotal, or an error code explaining why it
 * is not worth anything. Used both for the preview in the app and by the order
 * path — one implementation, so the preview can never disagree with the charge.
 */
create or replace function public.evaluate_promo_code(
  p_event    uuid,
  p_code     text,
  p_subtotal integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_promo public.promo_codes%rowtype;
  v_org   uuid;
  v_off   integer;
begin
  select organization_id into v_org from public.events where id = p_event;

  select * into v_promo
  from public.promo_codes
  where is_active
    and code = p_code
    and (event_id = p_event or (event_id is null and organization_id is not null and organization_id = v_org))
  order by event_id nulls last
  limit 1;

  if not found then
    return jsonb_build_object('valid', false, 'reason', 'PROMO_NOT_FOUND', 'amount_off', 0);
  end if;

  if v_promo.starts_at is not null and now() < v_promo.starts_at then
    return jsonb_build_object('valid', false, 'reason', 'PROMO_NOT_STARTED', 'amount_off', 0);
  end if;

  if v_promo.ends_at is not null and now() > v_promo.ends_at then
    return jsonb_build_object('valid', false, 'reason', 'PROMO_EXPIRED', 'amount_off', 0);
  end if;

  if v_promo.max_uses is not null and v_promo.used_count >= v_promo.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'PROMO_EXHAUSTED', 'amount_off', 0);
  end if;

  v_off := case v_promo.kind
    when 'percent' then (p_subtotal * v_promo.value) / 100
    else v_promo.value
  end;

  -- Never discount below zero, and never turn a discount into a payout.
  v_off := least(greatest(v_off, 0), greatest(p_subtotal, 0));

  return jsonb_build_object(
    'valid', true,
    'promo_code_id', v_promo.id,
    'kind', v_promo.kind,
    'value', v_promo.value,
    'amount_off', v_off,
    'total_after', greatest(p_subtotal - v_off, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Post-event feedback
--
-- Only somebody who was actually going can rate, and only once the event has
-- started. A review is public; the organizer sees the aggregate on their
-- analytics screen.
-- ---------------------------------------------------------------------------
create table if not exists public.event_reviews (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  rating     integer not null check (rating between 1 and 5),
  body       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, user_id),
  constraint event_reviews_body_len check (body is null or char_length(body) <= 2000)
);

create index if not exists event_reviews_event_idx
  on public.event_reviews (event_id, created_at desc);

drop trigger if exists event_reviews_set_updated_at on public.event_reviews;
create trigger event_reviews_set_updated_at
  before update on public.event_reviews
  for each row execute function public.set_updated_at();

/** Leaves or updates a review. Enforces "you were there" and "it has started". */
create or replace function public.review_event(
  p_event  uuid,
  p_rating integer,
  p_body   text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me    uuid := auth.uid();
  v_start timestamptz;
  v_went  boolean;
  v_id    uuid;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'INVALID_RATING';
  end if;

  select start_at into v_start from public.events where id = p_event;
  if not found then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  if now() < v_start then
    raise exception 'EVENT_NOT_STARTED';
  end if;

  select exists (
    select 1 from public.event_attendees
    where event_id = p_event and user_id = v_me and status in ('going', 'checked_in')
  ) into v_went;

  if not v_went then
    raise exception 'NOT_ATTENDED';
  end if;

  insert into public.event_reviews (event_id, user_id, rating, body)
  values (p_event, v_me, p_rating, nullif(btrim(coalesce(p_body, '')), ''))
  on conflict (event_id, user_id) do update
    set rating = excluded.rating,
        body = excluded.body,
        updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.event_rating(p_event uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'count', count(*),
    'average', round(coalesce(avg(rating), 0)::numeric, 2)
  )
  from public.event_reviews
  where event_id = p_event;
$$;

-- ---------------------------------------------------------------------------
-- Boosts
--
-- Paid visibility. The ranker adds the boost weight to an event's score while
-- the boost is live — and the app labels a boosted card, because a promoted
-- result that does not say it is promoted is a dark pattern.
-- ---------------------------------------------------------------------------
create table if not exists public.event_boosts (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz not null,
  weight          numeric(4,2) not null default 0.15 check (weight > 0 and weight <= 0.5),
  amount_cents    integer not null default 0 check (amount_cents >= 0),
  currency        text not null default 'EUR',
  order_id        uuid references public.orders (id) on delete set null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint event_boosts_window check (ends_at > starts_at)
);

create index if not exists event_boosts_live_idx
  on public.event_boosts (event_id, ends_at desc);

create or replace function public.boost_weight_for(p_event uuid)
returns numeric
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(max(weight), 0)
  from public.event_boosts
  where event_id = p_event
    and now() between starts_at and ends_at;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.promo_codes       enable row level security;
alter table public.promo_redemptions enable row level security;
alter table public.event_reviews     enable row level security;
alter table public.event_boosts      enable row level security;

-- Promo codes are readable only by the organizer who owns them. A buyer never
-- lists codes, they type one and the database evaluates it.
drop policy if exists promo_codes_select on public.promo_codes;
create policy promo_codes_select on public.promo_codes
  for select using (
    public.is_admin()
    or (organization_id is not null
        and public.is_org_member(organization_id, array['owner','admin','finance']::org_role[]))
    or exists (
      select 1 from public.events e
      where e.id = event_id
        and (e.creator_id = auth.uid()
             or (e.organization_id is not null
                 and public.is_org_member(e.organization_id,
                                          array['owner','admin','finance']::org_role[])))
    )
  );

drop policy if exists promo_codes_write on public.promo_codes;
create policy promo_codes_write on public.promo_codes
  for all using (
    public.is_admin()
    or (organization_id is not null
        and public.is_org_member(organization_id, array['owner','admin']::org_role[]))
    or exists (
      select 1 from public.events e
      where e.id = event_id and e.creator_id = auth.uid()
    )
  )
  with check (
    public.is_admin()
    or (organization_id is not null
        and public.is_org_member(organization_id, array['owner','admin']::org_role[]))
    or exists (
      select 1 from public.events e
      where e.id = event_id and e.creator_id = auth.uid()
    )
  );

drop policy if exists promo_redemptions_select on public.promo_redemptions;
create policy promo_redemptions_select on public.promo_redemptions
  for select using (user_id = auth.uid() or public.is_admin());

-- Reviews are public; you write only your own, and only through review_event().
drop policy if exists event_reviews_select on public.event_reviews;
create policy event_reviews_select on public.event_reviews for select using (true);

drop policy if exists event_reviews_delete_own on public.event_reviews;
create policy event_reviews_delete_own on public.event_reviews
  for delete using (user_id = auth.uid() or public.is_admin());

drop policy if exists event_boosts_select on public.event_boosts;
create policy event_boosts_select on public.event_boosts for select using (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update on public.event_reviews from authenticated';
    execute 'revoke insert, update, delete on
               public.promo_redemptions, public.event_boosts from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.promo_codes, public.promo_redemptions from anon';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Wiring the discount into the order path.
--
-- create_order() gains an optional promo code. The discount is computed here,
-- server-side, from the same function the preview uses — the app never sends a
-- price. The platform fee is taken on what is actually paid, not on the list
-- price, so a discount is funded by the organizer and not by BLUP's cut being
-- silently topped up.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column if not exists discount_cents integer not null default 0
    check (discount_cents >= 0);

alter table public.orders
  add column if not exists promo_code_id uuid references public.promo_codes (id) on delete set null;

-- The three-argument version from 0006 must go, or a call with three arguments
-- becomes ambiguous against the new one's default.
drop function if exists public.create_order(uuid, uuid, integer);

create or replace function public.create_order(
  p_buyer_id       uuid,
  p_ticket_type_id uuid,
  p_quantity       integer,
  p_promo_code     text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  tt        record;
  ev        record;
  org       record;
  fee_bps   integer;
  subtotal  integer;
  discount  integer := 0;
  total     integer;
  fee       integer;
  promo     jsonb;
  promo_id  uuid;
  new_order public.orders;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'INVALID_QUANTITY';
  end if;

  select * into tt from public.ticket_types where id = p_ticket_type_id for update;
  if not found then
    raise exception 'TICKET_TYPE_NOT_FOUND';
  end if;
  if not tt.is_active then
    raise exception 'TICKET_TYPE_INACTIVE';
  end if;
  if p_quantity > tt.max_per_order then
    raise exception 'QUANTITY_ABOVE_LIMIT';
  end if;
  if tt.sales_start_at is not null and now() < tt.sales_start_at then
    raise exception 'SALES_NOT_STARTED';
  end if;
  if tt.sales_end_at is not null and now() > tt.sales_end_at then
    raise exception 'SALES_ENDED';
  end if;
  if tt.quantity_sold + p_quantity > tt.quantity_total then
    raise exception 'SOLD_OUT';
  end if;

  select * into ev from public.events where id = tt.event_id;
  if ev.status <> 'published' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;
  if ev.organization_id is null then
    raise exception 'PAID_EVENT_REQUIRES_ORGANIZATION';
  end if;

  select * into org from public.organizations where id = ev.organization_id;
  fee_bps  := coalesce(org.platform_fee_bps, 300);
  subtotal := tt.price_cents * p_quantity;

  if p_promo_code is not null and btrim(p_promo_code) <> '' then
    promo := public.evaluate_promo_code(ev.id, btrim(p_promo_code), subtotal);

    if not (promo->>'valid')::boolean then
      raise exception '%', promo->>'reason';
    end if;

    discount := (promo->>'amount_off')::integer;
    promo_id := (promo->>'promo_code_id')::uuid;
  end if;

  total := greatest(subtotal - discount, 0);
  fee   := (total * fee_bps) / 10000;

  insert into public.orders (
    event_id, organization_id, ticket_type_id, buyer_id, quantity,
    unit_price_cents, subtotal_cents, discount_cents, promo_code_id,
    platform_fee_cents, total_cents, currency, payment_status, provider
  )
  values (
    ev.id, ev.organization_id, tt.id, p_buyer_id, p_quantity,
    tt.price_cents, subtotal, discount, promo_id,
    fee, total, tt.currency, 'requires_payment', org.payment_provider
  )
  returning * into new_order;

  -- Reserve the redemption now. fulfill_order() confirms it; an order that is
  -- never paid expires and the counter is released by release_expired_promos().
  if promo_id is not null then
    update public.promo_codes
      set used_count = used_count + 1
      where id = promo_id;

    insert into public.promo_redemptions (promo_code_id, order_id, user_id, amount_off)
    values (promo_id, new_order.id, p_buyer_id, discount);
  end if;

  return new_order;
end;
$$;

/**
 * Releases promo reservations held by orders that expired without being paid,
 * so a code is not burned by abandoned checkouts. Called by the same cron that
 * expires the orders.
 */
create or replace function public.release_expired_promos()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_released integer := 0;
begin
  with stale as (
    select r.id, r.promo_code_id
    from public.promo_redemptions r
    join public.orders o on o.id = r.order_id
    where o.payment_status in ('requires_payment', 'failed', 'cancelled')
      and o.expires_at < now()
  ), bumped as (
    update public.promo_codes p
      set used_count = greatest(p.used_count - 1, 0)
      from stale
      where p.id = stale.promo_code_id
      returning p.id
  )
  delete from public.promo_redemptions r
   using stale
   where r.id = stale.id;

  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

-- ---------------------------------------------------------------------------
-- The ranker learns about boosts.
--
-- Redefined here rather than edited in 0009 so the migration history stays
-- append-only. The only change is the boost term: it is added to the score,
-- reported as its own component in score_breakdown, and flagged as
-- `is_boosted` in the facts — a promoted result that does not admit it is
-- promoted is a dark pattern, and the AI debug screen would expose it anyway.
-- ---------------------------------------------------------------------------
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
  final as (
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
      )
    )
  from final f
  join public.profiles p on p.id = f.creator_id
  left join public.organizations o on o.id = f.organization_id
  order by f.total_score desc, f.start_at asc
  limit greatest(1, least(coalesce(p_limit, 30), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;
