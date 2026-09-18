-- ============================================================================
-- Admin má Premium (aby sa dalo testovať), a plán sály sa dá zmazať
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. A full admin has Premium
-- ---------------------------------------------------------------------------
-- Every premium perk is invisible to whoever builds it: the accent colour, the
-- chat wallpaper, the badge, doubled XP, the free weekly boost, who looked at
-- your profile. Testing them meant buying a subscription with a real card, so
-- in practice they were not tested at all.
--
-- This is a grant, not a fake subscription row. `premium_subscriptions` stays
-- the record of who actually pays — nothing here touches it, the accounting
-- never sees an admin as revenue, and `admin_platform_stats` counts real
-- subscribers exactly as before. What changes is only the question "may this
-- person use the premium features", which is what is_premium() answers.
create or replace function public.is_premium(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    -- A full admin, so the perks can be used and looked at. Not a moderator:
    -- moderating content is a different job from running the place.
    exists (select 1 from public.profiles p where p.id = uid and p.app_role = 'admin')
    or exists (
      select 1
      from public.premium_subscriptions s
      where s.user_id = uid
        and s.status in ('active', 'trialing', 'grace_period')
        and (s.expires_at is null or s.expires_at > now())
    );
$$;

-- `profiles.premium_until` drives the badge next to a name, and it is kept in
-- step with the subscription by a trigger. An admin has no subscription to sync
-- from, so the badge is set here — far enough out that it does not need
-- renewing, and visible so an admin sees exactly what a subscriber sees.
update public.profiles
set premium_until = greatest(coalesce(premium_until, now()), now() + interval '10 years')
where app_role = 'admin';

/**
 * Keeps that true for whoever becomes an admin later.
 *
 * Losing the role takes the badge away again — but only the granted one. A
 * real subscription writes its own `premium_until` through sync_premium_badge(),
 * and an admin who also pays keeps whichever runs out later.
 */
create or replace function public.sync_admin_premium()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.app_role = 'admin' and (old.app_role is distinct from 'admin') then
    new.premium_until := greatest(coalesce(new.premium_until, now()), now() + interval '10 years');
  elsif old.app_role = 'admin' and new.app_role is distinct from 'admin' then
    -- Back to whatever they actually pay for, which may be nothing.
    new.premium_until := (
      select max(s.expires_at)
      from public.premium_subscriptions s
      where s.user_id = new.id
        and s.status in ('active', 'trialing', 'grace_period')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_admin_premium on public.profiles;
create trigger profiles_admin_premium
  before update of app_role on public.profiles
  for each row execute function public.sync_admin_premium();

-- ---------------------------------------------------------------------------
-- 2. A plan can be taken off an event, and a picture off a plan
-- ---------------------------------------------------------------------------
/**
 * Removes the background picture, leaving the sectors where they are.
 *
 * The rectangles are stored as fractions of the image, not as pixels, so they
 * survive losing it — which is the whole reason they are stored that way. This
 * is for a plan photographed badly: drop the picture, upload a better one, and
 * nothing moves.
 */
create or replace function public.clear_venue_map_image(p_map_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.assert_can_manage_venue_map(p_map_id);

  update public.venue_maps
  set image_url = null, updated_by = auth.uid()
  where id = p_map_id;
end;
$$;

revoke execute on function public.clear_venue_map_image(uuid) from public, anon;
grant execute on function public.clear_venue_map_image(uuid) to authenticated;

/**
 * Throws the plan away entirely.
 *
 * Refuses while anything has been sold from it, and that refusal is the point:
 * tickets name a seat, seats belong to sectors, and sectors are deleted with
 * the map — so deleting a plan mid-sale would blank the row and number on
 * every ticket already paid for, silently, because the foreign key is ON DELETE
 * SET NULL. The organizer would find out at the door.
 *
 * Detaching without deleting is the other half: the plan stays on the shelf for
 * another night in the same hall, and this event goes back to selling by count.
 */
create or replace function public.delete_venue_map(p_event_id uuid, p_keep_plan boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_map   uuid;
  v_sold  integer;
  v_held  integer;
begin
  select venue_map_id into v_map from public.events where id = p_event_id;
  if v_map is null then
    raise exception 'VENUE_MAP_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  select count(*) into v_sold
  from public.tickets t
  join public.venue_seats vs on vs.id = t.venue_seat_id
  join public.venue_sections s on s.id = vs.venue_section_id
  where s.venue_map_id = v_map and t.status in ('valid', 'used');

  select count(*) into v_held
  from public.seat_claims(p_event_id) c
  where c.claim in ('held', 'ordered');

  -- Detaching is always allowed, and is the way out when something has sold:
  -- the map stays, so every sold ticket still resolves the seat printed on it,
  -- and the event simply goes back to selling by count. Only DELETING is
  -- refused, because that takes the sectors and seats with it and the foreign
  -- key on tickets is ON DELETE SET NULL — the row and number would vanish off
  -- paid tickets, silently, and the organizer would find out at the door.
  if not p_keep_plan and v_sold > 0 then
    raise exception 'SEATS_IN_USE'
      using hint = 'Z tohto plánu je predaných ' || v_sold || ' vstupeniek. '
                || 'Odpoj plán od eventu namiesto mazania — miesta na vstupenkách tak zostanú.';
  end if;

  if not p_keep_plan and v_held > 0 then
    raise exception 'SEATS_IN_USE'
      using hint = 'Niekto práve drží miesta. Skús o pár minút.';
  end if;

  -- Off the event either way; the map itself only goes if nothing wants it.
  update public.events set venue_map_id = null where id = p_event_id;

  if p_keep_plan then
    return jsonb_build_object('detached', true, 'deleted', false);
  end if;

  -- Another event may be using the same plan — a hall that runs every week.
  if exists (select 1 from public.events where venue_map_id = v_map) then
    return jsonb_build_object('detached', true, 'deleted', false, 'used_elsewhere', true);
  end if;

  delete from public.venue_maps where id = v_map;
  return jsonb_build_object('detached', true, 'deleted', true);
end;
$$;

revoke execute on function public.delete_venue_map(uuid, boolean) from public, anon;
grant execute on function public.delete_venue_map(uuid, boolean) to authenticated;
