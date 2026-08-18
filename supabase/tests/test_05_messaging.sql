-- ============================================================================
-- BLUP test 05 · Messaging — membership, privacy, rate limit, event chats
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1111111-1111-1111-1111-111111111111', 'ada@example.com',  '{"display_name":"Ada"}'),
  ('b2222222-2222-2222-2222-222222222222', 'bob@example.com',  '{"display_name":"Bob"}'),
  ('c3333333-3333-3333-3333-333333333333', 'cara@example.com', '{"display_name":"Cara"}');

set local role authenticated;

-- --- opening a direct chat --------------------------------------------------
do $$
declare
  v_first  uuid;
  v_second uuid;
  v_count  integer;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);

  v_first := public.start_direct_conversation('b2222222-2222-2222-2222-222222222222');
  assert v_first is not null, 'a direct conversation must be created';

  -- Opening it again must return the same thread, not a duplicate.
  v_second := public.start_direct_conversation('b2222222-2222-2222-2222-222222222222');
  assert v_first = v_second, 'opening the same chat twice must reuse the conversation';

  select count(*) into v_count from public.conversations where kind = 'direct';
  assert v_count = 1, format('expected exactly one direct conversation, found %s', v_count);

  select count(*) into v_count from public.conversation_participants
   where conversation_id = v_first;
  assert v_count = 2, 'a direct chat has exactly two participants';

  raise notice 'PASS direct conversation is created once and reused';
end $$;

-- --- you cannot message yourself --------------------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  begin
    perform public.start_direct_conversation('a1111111-1111-1111-1111-111111111111');
    raise exception 'TEST FAILED: a self-chat was allowed';
  exception when raise_exception then
    raise notice 'PASS cannot open a chat with yourself';
  end;
end $$;

-- --- a closed inbox is respected --------------------------------------------
do $$
begin
  reset role;
  update public.profiles set allow_dm = false
   where id = 'c3333333-3333-3333-3333-333333333333';
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  begin
    perform public.start_direct_conversation('c3333333-3333-3333-3333-333333333333');
    raise exception 'TEST FAILED: a closed inbox accepted a stranger';
  exception when raise_exception then
    raise notice 'PASS allow_dm = false blocks a stranger';
  end;

  -- …but someone Cara follows can still write to her.
  reset role;
  insert into public.follows (follower_id, following_id)
  values ('c3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111');
  set local role authenticated;

  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  perform public.start_direct_conversation('c3333333-3333-3333-3333-333333333333');
  raise notice 'PASS a closed inbox still accepts people the owner follows';
end $$;

-- --- messages are visible only to participants ------------------------------
do $$
declare
  v_conversation uuid;
  v_visible      integer;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  v_conversation := public.start_direct_conversation('b2222222-2222-2222-2222-222222222222');
  perform public.send_message(v_conversation, 'Ideš dnes von?');

  select count(*) into v_visible from public.messages where conversation_id = v_conversation;
  assert v_visible = 1, 'the sender must see their own message';

  perform set_config('request.jwt.claim.sub', 'b2222222-2222-2222-2222-222222222222', true);
  select count(*) into v_visible from public.messages where conversation_id = v_conversation;
  assert v_visible = 1, 'the recipient must see the message';

  perform set_config('request.jwt.claim.sub', 'c3333333-3333-3333-3333-333333333333', true);
  select count(*) into v_visible from public.messages where conversation_id = v_conversation;
  assert v_visible = 0,
    format('an outsider must not read the thread, saw %s messages', v_visible);

  raise notice 'PASS messages are readable only by participants';
end $$;

-- --- an outsider cannot post into a thread ----------------------------------
do $$
declare v_conversation uuid;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  select id into v_conversation from public.conversations
   where kind = 'direct' and created_by = 'a1111111-1111-1111-1111-111111111111'
   order by created_at limit 1;

  perform set_config('request.jwt.claim.sub', 'c3333333-3333-3333-3333-333333333333', true);
  begin
    perform public.send_message(v_conversation, 'Ahoj, čítam vám správy');
    raise exception 'TEST FAILED: an outsider posted into a private thread';
  exception when raise_exception then
    raise notice 'PASS an outsider cannot post into a thread';
  end;
end $$;

-- --- the client cannot write public.messages directly -----------------------
do $$
declare v_conversation uuid;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  select id into v_conversation from public.conversations where kind = 'direct' limit 1;

  begin
    insert into public.messages (conversation_id, sender_id, body)
    values (v_conversation, 'b2222222-2222-2222-2222-222222222222', 'Toto som nenapísal ja');
    raise exception 'TEST FAILED: a message was inserted directly by the client';
  exception when insufficient_privilege or raise_exception then
    raise notice 'PASS messages cannot be inserted directly (no forged senders)';
  end;
