-- ============================================================================
-- Plán sály, haly a štadióna — a kto ho smie kresliť
--
-- Four things this migration settles, all of them things the first two seating
-- migrations left open.
--
-- WHO DRAWS IT. Until now any member of the organization could. That looked
-- generous and was a mistake: a seating plan is not a setting, it is the thing
-- that decides what is sold and to whom. A sector drawn ten pixels wrong sells
-- the wrong seat; a sector pointed at the wrong ticket type sells the wrong
-- price; a stand regenerated mid-sale used to wipe the seat off tickets people
-- had paid for. It is also genuinely hard: a stadium is a couple of hours of
-- careful work with a floor plan open beside you. So it is ours to do. An
-- organizer asks, and we draw it — which is a support request with a table
-- behind it rather than an e-mail somebody forgets.
--
-- WHAT A SECTOR IS. "Sektor A" and "VIP lóža 3" and "pódium" are three
-- different things and only two of them are for sale. A sector now has a kind:
-- it decides the colour, the label the buyer reads, and — for a stage, a bar or
-- an entrance — that it is a landmark on the plan rather than anything anybody
-- can buy. A hall plan without the stage on it is a grid of rectangles nobody
-- can orient themselves in.
--
-- A STADIUM. seat_map_for_event() returned every seat of every sector in one
-- JSON document. For a theatre that is four hundred objects; for a stadium it
-- is twenty thousand, several megabytes, on a phone, to draw one sector. The
-- map now carries counts and the seats come per sector — which is also how the
-- screen already works, since you open one sector at a time.
--
-- THE NEXT EVENT. An arena runs fifty nights a year on the same plan, and
-- sectors are tied to ticket types, which belong to one event. Redrawing a
-- stadium fifty times is not a plan, it is a punishment. A plan can be cloned
-- onto another event, matching sectors to that event's ticket types by name.
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- What kind of sector this is
-- ---------------------------------------------------------------------------
alter table public.venue_sections
  add column if not exists kind text not null default 'standard';

alter table public.venue_sections drop constraint if exists venue_sections_kind_valid;
alter table public.venue_sections add constraint venue_sections_kind_valid
  check (kind in (
    -- sold
    'standard', 'vip', 'box', 'standing', 'wheelchair',
    -- drawn so the buyer can find themselves on the plan, never sold
    'stage', 'bar', 'entrance', 'other'
  ));

-- A landmark is not a product. This is a table check rather than a trigger
-- because it is a fact about the row, and a sector that is for sale may still
-- legitimately have no ticket type yet — it was drawn before the types existed.
alter table public.venue_sections drop constraint if exists venue_sections_landmarks_dont_sell;
alter table public.venue_sections add constraint venue_sections_landmarks_dont_sell
  check (not (kind in ('stage', 'bar', 'entrance', 'other') and ticket_type_id is not null));

-- A line for the buyer: "Prvé dva rady, obsluha pri stole", "Vstup bránou C".
alter table public.venue_sections
  add column if not exists note text;

alter table public.venue_sections drop constraint if exists venue_sections_note_len;
alter table public.venue_sections add constraint venue_sections_note_len
  check (note is null or char_length(note) <= 200);

/** True for the kinds that are drawn to orient people, not to be bought. */
create or replace function public.section_is_landmark(p_kind text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_kind, 'standard') in ('stage', 'bar', 'entrance', 'other');
$$;

