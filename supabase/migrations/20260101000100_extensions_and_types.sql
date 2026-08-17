-- ============================================================================
-- BLUP · 0001 · Extensions, enums and shared helper functions
-- ============================================================================
-- Design notes
--  * Money is always stored as an INTEGER amount in the currency's minor unit
--    (cents). Never use float for money.
--  * Geo uses plain latitude/longitude columns + an IMMUTABLE haversine
--    function and a bounding-box pre-filter. This keeps the schema portable
--    (no PostGIS dependency) while remaining index-assisted. See DATABASE.md
--    for the PostGIS upgrade path once event volume requires GiST indexes.
-- ============================================================================

create extension if not exists "pgcrypto";      -- gen_random_uuid(), digest()
create extension if not exists "citext";        -- case-insensitive usernames/emails

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum ('user', 'moderator', 'admin');
  end if;

  if not exists (select 1 from pg_type where typname = 'event_status') then
    create type event_status as enum ('draft', 'published', 'cancelled', 'completed');
  end if;

  if not exists (select 1 from pg_type where typname = 'event_visibility') then
    create type event_visibility as enum ('public', 'followers', 'private', 'unlisted');
  end if;

  if not exists (select 1 from pg_type where typname = 'attendee_status') then
    create type attendee_status as enum ('going', 'interested', 'waitlist', 'cancelled', 'checked_in');
  end if;

  if not exists (select 1 from pg_type where typname = 'org_role') then
    create type org_role as enum ('owner', 'admin', 'event_manager', 'finance');
  end if;

  if not exists (select 1 from pg_type where typname = 'verification_status') then
    create type verification_status as enum ('unverified', 'pending', 'verified', 'rejected');
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type payment_status as enum (
      'requires_payment', 'processing', 'succeeded', 'failed', 'refunded', 'cancelled'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'payment_provider') then
    create type payment_provider as enum ('stripe', 'apple_iap', 'google_play', 'manual');
  end if;

  if not exists (select 1 from pg_type where typname = 'ticket_status') then
    create type ticket_status as enum ('valid', 'used', 'refunded', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'payout_status') then
    create type payout_status as enum ('pending', 'processing', 'paid', 'failed', 'cancelled');
  end if;

  if not exists (select 1 from pg_type where typname = 'ledger_entry_type') then
    create type ledger_entry_type as enum ('sale', 'platform_fee', 'refund', 'payout', 'adjustment');
  end if;

  if not exists (select 1 from pg_type where typname = 'subscription_status') then
    create type subscription_status as enum (
      'active', 'trialing', 'grace_period', 'expired', 'cancelled', 'revoked'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'subscription_platform') then
    create type subscription_platform as enum ('apple', 'google', 'stripe');
  end if;

  if not exists (select 1 from pg_type where typname = 'friendship_status') then
    create type friendship_status as enum ('pending', 'accepted', 'declined', 'blocked');
  end if;

  if not exists (select 1 from pg_type where typname = 'community_role') then
    create type community_role as enum ('member', 'moderator', 'owner');
  end if;

  if not exists (select 1 from pg_type where typname = 'signal_type') then
    create type signal_type as enum (
      'impression', 'open_detail', 'swipe_right', 'swipe_left', 'save', 'unsave',
      'rsvp_going', 'rsvp_interested', 'rsvp_cancel', 'like', 'unlike', 'comment',
      'share', 'ticket_purchase', 'attended'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'notification_type') then
    create type notification_type as enum (
      'new_follower', 'friend_request', 'friend_accepted', 'event_reminder',
      'event_starting_soon', 'event_updated', 'event_cancelled', 'friend_attending',
      'ticket_purchased', 'ticket_confirmed', 'payout_update', 'org_verified',
      'org_rejected', 'weekly_recommendations', 'new_comment', 'event_full'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'report_status') then
    create type report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');
  end if;

  if not exists (select 1 from pg_type where typname = 'report_target') then
    create type report_target as enum ('event', 'user', 'comment', 'post', 'organization');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Keeps updated_at honest without trusting the client.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Great-circle distance in metres. IMMUTABLE so it can be used in indexes and
-- inlined by the planner.
create or replace function public.blup_distance_m(
  lat1 double precision,
  lon1 double precision,
  lat2 double precision,
  lon2 double precision
)
returns double precision
language sql
immutable
parallel safe
as $$
  select case
    when lat1 is null or lon1 is null or lat2 is null or lon2 is null then null
    else 6371000.0 * 2 * asin(
      least(1.0, sqrt(
        power(sin(radians(lat2 - lat1) / 2), 2) +
        cos(radians(lat1)) * cos(radians(lat2)) *
        power(sin(radians(lon2 - lon1) / 2), 2)
      ))
    )
  end;
$$;

-- Degrees of latitude covered by N metres (constant), used for bbox pre-filter.
create or replace function public.blup_lat_delta(radius_m double precision)
returns double precision
language sql
immutable
parallel safe
as $$ select radius_m / 111320.0; $$;

-- Degrees of longitude covered by N metres at a given latitude.
create or replace function public.blup_lon_delta(radius_m double precision, at_lat double precision)
returns double precision
language sql
immutable
parallel safe
as $$
  select radius_m / greatest(1.0, (111320.0 * cos(radians(least(89.5, abs(at_lat))))));
$$;

-- Short, human-readable, collision-resistant code (ticket codes, invites).
create or replace function public.blup_short_code(len integer default 10)
returns text
language sql
volatile
as $$
  select upper(
    substr(
      translate(encode(gen_random_bytes(32), 'base64'), '+/=OIl01', 'ABCDEFGH'),
      1, len
    )
  );
$$;