end $$;

-- --- unread counting and read markers ---------------------------------------
do $$
declare
  v_conversation uuid;
  v_unread       integer;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  v_conversation := public.start_direct_conversation('b2222222-2222-2222-2222-222222222222');
  perform public.send_message(v_conversation, 'Prvá');
  perform public.send_message(v_conversation, 'Druhá');

  perform set_config('request.jwt.claim.sub', 'b2222222-2222-2222-2222-222222222222', true);
  select public.unread_message_count() into v_unread;
  assert v_unread >= 2, format('recipient should have unread messages, got %s', v_unread);

  perform public.mark_conversation_read(v_conversation);
  select public.unread_message_count() into v_unread;
  assert v_unread = 0, format('after reading, unread must be zero, got %s', v_unread);

  -- The sender never has unread messages from themselves.
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  select public.unread_message_count() into v_unread;
  assert v_unread = 0, 'your own messages must never count as unread';

  raise notice 'PASS unread counts and read markers';
end $$;

-- --- the inbox function returns the thread with its last message ------------
do $$
declare
  v_row record;
begin
  perform set_config('request.jwt.claim.sub', 'b2222222-2222-2222-2222-222222222222', true);
  select * into v_row from public.my_conversations(10) limit 1;

  assert v_row.id is not null, 'the inbox must list the conversation';
  assert v_row.last_message = 'Druhá',
    format('the inbox must carry the latest message, got %s', v_row.last_message);
  assert v_row.other_name = 'Ada',
    format('a direct thread must be titled after the other person, got %s', v_row.other_name);

  raise notice 'PASS inbox lists threads with their last message';
end $$;

-- --- rate limiting ----------------------------------------------------------
do $$
declare
  v_conversation uuid;
  i integer;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  v_conversation := public.start_direct_conversation('b2222222-2222-2222-2222-222222222222');

  begin
    for i in 1..40 loop
      perform public.send_message(v_conversation, 'spam ' || i);
    end loop;
    raise exception 'TEST FAILED: the rate limit did not fire';
  exception when raise_exception then
    raise notice 'PASS sending is rate limited';
  end;
end $$;

-- --- event group chat -------------------------------------------------------
do $$
declare
  v_event        uuid;
  v_conversation uuid;
  v_again        uuid;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);

  insert into public.events (creator_id, title, category, start_at, latitude, longitude, is_free, status)
  values ('a1111111-1111-1111-1111-111111111111', 'Kávička', 'coffee',
          now() + interval '2 days', 48.1486, 17.1077, true, 'published')
  returning id into v_event;

  -- The host can open it even before anyone RSVPs.
  v_conversation := public.join_event_conversation(v_event);
  assert v_conversation is not null, 'the host must be able to open the event chat';

  -- Somebody who is not going cannot.
  perform set_config('request.jwt.claim.sub', 'c3333333-3333-3333-3333-333333333333', true);
  begin
    perform public.join_event_conversation(v_event);
    raise exception 'TEST FAILED: a non-attendee joined the event chat';
  exception when raise_exception then
    raise notice 'PASS only attendees can join an event chat';
  end;

  -- Once they RSVP, they can.
  insert into public.event_attendees (event_id, user_id, status)
  values (v_event, 'c3333333-3333-3333-3333-333333333333', 'going');

  v_again := public.join_event_conversation(v_event);
  assert v_again = v_conversation, 'an event has exactly one chat';

  perform public.send_message(v_again, 'Kto nesie deku?');
  raise notice 'PASS event group chat is created once and joined by attendees';
end $$;

-- --- deleting your own message ----------------------------------------------
do $$
declare
  v_message uuid;
  v_body    text;
begin
  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  select id into v_message from public.messages
   where sender_id = 'a1111111-1111-1111-1111-111111111111'
   order by created_at desc limit 1;

  -- Somebody else cannot delete it.
  perform set_config('request.jwt.claim.sub', 'b2222222-2222-2222-2222-222222222222', true);
  begin
    perform public.delete_message(v_message);
    raise exception 'TEST FAILED: another user deleted a message';
  exception when raise_exception then
    null;
  end;

  perform set_config('request.jwt.claim.sub', 'a1111111-1111-1111-1111-111111111111', true);
  perform public.delete_message(v_message);

  select body into v_body from public.messages where id = v_message;
  assert v_body is null, 'a deleted message must lose its body';

  raise notice 'PASS only the sender can delete their message';
end $$;

reset role;
rollback;