grant execute on function public.section_is_landmark(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Only an admin draws a plan
-- ---------------------------------------------------------------------------
-- is_full_admin(), not is_admin(): a moderator moderates content. A seating
-- plan decides what is sold and for how much, which is a different job.
create or replace function public.assert_can_manage_venue_map(p_map_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if p_map_id is not null and not exists (select 1 from public.venue_maps where id = p_map_id) then
    raise exception 'VENUE_MAP_NOT_FOUND';
  end if;

  if not public.is_full_admin() then
    raise exception 'VENUE_PLAN_IS_ADMIN_ONLY'
      using hint = 'Plán sály kreslí BLUP. Napíš nám cez „Požiadať o plán sály" pri evente.';
  end if;
end;
$$;

grant execute on function public.assert_can_manage_venue_map(uuid) to authenticated;

-- The same rule at the table, so it holds for anything that talks to PostgREST
-- directly rather than through the functions above.
drop policy if exists venue_maps_write on public.venue_maps;
create policy venue_maps_write on public.venue_maps
  for all using (public.is_full_admin()) with check (public.is_full_admin());

drop policy if exists venue_sections_write on public.venue_sections;
create policy venue_sections_write on public.venue_sections
  for all using (public.is_full_admin()) with check (public.is_full_admin());

drop policy if exists venue_seats_write on public.venue_seats;
create policy venue_seats_write on public.venue_seats
  for all using (public.is_full_admin()) with check (public.is_full_admin());

-- Attaching a plan to an event is the same decision as drawing one, so it is
-- guarded the same way. Without this, an organizer could point their event at
-- somebody else's plan and sell their seats.
create or replace function public.guard_venue_map_on_event()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  -- OLD is unassigned on INSERT, so it cannot simply be read: doing that is a
  -- runtime error rather than a null.
  changed boolean := case
    when tg_op = 'INSERT' then new.venue_map_id is not null
    else new.venue_map_id is distinct from old.venue_map_id and new.venue_map_id is not null
  end;
begin
  if changed and not public.is_full_admin() then
    raise exception 'VENUE_PLAN_IS_ADMIN_ONLY'
      using hint = 'Plán sály priraďuje BLUP. Napíš nám cez „Požiadať o plán sály".';
  end if;
  return new;
end;
$$;

drop trigger if exists events_guard_venue_map on public.events;
create trigger events_guard_venue_map
  before insert or update of venue_map_id on public.events
  for each row execute function public.guard_venue_map_on_event();

-- ---------------------------------------------------------------------------
-- The organizer asks; we draw
-- ---------------------------------------------------------------------------
create table if not exists public.venue_plan_requests (
  id              uuid primary key default gen_random_uuid(),
  event_id        uuid not null references public.events (id) on delete cascade,
  organization_id uuid references public.organizations (id) on delete set null,
  requested_by    uuid references public.profiles (id) on delete set null,
  -- Everything we need to draw it without a second round of questions: what the
  -- room is, how many rows, which part is VIP, where the stage is.
  note            text not null,
  -- A plan of the hall, if they have one. A photo of a printed one is fine —
  -- the picture is decoration, the rectangles drawn on it are the data.
  image_url       text,
  status          text not null default 'open'
                  check (status in ('open', 'in_progress', 'done', 'rejected')),
  admin_note      text,
  handled_by      uuid references public.profiles (id) on delete set null,
  handled_at      timestamptz,
  created_at      timestamptz not null default now(),

  constraint venue_plan_requests_note_len check (char_length(btrim(note)) between 20 and 2000)
);

-- One open request per event. Asking twice is impatience, not a second job.
create unique index if not exists venue_plan_requests_open_once
  on public.venue_plan_requests (event_id)
  where status in ('open', 'in_progress');

create index if not exists venue_plan_requests_queue_idx
  on public.venue_plan_requests (status, created_at);

alter table public.venue_plan_requests enable row level security;

drop policy if exists venue_plan_requests_read on public.venue_plan_requests;
create policy venue_plan_requests_read on public.venue_plan_requests
  for select using (
    public.is_admin()
    or (organization_id is not null and public.is_org_member(organization_id, null, auth.uid()))
    or requested_by = auth.uid()
  );

-- Written only through request_venue_plan(), which checks who is asking and
-- about what. A direct insert would skip both.
drop policy if exists venue_plan_requests_no_write on public.venue_plan_requests;
create policy venue_plan_requests_no_write on public.venue_plan_requests
  for insert with check (false);

/**
 * "Chceme predávať po miestach."
 *
 * The organizer's whole side of this feature. They describe the room; we draw
 * it. There is no half-state where they can draw some of it themselves, because
 * a half-drawn plan sells half a hall.
 */
create or replace function public.request_venue_plan(
  p_event_id  uuid,
  p_note      text,
  p_image_url text default null
)
returns public.venue_plan_requests
-- Deliberately NOT strict: p_image_url is optional, and a STRICT function
-- called without it returns null before it runs its own authorization check.
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  me  uuid := auth.uid();
  ev  public.events;
  out public.venue_plan_requests;
  admin_id uuid;
begin
  if me is null then
    raise exception 'UNAUTHENTICATED' using errcode = '28000';
  end if;

  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  -- The person who runs the event, or somebody on its organization. Nobody else
  -- has a reason to ask, and a request is a job somebody here has to do.
  if ev.creator_id <> me
     and not (ev.organization_id is not null and public.is_org_member(ev.organization_id, null, me))
     and not public.is_admin()
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if ev.start_at < now() then
    raise exception 'EVENT_ALREADY_OVER';
  end if;

  if char_length(btrim(coalesce(p_note, ''))) < 20 then
    raise exception 'TELL_US_MORE'
      using hint = 'Napíš aspoň pár viet — koľko radov, kde je pódium, čo je VIP.';
  end if;

  begin
    insert into public.venue_plan_requests
      (event_id, organization_id, requested_by, note, image_url)
    values
      (p_event_id, ev.organization_id, me, btrim(p_note), nullif(btrim(coalesce(p_image_url, '')), ''))
    returning * into out;
  exception when unique_violation then
    raise exception 'VENUE_PLAN_ALREADY_REQUESTED'
      using hint = 'Na tento event už žiadosť máme a robíme na nej.';
  end;

  -- Somebody has to see it. A queue nobody is told about is a queue nobody
  -- empties — which is how this becomes an e-mail people forget.
  for admin_id in select id from public.profiles where app_role = 'admin' loop
    perform public.notify_user(
      admin_id, 'venue_plan', 'Žiadosť o plán sály',
      ev.title || ' — ' || left(btrim(p_note), 120),
      me, ev.id, jsonb_build_object('request_id', out.id)
    );
  end loop;

  return out;
end;
$$;

revoke execute on function public.request_venue_plan(uuid, text, text) from public, anon;
grant execute on function public.request_venue_plan(uuid, text, text) to authenticated;

/** The queue, for whoever is drawing today. */
create or replace function public.venue_plan_queue(p_status text default null)
returns table (
  id              uuid,
  event_id        uuid,
  event_title     text,
  start_at        timestamptz,
  organization    text,
  requested_by    text,
  note            text,
  image_url       text,
  status          text,
  admin_note      text,
  has_plan        boolean,
  created_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return query
  select
    r.id, r.event_id, e.title, e.start_at,
    o.name, coalesce(p.display_name, p.username::text),
    r.note, r.image_url, r.status, r.admin_note,
    e.venue_map_id is not null,
    r.created_at
  from public.venue_plan_requests r
  join public.events e on e.id = r.event_id
  left join public.organizations o on o.id = r.organization_id
  left join public.profiles p on p.id = r.requested_by
  where p_status is null or r.status = p_status
  order by
    case r.status when 'open' then 0 when 'in_progress' then 1 else 2 end,
    e.start_at;
end;
$$;

revoke execute on function public.venue_plan_queue(text) from public, anon;
grant execute on function public.venue_plan_queue(text) to authenticated;

create or replace function public.set_venue_plan_request(
  p_id     uuid,
  p_status text,
  p_note   text default null
)
returns public.venue_plan_requests
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  req public.venue_plan_requests;
  ev  public.events;
begin
  if not public.is_full_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if p_status not in ('open', 'in_progress', 'done', 'rejected') then
    raise exception 'INVALID_STATUS';
  end if;

  update public.venue_plan_requests
  set status     = p_status,
      admin_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), admin_note),
      handled_by = auth.uid(),
      handled_at = now()
  where id = p_id
  returning * into req;

  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select * into ev from public.events where id = req.event_id;

  if req.requested_by is not null and p_status in ('done', 'rejected') then
    perform public.notify_user(
      req.requested_by, 'venue_plan',
      case when p_status = 'done' then 'Plán sály je hotový' else 'Plán sály sme nespravili' end,
      case
        when p_status = 'done'
          then ev.title || ' — miesta sú nachystané, pozri sa, či sedia.'
        else ev.title || ' — ' || coalesce(req.admin_note, 'Napíš nám, ak to chceš prebrať.')
      end,
      auth.uid(), req.event_id, jsonb_build_object('request_id', req.id)
    );
  end if;

  return req;
end;
$$;

revoke execute on function public.set_venue_plan_request(uuid, text, text) from public, anon;
grant execute on function public.set_venue_plan_request(uuid, text, text) to authenticated;

/** What the organizer sees on their own event: asked, being drawn, or done. */
create or replace function public.venue_plan_request_for_event(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'note', r.note,
    'admin_note', r.admin_note,
    'created_at', r.created_at
  )
  from public.venue_plan_requests r
  join public.events e on e.id = r.event_id
  where r.event_id = p_event_id
    and auth.uid() is not null
    and (
      public.is_admin()
      or r.requested_by = auth.uid()
      or e.creator_id = auth.uid()
      or (r.organization_id is not null and public.is_org_member(r.organization_id, null, auth.uid()))
    )
  order by r.created_at desc
  limit 1;
$$;

grant execute on function public.venue_plan_request_for_event(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- A map that a stadium fits in
-- ---------------------------------------------------------------------------
-- The old version put every seat of every sector into one JSON document. Twenty
-- thousand seat objects is several megabytes, built on every open of the
-- screen, to draw one sector — and the screen only ever shows one sector at a
-- time. The map now carries the shape and the counts; section_seats() carries
-- the seats of whichever sector was opened.
create or replace function public.seat_map_for_event(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with ev as (
    select e.id, e.venue_map_id from public.events e where e.id = p_event_id
  ),
  claims as (
    select c.seat_id from public.seat_claims(p_event_id) c
  )
  select case when (select venue_map_id from ev) is null then null else
    jsonb_build_object(
      'map', to_jsonb(m) - 'created_by' - 'updated_by',
      'sections', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'colour', s.colour,
            'kind', s.kind,
            'note', s.note,
            -- A stage or a bar is drawn so people can find themselves on the
            -- plan. Nothing about it is for sale, and the screen must not offer
            -- it as though it were.
            'landmark', public.section_is_landmark(s.kind),
            'x', s.x, 'y', s.y, 'width', s.width, 'height', s.height,
            'ticket_type_id', s.ticket_type_id,
            'price_cents', tt.price_cents,
            'numbered', exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id),
            'seat_count', (select count(*) from public.venue_seats vs where vs.venue_section_id = s.id),
            'available', case
              when public.section_is_landmark(s.kind) then 0
              when exists (select 1 from public.venue_seats vs where vs.venue_section_id = s.id)
                then (select count(*) from public.venue_seats vs
                      where vs.venue_section_id = s.id and vs.is_sellable
                        and not exists (select 1 from claims cl where cl.seat_id = vs.id))
              else coalesce((select a.available
                             from public.ticket_type_availability(s.ticket_type_id) a), 0)
            end,
            -- The grid the dots are laid out on, so the sector can be sized and
            -- drawn before its seats have been fetched.
            'rows', (select count(distinct vs.row_label) from public.venue_seats vs
                     where vs.venue_section_id = s.id),
            'row_width', coalesce((select max(cnt) from (
                select count(*) as cnt from public.venue_seats vs
                where vs.venue_section_id = s.id group by vs.row_label) w), 0)
          ) order by s.sort_order, s.name
        )
        from public.venue_sections s
        left join public.ticket_types tt on tt.id = s.ticket_type_id
        where s.venue_map_id = m.id
      ), '[]'::jsonb)
    )
  end
  from ev
  left join public.venue_maps m on m.id = ev.venue_map_id;
