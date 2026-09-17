-- ============================================================================
-- BLUP · 0061 · What Premium is actually for
-- ============================================================================
-- Premium sold five sentences about better recommendations. Nobody pays for a
-- better algorithm — they cannot see it, they cannot show it to anybody, and
-- they have no way to tell whether they got it. Premium has to be *visible*,
-- *useful* and *ideally both*.
--
-- So it is four kinds of thing at once:
--
--   Visible    the accent colour of the whole app, a chat wallpaper, a badge
--   Useful     double XP, who looked at your profile
--   Worth real money   a free boost every week — at the cheapest package that
--              is more than the subscription costs
--   Honest     none of it takes anything away from people who do not pay.
--              Nothing here is a limit invented so that removing it can be
--              sold; the free app keeps everything it has today.
--
-- Implementation rule: every perk is checked server-side by is_premium(). The
-- colour is stored on the profile so it follows the person to every device, and
-- a lapsed subscription simply stops being read rather than rewriting anything.
-- ============================================================================

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Colour, wallpaper, badge
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists accent_color   text,
  add column if not exists chat_wallpaper text;

-- A fixed set, not a colour picker. Six that are legible on the dark ground,
-- keep white text readable on a filled button, and cannot produce the one
-- combination this app has already shipped once: an accent the same colour as
-- the text on top of it.
alter table public.profiles
  drop constraint if exists profiles_accent_color_allowed;
