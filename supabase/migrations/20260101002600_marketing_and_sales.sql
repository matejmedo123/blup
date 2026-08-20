-- ============================================================================
-- BLUP · 0026 · Ad platform tags, per-event sales curve, admin event desk
-- ============================================================================
-- Three unrelated things that all needed a table or a function.
--
-- 1. MARKETING TAGS. Meta and Google both want a snippet on the page. The admin
--    screen therefore asks for *identifiers*, not markup:
--
--        Meta pixel          1234567890123456
--        Google Ads          AW-123456789  (+ a conversion label)
--        Google Analytics    G-ABCD123456
--
--    A "paste your script tag here" box would be a stored-XSS hole with the
--    session token of every visitor behind it, and the one person who can write
--    to that box is exactly the account an attacker wants. Identifiers are
--    range-checked by a CHECK constraint here and interpolated into a fixed,
--    known loader in the web shell — so the worst a bad value can do is fail to
--    load a pixel.
--
--    The ids are public by nature (they ship in the page), so `marketing_tags`
--    is readable by anyone; the settings row behind it is admin-only.
--
-- 2. SALES CURVE. `event_sales_series()` is the daily line the organizer sees on
--    the event: how many tickets went that day, what came in, what BLUP took.
--    Same authorization rule as event_analytics — host, organization member or
--    admin — checked as a statement, not as a WHERE clause the planner may
--    reorder away.
--
-- 3. ADMIN EVENT DESK. Admins could already edit any event (the RLS policy has
--    always allowed it); what was missing was a way to *find* one. Editing is a
--    consequential act on somebody else's listing, so `admin_touch_event()`
--    writes an audit row explaining what was changed and why.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Marketing
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_settings (
  id                        boolean primary key default true check (id),

  meta_enabled              boolean not null default false,
  meta_pixel_id             text,

  google_enabled            boolean not null default false,
  google_ads_id             text,
  google_ads_purchase_label text,
  google_analytics_id       text,

  -- EU visitors: nothing loads until consent is given. Turning this off is a
  -- legal decision for the operator to make, not a default.
  consent_required          boolean not null default true,

  updated_at                timestamptz not null default now(),
  updated_by                uuid references public.profiles (id) on delete set null,

  constraint marketing_meta_pixel_format
    check (meta_pixel_id is null or meta_pixel_id ~ '^[0-9]{8,20}$'),
  constraint marketing_google_ads_format
    check (google_ads_id is null or google_ads_id ~ '^AW-[0-9]{6,15}$'),
  constraint marketing_google_label_format
    check (google_ads_purchase_label is null or google_ads_purchase_label ~ '^[A-Za-z0-9_-]{4,60}$'),
  constraint marketing_ga_format
    check (google_analytics_id is null or google_analytics_id ~ '^G-[A-Z0-9]{6,15}$'),
  -- Switching a platform on without giving it an id would silently do nothing.
  constraint marketing_meta_needs_id
    check (not meta_enabled or meta_pixel_id is not null),
  constraint marketing_google_needs_id
    check (not google_enabled or google_ads_id is not null or google_analytics_id is not null)
);

insert into public.marketing_settings (id) values (true) on conflict (id) do nothing;

alter table public.marketing_settings enable row level security;

drop policy if exists marketing_settings_select on public.marketing_settings;
create policy marketing_settings_select on public.marketing_settings
  for select using (public.is_admin());

drop policy if exists marketing_settings_write on public.marketing_settings;
create policy marketing_settings_write on public.marketing_settings
  for all using (public.is_full_admin()) with check (public.is_full_admin());

-- What the browser is allowed to know: the ids of the platforms that are on.
create or replace function public.marketing_tags()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'meta_pixel_id',    case when s.meta_enabled then s.meta_pixel_id end,
    'google_ads_id',    case when s.google_enabled then s.google_ads_id end,
    'google_ads_purchase_label',
                        case when s.google_enabled then s.google_ads_purchase_label end,
    'google_analytics_id',
                        case when s.google_enabled then s.google_analytics_id end,
    'consent_required', s.consent_required
  )
  from (select * from public.marketing_settings where id limit 1) s;
$$;

create or replace function public.set_marketing_settings(
  p_meta_enabled       boolean,
  p_meta_pixel_id      text,
  p_google_enabled     boolean,
  p_google_ads_id      text,
  p_google_ads_label   text,
  p_google_analytics   text,
  p_consent_required   boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  row public.marketing_settings;
begin
  if not public.is_full_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.marketing_settings
  set meta_enabled              = coalesce(p_meta_enabled, false),
      meta_pixel_id             = nullif(btrim(p_meta_pixel_id), ''),
      google_enabled            = coalesce(p_google_enabled, false),
      google_ads_id             = nullif(btrim(p_google_ads_id), ''),
      google_ads_purchase_label = nullif(btrim(p_google_ads_label), ''),
      google_analytics_id       = nullif(btrim(upper(p_google_analytics)), ''),
      consent_required          = coalesce(p_consent_required, true),
      updated_at                = now(),
      updated_by                = auth.uid()
  where id
  returning * into row;

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, reason, metadata)
  values (
    auth.uid(), 'marketing_settings_updated', 'platform', null, null,
    jsonb_build_object(
      'meta_enabled', row.meta_enabled,
      'google_enabled', row.google_enabled,
      'consent_required', row.consent_required
    )
  );

  return to_jsonb(row);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The sales curve
