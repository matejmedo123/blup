-- ============================================================================
-- BLUP · 0017 · Gamification (XP, levels, streaks, badges)
-- ============================================================================
-- Every point in this system is earned by something that actually happened and
-- is written by a trigger on the row that proves it — an event you published,
-- an RSVP you made, a ticket that was scanned at the door. Nothing here is
-- client-writable, and nothing is seeded with a decorative starting balance:
-- a fresh account is level 1 with 0 XP because it has done nothing yet.
--
--   xp_awards      the ledger — one row per earning, unique per (user, kind, ref)
--   user_stats     the running totals, maintained by the ledger trigger
--   badges         the catalogue (what exists, and what it takes)
--   user_badges    what a person has actually earned
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'xp_kind') then
    create type xp_kind as enum (
      'event_created',      -- published an event
      'event_attended',     -- said you are going
      'event_checked_in',   -- scanned in at the door
      'ticket_purchased',   -- bought a ticket
      'event_saved',        -- saved a blup
      'follower_gained',    -- someone followed you
      'profile_completed',  -- finished onboarding with a photo and interests
      'daily_streak'        -- opened the app on consecutive days
    );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- How much each action is worth. A table, not a CASE buried in a function, so
-- the economy can be tuned without a code deploy.
-- ---------------------------------------------------------------------------
create table if not exists public.xp_rules (
  kind        xp_kind primary key,
  amount      integer not null check (amount > 0),
  daily_cap   integer,               -- max awards of this kind per day, null = unlimited
  description text not null
);

insert into public.xp_rules (kind, amount, daily_cap, description) values
  ('event_created',     120, 5,    'Zverejnil si event'),
  ('event_attended',     30, 10,   'Ideš na event'),
  ('event_checked_in',   80, null, 'Prišiel si naozaj'),
  ('ticket_purchased',   50, null, 'Kúpil si vstupenku'),
  ('event_saved',        10, 20,   'Uložil si blup'),
  ('follower_gained',    15, 30,   'Niekto ťa začal sledovať'),
  ('profile_completed', 100, 1,    'Dokončil si profil'),
  ('daily_streak',       25, 1,    'Séria dní za sebou')
on conflict (kind) do update
  set amount = excluded.amount,
      daily_cap = excluded.daily_cap,
      description = excluded.description;