$$;

grant execute on function public.seat_map_for_event(uuid) to anon, authenticated;

/**
 * The seats of one sector, for the sector that is open.
 *
 * Same three-state answer the map used to carry inline — free, yours, taken —
 * and the same guard on ownership: `auth.uid() is not null`, because a guest's
 * claim has no owner and without it a signed-out visitor would be shown every
 * guest-held seat as their own.
 */
create or replace function public.section_seats(p_event_id uuid, p_section_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with claims as (
    select
      c.seat_id,
      bool_or(c.claimed_by is not distinct from auth.uid() and auth.uid() is not null) as is_mine,
      -- 'held' < 'ordered' < 'sold' alphabetically, which is also weakest to
      -- strongest. Luck rather than design, so: max() picks the strongest claim
      -- and renaming one of those three strings breaks it.
      max(case when c.claimed_by is not distinct from auth.uid() and auth.uid() is not null
               then c.claim end) as mine_claim,
      max(case when c.claimed_by is not distinct from auth.uid() and auth.uid() is not null
               then c.hold_until end) as mine_until
    from public.seat_claims(p_event_id) c
    group by c.seat_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', vs.id,
    'row', vs.row_label,
    'number', vs.seat_number,
    'row_index', vs.row_index,
    'sellable', vs.is_sellable,
    'kind', vs.kind,
    'note', vs.note,
    'mine', coalesce(cl.is_mine, false),
    'mine_claim', cl.mine_claim,
    'hold_until', cl.mine_until,
    'taken', cl.seat_id is not null and not coalesce(cl.is_mine, false),
    'free', vs.is_sellable and cl.seat_id is null
  ) order by vs.row_label, vs.seat_number), '[]'::jsonb)
  from (
    select v.*, dense_rank() over (order by v.row_label) - 1 as row_index
    from public.venue_seats v
    where v.venue_section_id = p_section_id
  ) vs
  left join claims cl on cl.seat_id = vs.id;
