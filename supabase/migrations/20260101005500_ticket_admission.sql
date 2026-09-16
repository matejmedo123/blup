-- ============================================================================
-- BLUP · 0055 · Turning a single ticket off (and back on), and the door list
-- ============================================================================
-- Two things an organizer needs on the day and does not have yet:
--
--   1. A ticket that must stop working. A chargeback, a resale they did not
--      allow, a comp sent to the wrong address. Refunding is not always the
--      answer and deleting is never one, so a ticket gets switched off —
--      check_in_ticket() already refuses anything whose status is not 'valid',
--      so this makes the scanner reject it at the door for real.
--
--   2. The list behind the numbers. The statistics screen says how many
--      tickets were sold; it never says to whom. This adds the actual list —
--      the holder's name, the address the ticket was sent to, and the code —
--      to whoever runs the event and to nobody else.
--
-- Note on counts: switching a ticket off moves it out of 'valid', and
-- sync_ticket_counts() counts only 'valid' and 'used'. So the seat goes back
-- into inventory and tickets_sold drops by one. That is deliberate — a ticket
-- that cannot be used is not a person in the room.
-- ============================================================================

set search_path = public, extensions;

alter table public.tickets
  add column if not exists deactivated_at     timestamptz,
  add column if not exists deactivated_by     uuid references public.profiles (id) on delete set null,
  add column if not exists deactivation_reason text;

-- ---------------------------------------------------------------------------
-- Who may touch the door list
-- ---------------------------------------------------------------------------
-- Reading the list is already gated by assert_can_read_event_stats(). Writing
-- is narrower: a finance member can see the money without being able to void
-- somebody's ticket.
create or replace function public.assert_can_admit(p_event_id uuid)
returns public.events
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ev public.events;
begin
  if auth.uid() is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select * into ev from public.events where id = p_event_id;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;

  if ev.creator_id <> auth.uid()
     and not (ev.organization_id is not null
              and public.is_org_member(ev.organization_id,
                    array['owner', 'admin', 'event_manager']::org_role[]))
     and not public.is_full_admin()
  then
    raise exception 'NOT_AUTHORIZED';
  end if;

  return ev;
end;
$$;

revoke all on function public.assert_can_admit(uuid) from public, anon;
grant execute on function public.assert_can_admit(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------
-- NOT strict on purpose: p_reason is optional, and a STRICT function called
-- without it would skip its own authorization check and return null.
create or replace function public.set_ticket_active(
  p_ticket_id uuid,
  p_active    boolean,
  p_reason    text default null
)
returns public.tickets
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  t      public.tickets;
  ev     public.events;
  reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_ticket_id is null or p_active is null then
    raise exception 'INVALID_INPUT';
  end if;

  select * into t from public.tickets where id = p_ticket_id for update;
  if not found then
    raise exception 'TICKET_NOT_FOUND';
  end if;

  ev := public.assert_can_admit(t.event_id);

  -- A refunded ticket is a money decision, not a door decision. Switching one
  -- back on would hand out a seat that was paid back, so it is refused here and
  -- has to go through the refund flow instead.
  if t.status = 'refunded' then
    raise exception 'TICKET_REFUNDED'
      using hint = 'Refundovaná vstupenka sa nedá znova aktivovať.';
  end if;

  if p_active then
    if t.status = 'valid' then
      return t;               -- already on; nothing to log
    end if;

    -- 'used' means it was scanned. Re-activating it is the "let them back in"
    -- case, so the check-in is cleared too — otherwise the next scan would say
    -- ALREADY_USED and the organizer would be back where they started.
    update public.tickets
    set status = 'valid',
        checked_in_at = null,
        checked_in_by = null,
        deactivated_at = null,
        deactivated_by = null,
        deactivation_reason = null
    where id = t.id
    returning * into t;
  else
    if t.status = 'cancelled' then
      return t;
    end if;

    update public.tickets
    set status = 'cancelled',
        deactivated_at = now(),
        deactivated_by = auth.uid(),
        deactivation_reason = reason
    where id = t.id
    returning * into t;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_type, target_id, meta)
  values (
    auth.uid(),
    case when p_active then 'ticket_reactivated' else 'ticket_deactivated' end,
    'ticket', t.id,
    jsonb_build_object(
      'event_id', ev.id,
      'code', t.code,
      'reason', reason
    )
  );

  -- Tell the holder, if the ticket belongs to an account. A guest ticket has no
  -- inbox here; their copy is the e-mail, and the code simply stops scanning.
  if t.buyer_id is not null then
    insert into public.notifications (user_id, type, title, body, event_id, data)
    values (
      t.buyer_id,
      'ticket_confirmed',
      case when p_active then 'Vstupenka je opäť platná' else 'Vstupenka bola deaktivovaná' end,
      case
        when p_active then 'Organizátor tvoju vstupenku znova aktivoval.'
        else coalesce(reason, 'Organizátor tvoju vstupenku deaktivoval. Pri vstupe už neprejde.')
      end,
      ev.id,
      jsonb_build_object('ticket_id', t.id, 'active', p_active)
    );
  end if;

  return t;