alter table public.profiles
  add constraint profiles_accent_color_allowed check (
    accent_color is null or accent_color in (
      'blue',     -- #0080FF, the default
      'pink',     -- #FF4D8D
      'violet',   -- #8B5CF6
      'teal',     -- #14B8A6
      'amber',    -- #F59E0B
      'lime'      -- #84CC16
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Setting them
-- ---------------------------------------------------------------------------
-- One function rather than an RLS-allowed column update, because both of these
-- are behind the subscription and that check belongs on the server. Somebody
-- whose subscription lapses keeps what they chose; it simply stops being
-- applied, so resubscribing restores their colour instead of losing it.
create or replace function public.set_premium_look(
  p_accent    text default null,
  p_wallpaper text default null,
  -- Distinguishes "leave it alone" from "put it back to the default".
  p_clear_accent    boolean default false,
  p_clear_wallpaper boolean default false
)
returns public.profiles
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me  uuid := auth.uid();
  row public.profiles;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED';
  end if;
  if not public.is_premium(me) then
    raise exception 'PREMIUM_REQUIRED'
      using hint = 'Farbu appky a pozadie chatu má Premium.';
  end if;

  update public.profiles p
  set accent_color = case
        when p_clear_accent then null
        when p_accent is not null then p_accent
        else p.accent_color end,
      chat_wallpaper = case
        when p_clear_wallpaper then null
        when p_wallpaper is not null then p_wallpaper
        else p.chat_wallpaper end,
      updated_at = now()
  where p.id = me
  returning * into row;

  return row;
end;
$$;

revoke all on function public.set_premium_look(text, text, boolean, boolean) from public, anon;
grant execute on function public.set_premium_look(text, text, boolean, boolean) to authenticated;

-- What the app should actually paint, which is not the same as what is stored:
-- a lapsed subscriber's saved colour must not keep applying.
create or replace function public.my_look()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'is_premium',     public.is_premium(auth.uid()),
    'accent_color',   case when public.is_premium(auth.uid()) then p.accent_color end,
    'chat_wallpaper', case when public.is_premium(auth.uid()) then p.chat_wallpaper end,
    -- Kept even while it is not applied, so the setting is still there when
    -- somebody comes back rather than silently lost.
    'saved_accent',   p.accent_color,
    'saved_wallpaper', p.chat_wallpaper
  )
  from public.profiles p
  where p.id = auth.uid();
$$;

revoke all on function public.my_look() from public, anon;
grant execute on function public.my_look() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Double XP
-- ---------------------------------------------------------------------------
-- The multiplier lands on the award itself rather than on a display, so the
-- leaderboard, the level and the badges all agree — a number that is doubled
-- in one place and not in another is worse than no multiplier.
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
  v_amount     integer;
begin
  if p_user is null then
    return 0;
  end if;

  select * into v_rule from public.xp_rules where kind = p_kind;
  if not found then
    return 0;
  end if;

  -- Daily cap keeps a farmable action (saving, unsaving, re-saving) bounded.
  -- Deliberately NOT doubled for Premium: the cap is an anti-abuse limit, and
  -- doubling it would sell the right to farm rather than the reward for doing
  -- things. Premium gets twice the points per action, not twice the actions.
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

  v_amount := v_rule.amount * case when public.is_premium(p_user) then 2 else 1 end;

  begin
    insert into public.xp_awards (user_id, kind, amount, ref_type, ref_id)
    values (p_user, p_kind, v_amount, p_ref_type, p_ref_id);
  exception when unique_violation then
    return 0;  -- already paid out for this exact thing
  end;

  insert into public.user_stats (user_id, xp)
  values (p_user, v_amount)
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

  return v_amount;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Who looked at your profile
-- ---------------------------------------------------------------------------
create table if not exists public.profile_views (
  id         bigserial primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  viewer_id  uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint profile_views_not_self check (profile_id <> viewer_id)
);

create index if not exists profile_views_profile_idx
  on public.profile_views (profile_id, created_at desc);
create index if not exists profile_views_pair_idx
  on public.profile_views (profile_id, viewer_id, created_at desc);

alter table public.profile_views enable row level security;

-- Nobody selects this table directly. It is read through the function below,
-- which is the only place the "Premium, and only the last 7 days" rule lives.
drop policy if exists profile_views_none on public.profile_views;
create policy profile_views_none on public.profile_views for select using (false);

/**
 * Records that somebody opened a profile.
 *
 * One row per viewer per hour: opening a profile three times in a row is one
 * interest, not three, and a list that says the same name six times is a list
 * nobody reads twice.
 *
 * Anonymous mode is honoured here, at the write. Someone browsing anonymously
 * leaves no row at all — not a row that is filtered out later, which would be
 * a promise kept only by whoever remembers to filter.
 */
create or replace function public.record_profile_view(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or p_profile_id is null or me = p_profile_id then
    return;
  end if;

  if coalesce((select anonymous_mode from public.profiles where id = me), false) then
    return;
  end if;

  if exists (
    select 1 from public.profile_views
    where profile_id = p_profile_id and viewer_id = me
      and created_at > now() - interval '1 hour'
  ) then
    return;
  end if;

  insert into public.profile_views (profile_id, viewer_id) values (p_profile_id, me);
end;
$$;

revoke all on function public.record_profile_view(uuid) from public, anon;
grant execute on function public.record_profile_view(uuid) to authenticated;

/**
 * Who looked at you.
 *
 * Premium sees names and faces. Everybody else gets the number, which is the
 * honest version of the tease — it says there is something there without
 * pretending to show it and without inventing a blurred fake.
 */
create or replace function public.my_profile_views(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  me     uuid := auth.uid();
  since  timestamptz;
  total  integer;
  rows_j jsonb;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  since := now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 30));

  select count(distinct viewer_id) into total
  from public.profile_views
  where profile_id = me and created_at >= since;

  if not public.is_premium(me) then
    return jsonb_build_object('is_premium', false, 'total', total, 'viewers', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(v order by v_last desc), '[]'::jsonb) into rows_j
  from (
    select
      jsonb_build_object(
        'id', p.id,
        'username', p.username,
        'display_name', p.display_name,
        'avatar_url', p.avatar_url,
        'last_seen_at', max(pv.created_at),
        'times', count(*)
      ) as v,
      max(pv.created_at) as v_last
    from public.profile_views pv
    join public.profiles p on p.id = pv.viewer_id
    where pv.profile_id = me and pv.created_at >= since
    group by p.id, p.username, p.display_name, p.avatar_url
    limit 100
  ) t;

  return jsonb_build_object('is_premium', true, 'total', total, 'viewers', rows_j);
end;
$$;

revoke all on function public.my_profile_views(integer) from public, anon;
grant execute on function public.my_profile_views(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The badge
-- ---------------------------------------------------------------------------
-- A badge nobody else can see is not a badge. `premium_subscriptions` is the
-- subscriber's own row and stays that way — this is one public column that says
-- only "until when", which is exactly what a badge says out loud anyway.
--
-- Kept in sync where subscriptions are written, and maintained by a trigger so
-- it cannot drift: a badge that survives a cancelled subscription is worse than
-- no badge.
alter table public.profiles
  add column if not exists premium_until timestamptz;

create or replace function public.sync_premium_badge()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target uuid := coalesce(new.user_id, old.user_id);
begin
  update public.profiles p
  set premium_until = (
    select max(s.expires_at)
    from public.premium_subscriptions s
    where s.user_id = target
      and s.status in ('active', 'trialing', 'grace_period')
      and (s.expires_at is null or s.expires_at > now())
  )
  where p.id = target;

  return null;
end;
$$;

drop trigger if exists premium_subscriptions_sync_badge on public.premium_subscriptions;
create trigger premium_subscriptions_sync_badge
  after insert or update or delete on public.premium_subscriptions
  for each row execute function public.sync_premium_badge();

-- Existing subscribers, once.
update public.profiles p
set premium_until = (
  select max(s.expires_at)
  from public.premium_subscriptions s
  where s.user_id = p.id
    and s.status in ('active', 'trialing', 'grace_period')
    and (s.expires_at is null or s.expires_at > now())
)
where exists (select 1 from public.premium_subscriptions s where s.user_id = p.id);
