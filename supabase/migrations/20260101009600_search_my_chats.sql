-- ---------------------------------------------------------------------------
-- Hľadanie v Správach hľadá ľudí, nie eventy.
--
-- The magnifier above the inbox opened /search, which searches events. Tapping
-- search inside your messages and being asked what concert you want is the
-- wrong question answered confidently — the thing anybody is looking for there
-- is a person they have talked to.
--
-- So: the threads you already have, matched on the other person's name or on
-- an event chat's title; and after them, people you follow (or who follow you)
-- that you have not written to yet, so "find them and start" is one screen
-- rather than two. `conversation_id` is null for that second kind, which is
-- how the caller knows it has to open the thread before it can show it.
-- ---------------------------------------------------------------------------
create or replace function public.search_my_chats(
  p_query text,
  p_limit integer default 30
)
returns table (
  conversation_id   uuid,
  kind              conversation_kind,
  title             text,
  user_id           uuid,
  display_name      text,
  username          text,
  avatar_url        text,
  last_message      text,
  last_message_at   timestamptz,
  unread_count      integer,
  participant_count integer
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with needle as (
    -- % and _ are wildcards in LIKE; somebody typing them means the characters.
    select '%' || replace(replace(trim(coalesce(p_query, '')), '\', '\\'), '%', '\%') || '%' as pattern,
           trim(coalesce(p_query, '')) as raw
  ),
  mine as (
    select c.id, c.kind, c.title, c.event_id, p.last_read_at, p.cleared_at
    from public.conversations c
    join public.conversation_participants p
      on p.conversation_id = c.id and p.user_id = auth.uid() and p.left_at is null
  ),
  other as (
    select mine.id as conversation_id, pr.id as user_id,
           pr.display_name, pr.username, pr.avatar_url
    from mine
    join public.conversation_participants cp
      on cp.conversation_id = mine.id and cp.user_id <> auth.uid()
    join public.profiles pr on pr.id = cp.user_id
    where mine.kind = 'direct'
  ),
  last_messages as (
    select distinct on (m.conversation_id)
      m.conversation_id, m.body, m.attachment_url, m.created_at
    from public.messages m
    join mine on mine.id = m.conversation_id
    where mine.cleared_at is null or m.created_at > mine.cleared_at
    order by m.conversation_id, m.created_at desc, m.id desc
  ),
  threads as (
    select
      mine.id,
      mine.kind,
      coalesce(mine.title, other.display_name, other.username) as title,
      other.user_id, other.display_name, other.username, other.avatar_url,
      case
        when lm.body is not null then lm.body
        when lm.attachment_url ilike '%.gif' then 'GIF'
        when lm.attachment_url is not null then '📷 Fotka'
        else null
      end as last_message,
      lm.created_at as last_message_at,
      (
        select count(*)::integer from public.messages m2
        where m2.conversation_id = mine.id
          and m2.created_at > greatest(mine.last_read_at, coalesce(mine.cleared_at, mine.last_read_at))
          and m2.sender_id <> auth.uid()
          and m2.deleted_at is null
      ) as unread_count,
      (
        select count(*)::integer from public.conversation_participants cp2
        where cp2.conversation_id = mine.id and cp2.left_at is null
      ) as participant_count
    from mine
    cross join needle
    left join other on other.conversation_id = mine.id
    left join last_messages lm on lm.conversation_id = mine.id
    where (mine.cleared_at is null or lm.created_at is not null)
      and (
        needle.raw = ''
        or coalesce(mine.title, '')        ilike needle.pattern
        or coalesce(other.display_name,'') ilike needle.pattern
        or coalesce(other.username, '')    ilike needle.pattern
      )
  ),
  -- People worth offering even without a thread: your own circles, not the
  -- whole user table. Searching your messages should not turn into a directory
  -- of strangers.
  known as (
    select distinct pr.id, pr.display_name, pr.username, pr.avatar_url
    from public.profiles pr
    cross join needle
    where needle.raw <> ''
      and not pr.is_suspended
      and pr.id <> auth.uid()
      and (
        pr.id in (select following_id from public.follows where follower_id = auth.uid())
        or pr.id in (select follower_id from public.follows where following_id = auth.uid())
      )
      and (
        coalesce(pr.display_name, '') ilike needle.pattern
        or coalesce(pr.username, '') ilike needle.pattern
      )
      and pr.id not in (select user_id from threads where user_id is not null)
  )
  select id, kind, title, user_id, display_name, username, avatar_url,
         last_message, last_message_at, unread_count, participant_count
  from threads
  union all
  select null::uuid, null::conversation_kind, coalesce(display_name, username),
         id, display_name, username, avatar_url,
         null::text, null::timestamptz, 0, 0
  from known
  -- Threads first (they have a date), then the people you could write to.
  order by last_message_at desc nulls last, title
  limit greatest(p_limit, 1);
$$;

revoke execute on function public.search_my_chats(text, integer) from public;
grant execute on function public.search_my_chats(text, integer) to authenticated;