end;
$$;

revoke all on function public.set_ticket_active(uuid, boolean, text) from public, anon;
grant execute on function public.set_ticket_active(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The door list
-- ---------------------------------------------------------------------------
-- Real names, the address each ticket went to, and the code. This is personal
-- data, so it is SECURITY DEFINER over assert_can_read_event_stats() and
-- nothing else: a visitor, another organizer, an unrelated org member reading
-- the table directly gets nothing, because RLS on tickets never exposed these
-- rows to them in the first place.
create or replace function public.event_ticket_holders(
  p_event_id uuid,
  p_query    text    default null,
  p_status   text    default null,
  p_limit    integer default 100,
  p_offset   integer default 0
)
returns table (
  ticket_id      uuid,
  code           text,
  status         ticket_status,
  holder_name    text,
  email          text,
  username       text,
  buyer_id       uuid,
  is_guest       boolean,
  ticket_type    text,
  price_cents    integer,
  currency       text,
  is_complimentary boolean,
  checked_in_at  timestamptz,
  deactivated_at timestamptz,
  deactivation_reason text,
  order_id       uuid,
  created_at     timestamptz
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  needle text := nullif(btrim(coalesce(p_query, '')), '');
  want   text := nullif(btrim(coalesce(p_status, '')), '');
begin
  perform public.assert_can_read_event_stats(p_event_id);

  return query
  select
    t.id,
    t.code,
    t.status,
    -- Whatever name we actually have: the one written on the ticket, then the
    -- account's, then the guest name from the order. Never a placeholder that
    -- looks like a person.
    coalesce(nullif(btrim(coalesce(t.holder_name, '')), ''),
             nullif(btrim(coalesce(p.display_name, '')), ''),
             nullif(btrim(coalesce(t.guest_name, '')), ''),
             p.username::text),
    coalesce(public.ticket_email_for(t.buyer_id), t.guest_email::text),
    p.username::text,
    t.buyer_id,
    t.buyer_id is null,
    tt.name,
    t.price_cents,
    t.currency,
    coalesce(t.is_complimentary, false),
    t.checked_in_at,
    t.deactivated_at,
    t.deactivation_reason,
    t.order_id,
    t.created_at
  from public.tickets t
  left join public.profiles p on p.id = t.buyer_id
  left join public.ticket_types tt on tt.id = t.ticket_type_id
  where t.event_id = p_event_id
    and (want is null or t.status::text = want)
    and (
      needle is null
      or t.code ilike '%' || needle || '%'
      or coalesce(t.holder_name, '') ilike '%' || needle || '%'
      or coalesce(t.guest_name, '') ilike '%' || needle || '%'
      or coalesce(p.display_name, '') ilike '%' || needle || '%'
      or coalesce(p.username::text, '') ilike '%' || needle || '%'
      or coalesce(t.guest_email::text, '') ilike '%' || needle || '%'
      or coalesce(public.ticket_email_for(t.buyer_id), '') ilike '%' || needle || '%'
    )
  order by t.created_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.event_ticket_holders(uuid, text, text, integer, integer) from public, anon;
grant execute on function public.event_ticket_holders(uuid, text, text, integer, integer) to authenticated;

-- The counts that sit above the list, so the screen does not have to fetch
-- every row to say how many are checked in.
create or replace function public.event_ticket_summary(p_event_id uuid)
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

  select jsonb_build_object(
    'total',        count(*),
    'valid',        count(*) filter (where t.status = 'valid'),
    'used',         count(*) filter (where t.status = 'used'),
    'cancelled',    count(*) filter (where t.status = 'cancelled'),
    'refunded',     count(*) filter (where t.status = 'refunded'),
    'complimentary',count(*) filter (where coalesce(t.is_complimentary, false)),
    'guests',       count(*) filter (where t.buyer_id is null)
  )
  into out_json
  from public.tickets t
  where t.event_id = p_event_id;

  return coalesce(out_json, jsonb_build_object(
    'total', 0, 'valid', 0, 'used', 0, 'cancelled', 0,
    'refunded', 0, 'complimentary', 0, 'guests', 0
  ));
end;
$$;

revoke all on function public.event_ticket_summary(uuid) from public, anon;
grant execute on function public.event_ticket_summary(uuid) to authenticated;