$$;

grant execute on function public.section_seats(uuid, uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- The same hall, the next night
-- ---------------------------------------------------------------------------
/**
 * Copies a plan onto another event.
 *
 * An arena runs fifty nights a year in the same room, and a sector is tied to a
 * ticket type, which belongs to one event — so without this, the same stadium
 * gets drawn fifty times. Sectors are matched to the new event's ticket types
 * **by name**: "VIP" finds "VIP", and anything with no match comes across
 * unpriced for somebody to point at the right type. Matching by position or by
 * price would be a guess, and a wrong guess here sells the cheap seats at the
 * expensive price.
 *
 * Seats come across as they are, including which ones are wheelchair spaces and
 * which are behind a pillar — those are facts about the room, not about the
 * night.
 */
create or replace function public.clone_venue_map(
  p_source_map_id uuid,
  p_event_id      uuid,
  p_name          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  src       public.venue_maps;
  ev        public.events;
  new_map   uuid;
  sec       record;
  new_sec   uuid;
  matched   uuid;
  old_name  text;
  n_sec     integer := 0;
  n_seat    integer := 0;
  n_unmatched integer := 0;
  copied    integer;
begin
  if not public.is_full_admin() then
    raise exception 'VENUE_PLAN_IS_ADMIN_ONLY';
  end if;

  select * into src from public.venue_maps where id = p_source_map_id;
  if not found then raise exception 'VENUE_MAP_NOT_FOUND'; end if;

  select * into ev from public.events where id = p_event_id;
  if not found then raise exception 'EVENT_NOT_AVAILABLE'; end if;
  if ev.venue_map_id is not null then
    raise exception 'EVENT_ALREADY_HAS_PLAN'
      using hint = 'Najprv odpoj alebo zmaž plán, ktorý na evente už je.';
  end if;

  insert into public.venue_maps
    (organization_id, name, image_url, image_width, image_height, created_by)
  values
    (coalesce(ev.organization_id, src.organization_id),
     coalesce(nullif(btrim(coalesce(p_name, '')), ''), src.name),
     src.image_url, src.image_width, src.image_height, auth.uid())
  returning id into new_map;

  for sec in
    select * from public.venue_sections where venue_map_id = src.id order by sort_order, name
  loop
    -- By name, case-insensitively, and only among this event's own types.
    matched  := null;
    old_name := null;

    if sec.ticket_type_id is not null then
      select name into old_name from public.ticket_types where id = sec.ticket_type_id;

      select tt.id into matched
      from public.ticket_types tt
      where tt.event_id = p_event_id
        and old_name is not null
        and lower(btrim(tt.name)) = lower(btrim(old_name))
      limit 1;
    end if;

    -- A sector that sold something and found nothing to sell here comes across
    -- unpriced, and the count below is what tells whoever is drawing to go and
    -- point it at the right type rather than discovering it at the first sale.
    if not public.section_is_landmark(sec.kind) and sec.ticket_type_id is not null
       and matched is null then
      n_unmatched := n_unmatched + 1;
    end if;

    insert into public.venue_sections
      (venue_map_id, ticket_type_id, name, colour, kind, note, x, y, width, height, sort_order)
    values
      (new_map,
       -- A landmark never carries one, whatever happens to match its name.
       case when public.section_is_landmark(sec.kind) then null else matched end,
       sec.name, sec.colour, sec.kind, sec.note, sec.x, sec.y, sec.width, sec.height, sec.sort_order)
    returning id into new_sec;

    insert into public.venue_seats (venue_section_id, row_label, seat_number, is_sellable, kind, note)
    select new_sec, vs.row_label, vs.seat_number, vs.is_sellable, vs.kind, vs.note
    from public.venue_seats vs
    where vs.venue_section_id = sec.id;

    get diagnostics copied = row_count;
    n_seat := n_seat + copied;
    n_sec  := n_sec + 1;
  end loop;

  update public.events set venue_map_id = new_map where id = p_event_id;

  return jsonb_build_object(
    'venue_map_id', new_map,
    'sections', n_sec,
    'seats', n_seat,
    'unpriced', n_unmatched
  );
end;
$$;

revoke execute on function public.clone_venue_map(uuid, uuid, text) from public, anon;
grant execute on function public.clone_venue_map(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- update_section learns about kinds
-- ---------------------------------------------------------------------------
drop function if exists public.update_section(uuid, text, text, uuid, numeric, numeric, numeric, numeric, integer);

create or replace function public.update_section(
  p_section_id     uuid,
  p_name           text default null,
  p_colour         text default null,
  p_ticket_type_id uuid default null,
  p_x              numeric default null,
  p_y              numeric default null,
  p_width          numeric default null,
  p_height         numeric default null,
  p_sort_order     integer default null,
  p_kind           text default null,
  p_note           text default null
)
returns public.venue_sections
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_map uuid;
  v_out public.venue_sections;
begin
  select venue_map_id into v_map from public.venue_sections where id = p_section_id;
  if v_map is null then
    raise exception 'SECTION_NOT_FOUND';
  end if;
  perform public.assert_can_manage_venue_map(v_map);

  if p_kind is not null and p_kind not in
     ('standard', 'vip', 'box', 'standing', 'wheelchair', 'stage', 'bar', 'entrance', 'other') then
    raise exception 'INVALID_SECTION_KIND';
  end if;

  -- Moving a sector to a different ticket type moves its seats' price and their
  -- event. Tickets already sold name the seat, so they would end up in a sector
  -- selling something else entirely.
  if p_ticket_type_id is not null and exists (
    select 1 from public.venue_seats vs
    join public.tickets t on t.venue_seat_id = vs.id and t.status in ('valid', 'used')
    where vs.venue_section_id = p_section_id
  ) then
    raise exception 'SEATS_IN_USE'
      using hint = 'Zo sektora sú už predané vstupenky, typ vstupenky sa nedá vymeniť.';
  end if;

  -- Turning a sector that sells into a landmark would leave a ticket type
  -- pointed at something nobody can buy, and the table check would refuse the
  -- row with a message about a constraint. Clear it here and say why.
  update public.venue_sections s
  set name           = coalesce(nullif(btrim(coalesce(p_name, '')), ''), s.name),
      colour         = coalesce(p_colour, s.colour),
      kind           = coalesce(p_kind, s.kind),
      note           = case when p_note is null then s.note
                            when btrim(p_note) = '' then null
                            else btrim(p_note) end,
      ticket_type_id = case
        when public.section_is_landmark(coalesce(p_kind, s.kind)) then null
        else coalesce(p_ticket_type_id, s.ticket_type_id)
      end,
      x              = coalesce(p_x, s.x),
      y              = coalesce(p_y, s.y),
      width          = coalesce(p_width, s.width),
      height         = coalesce(p_height, s.height),
      sort_order     = coalesce(p_sort_order, s.sort_order)
  where s.id = p_section_id
  returning * into v_out;

  return v_out;
end;
$$;

revoke execute on function public.update_section(uuid, text, text, uuid, numeric, numeric, numeric, numeric, integer, text, text) from public, anon;
grant execute on function public.update_section(uuid, text, text, uuid, numeric, numeric, numeric, numeric, integer, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The dashboard has to show the queue, or nobody empties it
-- ---------------------------------------------------------------------------
-- One key added; the rest is 0053's function, restated because Postgres has no
-- way to patch a body in place.
create or replace function public.admin_platform_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'suspended_users', (select count(*) from public.profiles where is_suspended),
    'events', (select count(*) from public.events),
    'published_events', (select count(*) from public.events where status = 'published'),
    'listed_events', (select count(*) from public.events where listed_by_platform),
    'organizations', (select count(*) from public.organizations),
    'pending_verifications', (select count(*) from public.organization_verification_requests where status = 'pending'),
    'pending_event_claims', (select count(*) from public.event_claims where status = 'pending'),
    'tickets', (select count(*) from public.tickets),
    'complimentary_tickets', (select count(*) from public.tickets where is_complimentary),
    'open_reports', (select count(*) from public.reports where status = 'open'),
    'gross_sales_cents', coalesce((select sum(subtotal_cents) from public.orders where payment_status = 'succeeded'), 0),
    'net_sales_cents', coalesce((select sum(net_cents) from public.orders where payment_status = 'succeeded'), 0),
    'commission_cents', coalesce((select sum(commission_cents) from public.orders where payment_status = 'succeeded'), 0),
    'archive_fee_cents', coalesce((select sum(archive_fee_cents) from public.orders where payment_status = 'succeeded'), 0),
    'boost_revenue_cents', coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'platform_revenue_cents',
      coalesce((select sum(blup_revenue_cents) from public.orders where payment_status = 'succeeded'), 0)
      + coalesce((select sum(amount_cents) from public.event_boosts where payment_status = 'succeeded'), 0),
    'pending_payouts', (select count(*) from public.payouts where status = 'pending'),
    'open_disputes', (select count(*) from public.payment_disputes where status = 'open'),
    'frozen_organizations',
      (select count(distinct organization_id) from public.payment_disputes where status = 'open'),
    -- Unsent ticket e-mails, and how long the oldest has waited. Both, because
    -- "12 waiting" is normal a few seconds after a sale and alarming after a day.
    'emails_pending',
      (select count(*) from public.email_deliveries where status in ('pending', 'sending')),
    'emails_oldest_minutes',
      coalesce((select round(extract(epoch from (now() - min(created_at))) / 60.0)::integer
                from public.email_deliveries where status in ('pending', 'sending')), 0),
    'emails_failed', (select count(*) from public.email_deliveries where status = 'failed'),
    'premium_users', (select count(distinct user_id) from public.premium_subscriptions
                      where status in ('active', 'trialing', 'grace_period')
                        and (expires_at is null or expires_at > now())),
    -- Organizers waiting for a seating plan. A queue nobody is shown is a queue
    -- nobody empties, and this one is somebody's event going on sale late.
    'open_venue_plan_requests',
      (select count(*) from public.venue_plan_requests where status in ('open', 'in_progress'))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- What I am holding right now, across the whole plan
-- ---------------------------------------------------------------------------
/**
 * The basket clock, without reading the whole stadium to find it.
 *
 * The screen used to answer this by scanning every seat of every sector in the
 * map. That worked while the map carried them; it also meant a stadium had to
 * be downloaded to find out that you are holding two seats in one stand.
 */
create or replace function public.my_seat_holds(p_event_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'seat_id', vs.id,
    'section_id', s.id,
    'section', s.name,
    'row', vs.row_label,
    'number', vs.seat_number,
    'kind', vs.kind,
    'expires_at', c.expires_at
  ) order by s.sort_order, s.name, vs.row_label, vs.seat_number), '[]'::jsonb)
  from public.cart_items c
  join public.venue_seats vs on vs.id = c.venue_seat_id
  join public.venue_sections s on s.id = vs.venue_section_id
  where c.user_id = auth.uid()
    and auth.uid() is not null
    and c.event_id = p_event_id
    and c.expires_at > now();
$$;

revoke execute on function public.my_seat_holds(uuid) from public, anon;
grant execute on function public.my_seat_holds(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The admin drawing a plan has to be able to upload the picture of it
-- ---------------------------------------------------------------------------
-- org-assets is written by owners and admins OF THAT ORGANIZATION, which was
-- right while the organizer drew their own plan. Now that we draw it, a BLUP
-- admin uploading a photo of somebody else's hall would be refused by storage —
-- the button would open a picker, compress the image and fail on the last step.
-- Guarded with to_regclass() like 0012, so the file also runs on the plain
-- Postgres used for schema verification, where storage does not exist.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage schema not present - skipping org-assets policy';
    return;
  end if;

  execute 'drop policy if exists "blup org members manage org assets" on storage.objects';
  execute $p$
    create policy "blup org members manage org assets" on storage.objects
      for all
      using (
        bucket_id = 'org-assets'
        and (
          public.is_org_member(((storage.foldername(name))[1])::uuid,
                               array['owner','admin']::org_role[])
          -- Seating plans live under the organization's folder and are drawn by
          -- us, so the person drawing has to be able to put the picture there.
          or public.is_full_admin()
        )
      )
      with check (
        bucket_id = 'org-assets'
        and (
          public.is_org_member(((storage.foldername(name))[1])::uuid,
                               array['owner','admin']::org_role[])
          or public.is_full_admin()
        )
      )
  $p$;
end
$$;
