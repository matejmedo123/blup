-- ---------------------------------------------------------------------------
-- Zmazať chat s niekým.
--
-- What "delete" can honestly mean here matters. Nobody can reach into somebody
-- else's phone and take a message back, so a delete that claimed to do that
-- would be a lie told by the UI. What it does instead is clear the thread from
-- *your* inbox: the conversation row survives (the other person still has
-- their copy), but for you it starts again from empty.
--
-- `cleared_at` is the marker. Everything written before it is invisible to you
-- — in the inbox, in the thread, and at the RLS level, so it is not merely
-- filtered in a query the client could choose not to run. If the other person
-- writes again the thread comes back, carrying only what was said after you
-- cleared it. That is the same shape as leaving a room and being called back
-- into it, which is what actually happened.
--
-- `left_at` alone was not enough for this: start_direct_conversation() clears
-- it the moment either side opens the thread again, so it cannot remember that
-- you once wiped the history.
-- ---------------------------------------------------------------------------

alter table public.conversation_participants
  add column if not exists cleared_at timestamptz;

-- ---------------------------------------------------------------------------
-- Visibility. Both halves have to agree, or the inbox shows a preview of a
-- message the thread then refuses to display.
-- ---------------------------------------------------------------------------

-- A message is yours to see when you are in the conversation AND it was written
-- after you last cleared it.
create or replace function public.can_see_message(
  p_conversation uuid,
  p_created_at   timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.conversation_participants p
    where p.conversation_id = p_conversation
      and p.user_id = auth.uid()
      and (p.cleared_at is null or p_created_at > p.cleared_at)
  );
$$;

revoke execute on function public.can_see_message(uuid, timestamptz) from public;
grant execute on function public.can_see_message(uuid, timestamptz) to authenticated;

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select using (public.can_see_message(conversation_id, created_at));

-- ---------------------------------------------------------------------------
-- The action itself.
-- ---------------------------------------------------------------------------
create or replace function public.delete_conversation(p_conversation uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  -- Deliberately not left_at. Leaving takes you out of the conversation for
  -- good, and for a direct chat that would mean the person you deleted can
  -- never reach you again — a block, dressed up as a delete. Clearing only
  -- empties your side; if they write again the thread comes back with their
  -- new message in it and nothing above it.
  update public.conversation_participants
    set cleared_at   = clock_timestamp(),
        last_read_at = clock_timestamp()
    where conversation_id = p_conversation
      and user_id = v_me;

  if not found then
    raise exception 'NOT_AUTHORIZED';
  end if;
end;
$$;

revoke execute on function public.delete_conversation(uuid) from public;
grant execute on function public.delete_conversation(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The inbox has to agree with the thread.
--
-- Rebuilt rather than patched: a cleared conversation must not merely lose its
-- preview, it must not be listed at all until there is something new in it.
-- Unread counts from before the clear are gone with it.
-- ---------------------------------------------------------------------------
create or replace function public.my_conversations(p_limit integer default 50)
returns table (
  id               uuid,
  kind             conversation_kind,
  event_id         uuid,
  title            text,
  last_message_at  timestamptz,
  last_message     text,
  last_sender_id   uuid,
  unread_count     integer,
  muted            boolean,
  other_user_id    uuid,
  other_name       text,
  other_username   text,
  other_avatar_url text,
  participant_count integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with mine as (
    select c.*, p.last_read_at, p.muted, p.cleared_at
    from public.conversations c
    join public.conversation_participants p
      on p.conversation_id = c.id and p.user_id = auth.uid() and p.left_at is null
  ),
  last_messages as (
    select distinct on (m.conversation_id)
      m.conversation_id, m.body, m.attachment_url, m.sender_id, m.created_at
    from public.messages m
    join mine on mine.id = m.conversation_id
    where mine.cleared_at is null or m.created_at > mine.cleared_at
    order by m.conversation_id, m.created_at desc, m.id desc
  )
  select
    mine.id,
    mine.kind,
    mine.event_id,
    coalesce(mine.title, other.display_name, other.username),
    lm.created_at,
    case
      when lm.body is not null then lm.body
      -- A GIF is not a photo, and the inbox calling it one is the kind of small
      -- lie that makes a preview useless.
      when lm.attachment_url ilike '%.gif' then 'GIF'
      when lm.attachment_url is not null then '📷 Fotka'
      else null
    end,
    lm.sender_id,
    (
      select count(*)::integer from public.messages m2
      where m2.conversation_id = mine.id
        and m2.created_at > greatest(mine.last_read_at, coalesce(mine.cleared_at, mine.last_read_at))
        and m2.sender_id <> auth.uid()
        and m2.deleted_at is null
    ),
    mine.muted,
    other.id,
    other.display_name,
    other.username,
    other.avatar_url,
    (
      select count(*)::integer from public.conversation_participants cp
      where cp.conversation_id = mine.id and cp.left_at is null
    )
  from mine
  left join last_messages lm on lm.conversation_id = mine.id
  left join lateral (
    select pr.id, pr.display_name, pr.username, pr.avatar_url
    from public.conversation_participants cp
    join public.profiles pr on pr.id = cp.user_id
    where cp.conversation_id = mine.id and cp.user_id <> auth.uid()
    limit 1
  ) other on mine.kind = 'direct'
  -- A cleared thread stays out of the list until somebody writes in it again.
  where mine.cleared_at is null or lm.created_at is not null
  order by lm.created_at desc nulls last
  limit greatest(p_limit, 1);
$$;

-- The tab badge counts the same messages the inbox does.
create or replace function public.unread_message_count()
returns integer
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(sum(
    (
      select count(*) from public.messages m
      where m.conversation_id = p.conversation_id
        and m.created_at > greatest(p.last_read_at, coalesce(p.cleared_at, p.last_read_at))
        and m.sender_id <> auth.uid()
        and m.deleted_at is null
    )
  ), 0)::integer
  from public.conversation_participants p
  where p.user_id = auth.uid() and p.left_at is null;
$$;
