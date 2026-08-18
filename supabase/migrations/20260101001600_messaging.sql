-- ============================================================================
-- BLUP · 0016 · Messaging (direct chats + event group chats)
-- ============================================================================
-- Conversations are either a 1:1 direct chat between two people, or the group
-- chat attached to an event. Membership is the authorization boundary: every
-- policy on this feature reduces to "is auth.uid() a participant".
--
-- Writes go through send_message() rather than a plain INSERT so the app can
-- never forge a sender, bypass the block/privacy checks, or skip the rate
-- limit. The client only has SELECT on messages.
-- ============================================================================


-- Resolve the citext type and pgcrypto functions regardless of which schema
-- the extensions were installed into (public locally, extensions on Supabase).
set search_path = public, extensions;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'conversation_kind') then
    create type conversation_kind as enum ('direct', 'event');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  kind            conversation_kind not null default 'direct',
  event_id        uuid unique references public.events (id) on delete cascade,
  title           text,
  created_by      uuid references public.profiles (id) on delete set null,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),

  -- A direct chat has no event; an event chat must have one.
  constraint conversations_kind_matches_event check (
    (kind = 'event' and event_id is not null) or (kind = 'direct' and event_id is null)
  )
);

create index if not exists conversations_recent_idx
  on public.conversations (last_message_at desc nulls last);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz not null default '-infinity'::timestamptz,
  muted           boolean not null default false,
  left_at         timestamptz,
  primary key (conversation_id, user_id)
);