-- ---------------------------------------------------------------------------
-- The ledger. `ref_id` makes an award idempotent: the same RSVP cannot pay out
-- twice, however many times the trigger fires.
-- ---------------------------------------------------------------------------
create table if not exists public.xp_awards (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       xp_kind not null,
  amount     integer not null check (amount > 0),
  ref_type   text,
  ref_id     uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists xp_awards_unique_ref
  on public.xp_awards (user_id, kind, ref_id) where ref_id is not null;

create index if not exists xp_awards_user_idx on public.xp_awards (user_id, created_at desc);

create table if not exists public.user_stats (
  user_id          uuid primary key references public.profiles (id) on delete cascade,
  xp               integer not null default 0 check (xp >= 0),
  level            integer not null default 1 check (level >= 1),
  events_created   integer not null default 0,
  events_attended  integer not null default 0,
  check_ins        integer not null default 0,
  blups_saved      integer not null default 0,
  streak_days      integer not null default 0,
  longest_streak   integer not null default 0,
  last_active_on   date,
  updated_at       timestamptz not null default now()
);

create index if not exists user_stats_leaderboard_idx on public.user_stats (xp desc);

-- ---------------------------------------------------------------------------
-- Levels.
--
-- level(xp) = floor(sqrt(xp / 100)) + 1 — 100 XP to level 2, 400 to level 3,
-- 900 to level 4. Deliberately slow: a level should mean you have been out.
-- ---------------------------------------------------------------------------
create or replace function public.level_for_xp(p_xp integer)
returns integer
language sql
immutable
as $$
  select greatest(1, floor(sqrt(greatest(p_xp, 0)::numeric / 100))::integer + 1);
$$;

create or replace function public.xp_for_level(p_level integer)
returns integer
language sql
immutable
as $$
  select (greatest(p_level, 1) - 1) * (greatest(p_level, 1) - 1) * 100;
$$;

-- ---------------------------------------------------------------------------
-- Badges
-- ---------------------------------------------------------------------------
create table if not exists public.badges (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name         text not null,
  description  text not null,
  emoji        text not null,
  -- Which counter on user_stats decides it, and the value that unlocks it.
  metric       text not null check (metric in (
                 'events_created', 'events_attended', 'check_ins',
                 'blups_saved', 'streak_days', 'level', 'xp'
               )),
  threshold    integer not null check (threshold > 0),
  tier         integer not null default 1 check (tier between 1 and 4),
  sort_order   integer not null default 0
);

create table if not exists public.user_badges (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  badge_id   uuid not null references public.badges (id) on delete cascade,
  awarded_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

create index if not exists user_badges_user_idx on public.user_badges (user_id, awarded_at desc);

insert into public.badges (slug, name, description, emoji, metric, threshold, tier, sort_order) values
  ('first-blup',    'Prvý BLUP',      'Zverejnil si svoj prvý event',            '🎉', 'events_created',  1,  1, 10),
  ('organizer-5',   'Organizátor',    'Päť eventov pod tvojím menom',            '📣', 'events_created',  5,  2, 11),
  ('organizer-25',  'Ťahúň scény',    'Dvadsaťpäť eventov — toto už je robota',  '🏗️', 'events_created', 25,  3, 12),
  ('first-night',   'Prvý výlet',     'Prvýkrát si povedal, že ideš',            '🚀', 'events_attended', 1,  1, 20),
  ('regular-10',    'Stály hosť',     'Desať eventov, na ktoré si šiel',         '🎟️', 'events_attended',10,  2, 21),
  ('everywhere-50', 'Všade doma',     'Päťdesiat eventov — kde ťa nemajú?',      '🌍', 'events_attended',50,  3, 22),
  ('showed-up',     'Naozaj si prišiel', 'Prvý check-in pri vstupe',             '✅', 'check_ins',       1,  1, 30),
  ('showed-up-10',  'Spoľahlivý',     'Desať check-inov — na teba je spoľah',    '🤝', 'check_ins',      10,  2, 31),
  ('collector-25',  'Zberateľ',       'Dvadsaťpäť uložených blupov',             '⭐', 'blups_saved',    25,  2, 40),
  ('streak-7',      'Týždeň v kuse',  'Sedem dní za sebou v BLUPe',              '🔥', 'streak_days',     7,  2, 50),
  ('streak-30',     'Mesiac v kuse',  'Tridsať dní za sebou',                    '⚡', 'streak_days',    30,  3, 51),
  ('level-5',       'Level 5',        'Dostal si sa na piaty level',             '🥉', 'level',           5,  2, 60),
  ('level-10',      'Level 10',       'Desiaty level — to je už kus cesty',      '🥈', 'level',          10,  3, 61),
  ('level-20',      'Level 20',       'Dvadsiaty level',                         '🥇', 'level',          20,  4, 62)
on conflict (slug) do update
  set name = excluded.name,
      description = excluded.description,
      emoji = excluded.emoji,
      metric = excluded.metric,
      threshold = excluded.threshold,
      tier = excluded.tier,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Awarding badges. Called after any stat change; only ever inserts, so it is
-- safe to call as often as we like.
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_badges(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_stats public.user_stats%rowtype;
  v_badge public.badges%rowtype;
  v_value integer;
  v_new   integer := 0;
begin
  select * into v_stats from public.user_stats where user_id = p_user;
  if not found then
    return 0;
  end if;

  for v_badge in
    select b.* from public.badges b
    where not exists (
      select 1 from public.user_badges ub
      where ub.user_id = p_user and ub.badge_id = b.id
    )
  loop
    v_value := case v_badge.metric
      when 'events_created'  then v_stats.events_created
      when 'events_attended' then v_stats.events_attended
      when 'check_ins'       then v_stats.check_ins
      when 'blups_saved'     then v_stats.blups_saved
      when 'streak_days'     then v_stats.streak_days
      when 'level'           then v_stats.level
      when 'xp'              then v_stats.xp
      else 0
    end;

    if v_value >= v_badge.threshold then
      insert into public.user_badges (user_id, badge_id)
      values (p_user, v_badge.id)
      on conflict do nothing;

      if found then
        v_new := v_new + 1;
        perform public.notify_user(
          p_user,
          'badge_earned'::notification_type,
          'Získal si odznak ' || v_badge.emoji,
          v_badge.name || ' — ' || v_badge.description,
          null, null,
          jsonb_build_object('badge_slug', v_badge.slug)
        );
      end if;
    end if;
  end loop;

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Awarding XP. The single entry point; every trigger below funnels through it.
-- ---------------------------------------------------------------------------
create or replace function public.award_xp(
  p_user     uuid,
  p_kind     xp_kind,
  p_ref_type text default null,
  p_ref_id   uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_rule       public.xp_rules%rowtype;
  v_today      integer;
  v_old_level  integer;
  v_new_level  integer;
  v_xp         integer;
begin
  if p_user is null then
    return 0;
  end if;

  select * into v_rule from public.xp_rules where kind = p_kind;
  if not found then
    return 0;
  end if;

  -- Daily cap keeps a farmable action (saving, unsaving, re-saving) bounded.
  if v_rule.daily_cap is not null then
    select count(*) into v_today
    from public.xp_awards
    where user_id = p_user
      and kind = p_kind
      and created_at >= date_trunc('day', now());

    if v_today >= v_rule.daily_cap then
      return 0;
    end if;
  end if;

  begin
    insert into public.xp_awards (user_id, kind, amount, ref_type, ref_id)
    values (p_user, p_kind, v_rule.amount, p_ref_type, p_ref_id);
  exception when unique_violation then
    return 0;  -- already paid out for this exact thing
  end;

  insert into public.user_stats (user_id, xp)
  values (p_user, v_rule.amount)
  on conflict (user_id) do update
    set xp = user_stats.xp + excluded.xp,
        updated_at = now()
  returning xp, level into v_xp, v_old_level;

  v_new_level := public.level_for_xp(v_xp);

  if v_new_level <> v_old_level then
    update public.user_stats set level = v_new_level where user_id = p_user;

    if v_new_level > v_old_level then
      perform public.notify_user(
        p_user,
        'level_up'::notification_type,
        'Level ' || v_new_level || ' 🎯',
        'Máš ' || v_xp || ' XP. Tak ďalej.',
        null, null,
        jsonb_build_object('level', v_new_level, 'xp', v_xp)
      );
    end if;
  end if;

  perform public.evaluate_badges(p_user);

  return v_rule.amount;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers — the only callers of award_xp in normal operation.
-- ---------------------------------------------------------------------------

-- Publishing an event.
create or replace function public.gamify_event_published()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_became_published boolean;
begin
  if tg_op = 'INSERT' then
    v_became_published := new.status = 'published';
  else
    v_became_published := new.status = 'published' and old.status is distinct from 'published';
  end if;

  if v_became_published then
    insert into public.user_stats (user_id, events_created)
    values (new.creator_id, 1)
    on conflict (user_id) do update
      set events_created = user_stats.events_created + 1, updated_at = now();

    perform public.award_xp(new.creator_id, 'event_created', 'event', new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists events_gamify on public.events;
create trigger events_gamify
  after insert or update of status on public.events
  for each row execute function public.gamify_event_published();

-- RSVP and check-in.
create or replace function public.gamify_attendance()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_previous attendee_status;
begin
  v_previous := case when tg_op = 'INSERT' then null else old.status end;

  if new.status = 'going' and v_previous is distinct from 'going' then
    insert into public.user_stats (user_id, events_attended)
    values (new.user_id, 1)
    on conflict (user_id) do update
      set events_attended = user_stats.events_attended + 1, updated_at = now();

    perform public.award_xp(new.user_id, 'event_attended', 'event', new.event_id);
  end if;

  if new.status = 'checked_in' and v_previous is distinct from 'checked_in' then
    insert into public.user_stats (user_id, check_ins)
    values (new.user_id, 1)
    on conflict (user_id) do update
      set check_ins = user_stats.check_ins + 1, updated_at = now();

    perform public.award_xp(new.user_id, 'event_checked_in', 'event', new.event_id);
  end if;

  return new;
end;
$$;

drop trigger if exists event_attendees_gamify on public.event_attendees;
create trigger event_attendees_gamify
  after insert or update of status on public.event_attendees
  for each row execute function public.gamify_attendance();

-- Saving a blup.
create or replace function public.gamify_saved_event()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.user_stats (user_id, blups_saved)
  values (new.user_id, 1)
  on conflict (user_id) do update
    set blups_saved = user_stats.blups_saved + 1, updated_at = now();

  perform public.award_xp(new.user_id, 'event_saved', 'event', new.event_id);
  return new;
end;
$$;

drop trigger if exists saved_events_gamify on public.saved_events;
create trigger saved_events_gamify
  after insert on public.saved_events
  for each row execute function public.gamify_saved_event();

-- Gaining a follower. The XP goes to the person being followed.
create or replace function public.gamify_follow()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.award_xp(new.following_id, 'follower_gained', 'follow', new.follower_id);
  return new;
end;
$$;

drop trigger if exists follows_gamify on public.follows;
create trigger follows_gamify
  after insert on public.follows
  for each row execute function public.gamify_follow();

-- Buying a ticket.
create or replace function public.gamify_ticket()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.award_xp(new.buyer_id, 'ticket_purchased', 'ticket', new.id);
  return new;
end;
$$;

drop trigger if exists tickets_gamify on public.tickets;
create trigger tickets_gamify
  after insert on public.tickets
  for each row execute function public.gamify_ticket();

-- ---------------------------------------------------------------------------
-- Daily streak. Called by the app on launch; counts a day only once, and only
-- extends the streak when the previous day was also active.
-- ---------------------------------------------------------------------------
create or replace function public.touch_activity()
returns table (streak integer, xp_awarded integer)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me      uuid := auth.uid();
  v_last    date;
  v_streak  integer;
  v_awarded integer := 0;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  insert into public.user_stats (user_id, last_active_on, streak_days, longest_streak)
  values (v_me, current_date, 1, 1)
  on conflict (user_id) do nothing;

  select us.last_active_on, us.streak_days
    into v_last, v_streak
  from public.user_stats us where us.user_id = v_me;

  if v_last = current_date then
    return query select v_streak, 0;
    return;
  end if;

  v_streak := case when v_last = current_date - 1 then coalesce(v_streak, 0) + 1 else 1 end;

  update public.user_stats
    set last_active_on = current_date,
        streak_days = v_streak,
        longest_streak = greatest(longest_streak, v_streak),
        updated_at = now()
    where user_id = v_me;

  -- The streak award has a daily cap of 1, so this pays at most once a day.
  v_awarded := public.award_xp(v_me, 'daily_streak', 'day', null);
  perform public.evaluate_badges(v_me);

  return query select v_streak, v_awarded;
end;
$$;

-- Finishing onboarding is worth something, once.
create or replace function public.gamify_profile_completed()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.onboarding_completed and not old.onboarding_completed then
    perform public.award_xp(new.id, 'profile_completed', 'profile', new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_gamify on public.profiles;
create trigger profiles_gamify
  after update of onboarding_completed on public.profiles
  for each row execute function public.gamify_profile_completed();

-- ---------------------------------------------------------------------------
-- What the app reads.
-- ---------------------------------------------------------------------------
create or replace function public.gamification_for(p_user uuid default auth.uid())
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_stats   public.user_stats%rowtype;
  v_level   integer;
  v_floor   integer;
  v_ceiling integer;
begin
  if p_user is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  -- Respect the same visibility rule as the profile itself.
  if p_user <> auth.uid()
     and not public.is_admin()
     and exists (
       select 1 from public.profiles
       where id = p_user and is_private and not public.is_following(id, auth.uid())
     )
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select * into v_stats from public.user_stats where user_id = p_user;

  if not found then
    -- No row yet means no activity yet. Level 1, nothing earned — not an error.
    return jsonb_build_object(
      'user_id', p_user,
      'xp', 0, 'level', 1,
      'level_floor', 0, 'level_ceiling', public.xp_for_level(2),
      'events_created', 0, 'events_attended', 0, 'check_ins', 0,
      'blups_saved', 0, 'streak_days', 0, 'longest_streak', 0,
      'badges', '[]'::jsonb
    );
  end if;

  v_level   := v_stats.level;
  v_floor   := public.xp_for_level(v_level);
  v_ceiling := public.xp_for_level(v_level + 1);

  return jsonb_build_object(
    'user_id',        v_stats.user_id,
    'xp',             v_stats.xp,
    'level',          v_level,
    'level_floor',    v_floor,
    'level_ceiling',  v_ceiling,
    'events_created', v_stats.events_created,
    'events_attended',v_stats.events_attended,
    'check_ins',      v_stats.check_ins,
    'blups_saved',    v_stats.blups_saved,
    'streak_days',    v_stats.streak_days,
    'longest_streak', v_stats.longest_streak,
    'badges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', b.slug, 'name', b.name, 'description', b.description,
               'emoji', b.emoji, 'tier', b.tier, 'awarded_at', ub.awarded_at
             ) order by b.sort_order)
      from public.user_badges ub
      join public.badges b on b.id = ub.badge_id
      where ub.user_id = p_user
    ), '[]'::jsonb)
  );
end;
$$;

-- The full catalogue with the viewer's progress, for the badges screen.
create or replace function public.badge_progress()
returns table (
  slug        text,
  name        text,
  description text,
  emoji       text,
  tier        integer,
  threshold   integer,
  metric      text,
  progress    integer,
  earned      boolean,
  awarded_at  timestamptz
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    b.slug, b.name, b.description, b.emoji, b.tier, b.threshold, b.metric,
    least(
      case b.metric
        when 'events_created'  then coalesce(s.events_created, 0)
        when 'events_attended' then coalesce(s.events_attended, 0)
        when 'check_ins'       then coalesce(s.check_ins, 0)
        when 'blups_saved'     then coalesce(s.blups_saved, 0)
        when 'streak_days'     then coalesce(s.streak_days, 0)
        when 'level'           then coalesce(s.level, 1)
        when 'xp'              then coalesce(s.xp, 0)
        else 0
      end,
      b.threshold
    ),
    ub.user_id is not null,
    ub.awarded_at
  from public.badges b
  left join public.user_stats s on s.user_id = auth.uid()
  left join public.user_badges ub on ub.badge_id = b.id and ub.user_id = auth.uid()
  order by b.sort_order;
$$;

-- ---------------------------------------------------------------------------
-- RLS. Stats and badges are readable (they are part of a public profile);
-- nothing here is ever writable from the client.
-- ---------------------------------------------------------------------------
alter table public.xp_rules    enable row level security;
alter table public.xp_awards   enable row level security;
alter table public.user_stats  enable row level security;
alter table public.badges      enable row level security;
alter table public.user_badges enable row level security;

drop policy if exists xp_rules_select on public.xp_rules;
create policy xp_rules_select on public.xp_rules for select using (true);

drop policy if exists badges_select on public.badges;
create policy badges_select on public.badges for select using (true);

drop policy if exists xp_awards_select_own on public.xp_awards;
create policy xp_awards_select_own on public.xp_awards
  for select using (user_id = auth.uid() or public.is_admin());

drop policy if exists user_stats_select on public.user_stats;
create policy user_stats_select on public.user_stats
  for select using (
    user_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = user_id
        and not p.is_suspended
        and (not p.is_private or public.is_following(p.id, auth.uid()))
    )
  );

drop policy if exists user_badges_select on public.user_badges;
create policy user_badges_select on public.user_badges
  for select using (
    user_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1 from public.profiles p
      where p.id = user_id
        and not p.is_suspended
        and (not p.is_private or public.is_following(p.id, auth.uid()))
    )
  );

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke insert, update, delete on
               public.xp_rules, public.xp_awards, public.user_stats,
               public.badges, public.user_badges
             from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.xp_awards, public.user_stats from anon';
  end if;
end
$$;
