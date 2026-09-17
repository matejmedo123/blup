-- ============================================================================
-- BLUP · 0060 · Replying to one message instead of to the room
-- ============================================================================
-- In an event chat with thirty people, "o siedmej pred vchodom" is an answer to
-- something — and without saying to what, it is a guess. A reply carries the
-- message it answers, so the thread reads in any order it is read in.
--
-- A column rather than a threads table on purpose. What people actually do is
-- quote one message; nested threads are a different product, and the ones that
-- have them mostly have them unread.
-- ============================================================================

set search_path = public, extensions;

alter table public.messages
  add column if not exists reply_to_id uuid references public.messages (id) on delete set null;

create index if not exists messages_reply_to_idx
  on public.messages (reply_to_id) where reply_to_id is not null;

-- `on delete set null`, so deleting the quoted message leaves the reply
-- standing rather than taking the answer down with the question. The app shows
-- "správa bola zmazaná" in the quote, which is the truth.

-- ---------------------------------------------------------------------------
-- Sending one
-- ---------------------------------------------------------------------------
drop function if exists public.send_message(uuid, text, text);

create or replace function public.send_message(
  p_conversation uuid,
  p_body         text default null,
  p_attachment   text default null,
  p_reply_to     uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me      uuid := auth.uid();
  v_id      uuid;
  v_recent  integer;
  v_body    text := nullif(btrim(coalesce(p_body, '')), '');
  v_name    text;
  v_reply   uuid;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if not public.is_conversation_participant(p_conversation, v_me) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_body is null and p_attachment is null then
    raise exception 'EMPTY_MESSAGE';
  end if;

  if v_body is not null and length(v_body) > 4000 then
    raise exception 'MESSAGE_TOO_LONG';
  end if;

  -- The quoted message has to be in this conversation. Otherwise a reply is a
  -- way to read a line out of a thread you are not in: the client asks for the
  -- quoted message by id, and RLS on that read would be the only thing left
  -- standing between somebody and another room's messages.
  if p_reply_to is not null then
    select id into v_reply
    from public.messages
    where id = p_reply_to and conversation_id = p_conversation and deleted_at is null;

    if v_reply is null then
      raise exception 'REPLY_TARGET_NOT_FOUND';
    end if;
  end if;

  -- Rate limit: 30 messages a minute is far above human typing speed and far
  -- below what a script would want.
  select count(*) into v_recent
  from public.messages
  where sender_id = v_me and created_at > clock_timestamp() - interval '1 minute';

  if v_recent >= 30 then
    raise exception 'RATE_LIMITED';
  end if;

  insert into public.messages (conversation_id, sender_id, body, attachment_url, reply_to_id)
  values (p_conversation, v_me, v_body, p_attachment, v_reply)
  returning id into v_id;

  update public.conversations
    set last_message_at = clock_timestamp()
    where id = p_conversation;

  -- The sender has by definition read their own message.
  update public.conversation_participants
    set last_read_at = clock_timestamp()
    where conversation_id = p_conversation and user_id = v_me;

  select coalesce(display_name, username) into v_name from public.profiles where id = v_me;

  -- Notify everyone else who has not muted the thread.
  perform public.notify_user(
    p.user_id,
    'new_message'::notification_type,
    coalesce(v_name, 'Nová správa'),
    left(coalesce(v_body, '📷 Fotka'), 140),
    v_me,
    c.event_id,
    jsonb_build_object('conversation_id', p_conversation)
  )
  from public.conversation_participants p
  join public.conversations c on c.id = p.conversation_id
  where p.conversation_id = p_conversation
    and p.user_id <> v_me
    and p.left_at is null
    and not p.muted
    -- Somebody being replied to hears about it even with the thread muted:
    -- muting a room is not the same as ignoring an answer to your own message.
    and (not p.muted or p.user_id = (
      select m.sender_id from public.messages m where m.id = v_reply
    ));

  -- And the person being answered, when they have muted the room.
  if v_reply is not null then
    perform public.notify_user(
      m.sender_id,
      'new_message'::notification_type,
      coalesce(v_name, 'Nová správa'),
      left(coalesce(v_body, '📷 Fotka'), 140),
      v_me,
      c.event_id,
      jsonb_build_object('conversation_id', p_conversation, 'reply_to', v_reply)
    )
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join public.conversation_participants p
      on p.conversation_id = m.conversation_id and p.user_id = m.sender_id
    where m.id = v_reply
      and m.sender_id is not null
      and m.sender_id <> v_me
      and p.muted
      and p.left_at is null;
  end if;

  return v_id;
end;
$$;

revoke all on function public.send_message(uuid, text, text, uuid) from public, anon;
grant execute on function public.send_message(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Why this one is worth the drive
-- ---------------------------------------------------------------------------
-- The "Stojí za cestu" rail on the home screen answers this for a handful of
-- events. Arriving at an event from a link answers it for none of them — and an
-- event an hour away, opened cold, reads as a reason to close the tab.
--
-- Same bar as the rail, asked about one event: is it far, is it soon, does it
-- match what this person likes, and is anybody going. Returns null when there
-- is nothing to say, so the screen shows nothing rather than a hedge.
create or replace function public.event_trip_pitch(
  p_event_id uuid,
  p_user_id  uuid default auth.uid(),
  p_lat      double precision default null,
  p_lon      double precision default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  ev          record;
  v_lat       double precision;
  v_lon       double precision;
  v_distance  double precision;
  v_taste     boolean := false;
  v_friends   integer := 0;
begin
  if p_user_id is null then
    return null;
  end if;

  select * into ev from public.events where id = p_event_id;
  if not found or ev.status <> 'published' then
    return null;
  end if;

  select coalesce(p_lat, pr.latitude), coalesce(p_lon, pr.longitude)
  into v_lat, v_lon
  from public.profiles pr where pr.id = p_user_id;

  if v_lat is null or v_lon is null or ev.latitude is null then
    return null;
  end if;

  v_distance := public.blup_distance_m(v_lat, v_lon, ev.latitude, ev.longitude);

  -- Near enough that no explanation is needed, or far enough that no
  -- explanation would help.
  if v_distance < 50000 or v_distance > 220000 then
    return null;
  end if;

  -- Already over, or too far out to plan a trip.
  if public.event_has_ended(ev.start_at, ev.end_at)
     or ev.start_at > now() + interval '45 days' then
    return null;
  end if;

  select exists (
    select 1
    from public.user_interests ui
    join public.interests i on i.id = ui.interest_id
    where ui.user_id = p_user_id
      and (i.category = ev.category or i.category = any(coalesce(ev.categories, array[ev.category])))
  ) into v_taste;

  select count(*) into v_friends
  from public.event_attendees a
  where a.event_id = ev.id
    and a.status in ('going', 'checked_in')
    and public.is_following(a.user_id, p_user_id);

  -- Far is a real cost. Something has to be on the other side of it.
  if not v_taste and v_friends = 0 and ev.attendee_count < 100 then
    return null;
  end if;

  return jsonb_build_object(
    'distance_m',     round(v_distance),
    'city',           ev.city,
    'matches_taste',  v_taste,
    'friends_going',  v_friends,
    'attendee_count', ev.attendee_count
  );
end;
$$;

revoke all on function public.event_trip_pitch(uuid, uuid, double precision, double precision)
  from public, anon;
grant execute on function public.event_trip_pitch(uuid, uuid, double precision, double precision)
  to authenticated;