create index if not exists conversation_participants_user_idx
  on public.conversation_participants (user_id) where left_at is null;

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid references public.profiles (id) on delete set null,
  body            text,
  attachment_url  text,
  -- clock_timestamp(), not now(): now() is the transaction timestamp, so two
  -- messages written in one transaction would tie and "latest" would be
  -- arbitrary. The read markers below use the same clock for the same reason.
  created_at      timestamptz not null default clock_timestamp(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  -- A live message carries text, an image, or both — but never nothing.
  -- A soft-deleted one is empty by design, so the rule is lifted for it.
  constraint messages_have_content check (
    deleted_at is not null
    or (body is not null and length(btrim(body)) > 0)
    or attachment_url is not null
  ),
  constraint messages_body_length check (body is null or length(body) <= 4000)
);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Membership helper. SECURITY DEFINER so the policies can call it without the
-- participant lookup itself being blocked by RLS (which would recurse).
-- ---------------------------------------------------------------------------
create or replace function public.is_conversation_participant(
  p_conversation uuid,
  p_user uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.conversation_participants
    where conversation_id = p_conversation
      and user_id = p_user
      and left_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- Opening a direct chat.
--
-- Reuses the existing conversation between the two people if there is one, so
-- tapping "Napísať" twice does not create two threads. Respects the recipient's
-- allow_dm setting: a closed inbox is only open to people they follow back.
-- ---------------------------------------------------------------------------
create or replace function public.start_direct_conversation(p_target uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me            uuid := auth.uid();
  v_conversation  uuid;
  v_allows_dm     boolean;
  v_suspended     boolean;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  if p_target is null or p_target = v_me then
    raise exception 'INVALID_RECIPIENT';
  end if;

  select allow_dm, is_suspended into v_allows_dm, v_suspended
  from public.profiles where id = p_target;

  if not found or v_suspended then
    raise exception 'INVALID_RECIPIENT';
  end if;

  -- A closed inbox still accepts messages from people the owner follows.
  if not coalesce(v_allows_dm, true) and not public.is_following(v_me, p_target) then
    raise exception 'DM_NOT_ALLOWED';
  end if;

  select c.id into v_conversation
  from public.conversations c
  where c.kind = 'direct'
    and exists (
      select 1 from public.conversation_participants p
      where p.conversation_id = c.id and p.user_id = v_me
    )
    and exists (
      select 1 from public.conversation_participants p
      where p.conversation_id = c.id and p.user_id = p_target
    )
    and (
      select count(*) from public.conversation_participants p where p.conversation_id = c.id
    ) = 2
  limit 1;

  if v_conversation is not null then
    -- Re-open it for anyone who had left.
    update public.conversation_participants
      set left_at = null
      where conversation_id = v_conversation and user_id in (v_me, p_target);
    return v_conversation;
  end if;

  insert into public.conversations (kind, created_by)
  values ('direct', v_me)
  returning id into v_conversation;

  insert into public.conversation_participants (conversation_id, user_id)
  values (v_conversation, v_me), (v_conversation, p_target);

  return v_conversation;
end;
$$;

-- ---------------------------------------------------------------------------
-- The event group chat. Anyone who is going to the event (plus its host) can
-- join; the conversation is created lazily the first time someone opens it.
-- ---------------------------------------------------------------------------
create or replace function public.join_event_conversation(p_event uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me           uuid := auth.uid();
  v_conversation uuid;
  v_event        public.events%rowtype;
  v_is_going     boolean;
begin
  if v_me is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  select * into v_event from public.events where id = p_event;
  if not found or v_event.status = 'cancelled' then
    raise exception 'EVENT_NOT_AVAILABLE';
  end if;

  select exists (
    select 1 from public.event_attendees
    where event_id = p_event and user_id = v_me and status in ('going', 'checked_in')
  ) into v_is_going;

  if not v_is_going and v_event.creator_id <> v_me then
    raise exception 'NOT_ATTENDING';
  end if;

  select id into v_conversation from public.conversations where event_id = p_event;

  if v_conversation is null then
    insert into public.conversations (kind, event_id, title, created_by)
    values ('event', p_event, v_event.title, v_event.creator_id)
    returning id into v_conversation;

    -- The host is always in their own event chat.
    insert into public.conversation_participants (conversation_id, user_id)
    values (v_conversation, v_event.creator_id)
    on conflict do nothing;
  end if;

  insert into public.conversation_participants (conversation_id, user_id)
  values (v_conversation, v_me)
  on conflict (conversation_id, user_id) do update set left_at = null;

  return v_conversation;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sending. The only write path into public.messages for an end user.
-- ---------------------------------------------------------------------------
create or replace function public.send_message(
  p_conversation uuid,
  p_body         text default null,
  p_attachment   text default null
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

  -- Rate limit: 30 messages a minute is far above human typing speed and far
  -- below what a script would want.
  select count(*) into v_recent
  from public.messages
  where sender_id = v_me and created_at > clock_timestamp() - interval '1 minute';

  if v_recent >= 30 then
    raise exception 'RATE_LIMITED';
  end if;

  insert into public.messages (conversation_id, sender_id, body, attachment_url)
  values (p_conversation, v_me, v_body, p_attachment)
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
    and not p.muted;

  return v_id;
end;
$$;

create or replace function public.mark_conversation_read(p_conversation uuid)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.conversation_participants
    set last_read_at = clock_timestamp()
    where conversation_id = p_conversation
      and user_id = auth.uid();
$$;

create or replace function public.set_conversation_muted(p_conversation uuid, p_muted boolean)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.conversation_participants
    set muted = p_muted
    where conversation_id = p_conversation
      and user_id = auth.uid();
$$;

create or replace function public.leave_conversation(p_conversation uuid)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update public.conversation_participants
    set left_at = clock_timestamp()
    where conversation_id = p_conversation
      and user_id = auth.uid();
$$;

-- Deleting is soft: the row stays so the thread keeps its shape, but the body
-- is cleared. Only the sender can do it.
create or replace function public.delete_message(p_message uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.messages
    set deleted_at = clock_timestamp(), body = null, attachment_url = null
    where id = p_message and sender_id = auth.uid() and deleted_at is null;

  if not found then
    raise exception 'NOT_AUTHORIZED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The inbox: one row per conversation with everything the list screen needs,
-- so it is a single round trip instead of an N+1.
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
    select c.*, p.last_read_at, p.muted
    from public.conversations c
    join public.conversation_participants p
      on p.conversation_id = c.id and p.user_id = auth.uid() and p.left_at is null
  ),
  last_messages as (
    select distinct on (m.conversation_id)
      m.conversation_id, m.body, m.attachment_url, m.sender_id, m.created_at
    from public.messages m
    where m.conversation_id in (select id from mine)
    order by m.conversation_id, m.created_at desc, m.id desc
  )
  select
    mine.id,
    mine.kind,
    mine.event_id,
    coalesce(mine.title, other.display_name, other.username),
    mine.last_message_at,
    case
      when lm.body is not null then lm.body
      when lm.attachment_url is not null then '📷 Fotka'
      else null
    end,
    lm.sender_id,
    (
      select count(*)::integer from public.messages m2
      where m2.conversation_id = mine.id
        and m2.created_at > mine.last_read_at
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
  order by mine.last_message_at desc nulls last
  limit greatest(p_limit, 1);
$$;

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
        and m.created_at > p.last_read_at
        and m.sender_id <> auth.uid()
        and m.deleted_at is null
    )
  ), 0)::integer
  from public.conversation_participants p
  where p.user_id = auth.uid() and p.left_at is null;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.conversations             enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages                  enable row level security;

drop policy if exists conversations_select on public.conversations;
create policy conversations_select on public.conversations
  for select using (public.is_conversation_participant(id));

drop policy if exists conversation_participants_select on public.conversation_participants;
create policy conversation_participants_select on public.conversation_participants
  for select using (public.is_conversation_participant(conversation_id));

-- A participant may update only their own row (read marker, mute, leave).
drop policy if exists conversation_participants_update_self on public.conversation_participants;
create policy conversation_participants_update_self on public.conversation_participants
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select using (public.is_conversation_participant(conversation_id));

-- No insert/update/delete policy on messages: the client writes exclusively
-- through send_message() / delete_message().

-- ---------------------------------------------------------------------------
-- Grants. Table privileges are explicit; RLS above is what actually decides.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on public.conversations, public.conversation_participants,
             public.messages to authenticated';
    execute 'grant update (last_read_at, muted, left_at)
             on public.conversation_participants to authenticated';
    execute 'revoke insert, delete on public.conversations, public.messages from authenticated';
  end if;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.conversations, public.conversation_participants,
             public.messages from anon';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Storage for chat attachments.
--
-- A PRIVATE bucket: a photo sent in a private conversation must not be readable
-- by anyone who guesses the URL. Objects are stored as
-- `<conversation-id>/<sender-id>/<file>` so the policy can check membership from
-- the first path segment, and the app reads them through short-lived signed URLs.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present – skipping chat bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('chat-media', 'chat-media', false, 10485760,
          array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists "blup chat media is participant only" on storage.objects';
  execute $p$
    create policy "blup chat media is participant only" on storage.objects
      for select using (
        bucket_id = 'chat-media'
        and public.is_conversation_participant(((storage.foldername(name))[1])::uuid)
      )
  $p$;

  execute 'drop policy if exists "blup chat media upload" on storage.objects';
  execute $p$
    create policy "blup chat media upload" on storage.objects
      for insert with check (
        bucket_id = 'chat-media'
        and public.is_conversation_participant(((storage.foldername(name))[1])::uuid)
        and (storage.foldername(name))[2] = auth.uid()::text
      )
  $p$;

  execute 'drop policy if exists "blup chat media delete own" on storage.objects';
  execute $p$
    create policy "blup chat media delete own" on storage.objects
      for delete using (
        bucket_id = 'chat-media'
        and (storage.foldername(name))[2] = auth.uid()::text
      )
  $p$;
end
$$;

-- ---------------------------------------------------------------------------
-- Realtime: a thread updates live while it is open.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach t in array array['messages', 'conversations'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