-- ---------------------------------------------------------------------------
create or replace function public.assert_can_read_event_stats(p_event_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  ev record;
begin
  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if not (
    ev.creator_id = auth.uid()
    or (ev.organization_id is not null and public.is_org_member(ev.organization_id, null, auth.uid()))
    or public.is_admin()
  ) then
    raise exception 'NOT_AUTHORIZED';
  end if;
end;
$$;

create or replace function public.event_sales_series(
  p_event_id uuid,
  p_days     integer default 30
)
returns table (
  day          date,
  orders       integer,
  tickets      integer,
  gross_cents  bigint,
  net_cents    bigint,
  blup_cents   bigint,
  cumulative_tickets bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  span integer := least(greatest(coalesce(p_days, 30), 1), 365);
begin
  perform public.assert_can_read_event_stats(p_event_id);

  return query
  with days as (
    select generate_series(
      (current_date - (span - 1))::date,
      current_date,
      interval '1 day'
    )::date as day
  ),
  paid as (
    select
      (o.paid_at at time zone 'UTC')::date as day,
      count(*)::integer                    as orders,
      sum(o.quantity)::integer             as tickets,
      sum(o.subtotal_cents)::bigint        as gross_cents,
      sum(o.net_cents)::bigint             as net_cents,
      sum(o.blup_revenue_cents)::bigint    as blup_cents
    from public.orders o
    where o.event_id = p_event_id
      and o.payment_status = 'succeeded'
      and o.paid_at is not null
    group by 1
  )
  select
    d.day,
    coalesce(p.orders, 0),
    coalesce(p.tickets, 0),
    coalesce(p.gross_cents, 0),
    coalesce(p.net_cents, 0),
    coalesce(p.blup_cents, 0),
    sum(coalesce(p.tickets, 0)) over (order by d.day rows between unbounded preceding and current row)
  from days d
  left join paid p on p.day = d.day
  order by d.day;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The admin event desk
-- ---------------------------------------------------------------------------
create or replace function public.admin_events(
  p_query  text default null,
  p_status text default null,
  p_limit  integer default 40,
  p_offset integer default 0
)
returns table (
  id             uuid,
  title          text,
  status         event_status,
  visibility     event_visibility,
  start_at       timestamptz,
  city           text,
  venue_name     text,
  category       text,
  is_free        boolean,
  price_cents    integer,
  attendee_count integer,
  tickets_sold   integer,
  creator_id     uuid,
  creator_name   text,
  organization_id uuid,
  organization_name text,
  reports_open   integer,
  created_at     timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  needle text := nullif(btrim(coalesce(p_query, '')), '');
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return query
  select
    e.id, e.title, e.status, e.visibility, e.start_at, e.city, e.venue_name,
    e.category, e.is_free, e.price_cents, e.attendee_count, e.tickets_sold,
    e.creator_id, coalesce(p.display_name, p.username::text), e.organization_id, o.name,
    (select count(*)::integer from public.reports r
      where r.target_type = 'event' and r.target_id = e.id and r.status = 'open'),
    e.created_at
  from public.events e
  join public.profiles p on p.id = e.creator_id
  left join public.organizations o on o.id = e.organization_id
  where (p_status is null or e.status::text = p_status)
    and (
      needle is null
      or e.title ilike '%' || needle || '%'
      or coalesce(e.city, '') ilike '%' || needle || '%'
      or coalesce(o.name, '') ilike '%' || needle || '%'
      or coalesce(p.display_name, p.username::text) ilike '%' || needle || '%'
    )
  order by e.start_at desc
  limit least(greatest(coalesce(p_limit, 40), 1), 200)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- Editing somebody else's listing is recorded. The edit itself goes through the
-- ordinary UPDATE (the RLS policy already lets an admin through); this is the
-- paper trail that says who touched it and why.
create or replace function public.admin_log_event_edit(
  p_event_id uuid,
  p_fields   text[],
  p_reason   text default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, reason, metadata)
  values (
    auth.uid(), 'event_edited', 'event', p_event_id, nullif(btrim(coalesce(p_reason, '')), ''),
    jsonb_build_object('fields', coalesce(p_fields, '{}'::text[]))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on public.marketing_settings from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- The tag ids ship in the page anyway; the row behind them does not.
    execute 'revoke all on public.marketing_settings from anon';
    execute 'grant execute on function public.marketing_tags() to anon';
  end if;
end
$$;
