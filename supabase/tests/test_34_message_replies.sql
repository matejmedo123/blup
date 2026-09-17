-- ============================================================================
-- BLUP test 34 · Replying to a message
-- ============================================================================
-- The one that matters is the third: a reply must not become a way to read a
-- line out of a conversation you are not in.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'anna@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'boris@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'cudzi@blup.test');

-- A conversation between Anna and Boris, and a separate one Cudzí is in.
insert into public.conversations (id, kind) values
  ('dddddddd-0000-0000-0000-00000000000a', 'direct'),
  ('dddddddd-0000-0000-0000-00000000000b', 'direct');

insert into public.conversation_participants (conversation_id, user_id) values
  ('dddddddd-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111'),
  ('dddddddd-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222'),
  ('dddddddd-0000-0000-0000-00000000000b', '33333333-3333-3333-3333-333333333333');

-- --- a reply carries what it answers ----------------------------------------
do $$
declare
  first_id uuid;
  reply_id uuid;
  r        record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  first_id := public.send_message('dddddddd-0000-0000-0000-00000000000a', 'O koľkej sa stretneme?');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  reply_id := public.send_message(
    'dddddddd-0000-0000-0000-00000000000a', 'O siedmej pred vchodom', null, first_id);
  reset role;

  select * into r from public.messages where id = reply_id;
  assert r.reply_to_id = first_id, 'the reply remembers what it answers';

  raise notice 'PASS a reply carries the message it answers';
end $$;

-- --- and it must be a message from this conversation ------------------------
do $$
declare
  theirs uuid;
  failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  theirs := public.send_message('dddddddd-0000-0000-0000-00000000000b', 'Tajná správa');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  begin
    perform public.send_message(
      'dddddddd-0000-0000-0000-00000000000a', 'Aha', null, theirs);
  exception when others then failed := true;
  end;
  reset role;

  assert failed, 'quoting a message from another conversation must be refused';
  raise notice 'PASS a reply cannot quote a room you are not in';
end $$;

-- --- a deleted message leaves the answer standing ---------------------------
do $$
declare
  q      uuid;
  a      uuid;
  still  integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  q := public.send_message('dddddddd-0000-0000-0000-00000000000a', 'Otázka na zmazanie');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  a := public.send_message('dddddddd-0000-0000-0000-00000000000a', 'Odpoveď', null, q);
  reset role;

  delete from public.messages where id = q;

  select count(*) into still from public.messages where id = a;
  assert still = 1, 'deleting the question must not delete the answer';
  assert (select reply_to_id from public.messages where id = a) is null,
    'and the quote simply empties, which the app shows as „správa bola zmazaná"';

  raise notice 'PASS deleting the quoted message leaves the reply standing';
end $$;

-- --- a muted room still tells you somebody answered you ---------------------
do $$
declare
  q       uuid;
  before_n integer;
  after_n  integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  q := public.send_message('dddddddd-0000-0000-0000-00000000000a', 'Otázka do stlmenej miestnosti');
  reset role;

  update public.conversation_participants set muted = true
  where conversation_id = 'dddddddd-0000-0000-0000-00000000000a'
    and user_id = '11111111-1111-1111-1111-111111111111';

  select count(*) into before_n from public.notifications
  where user_id = '11111111-1111-1111-1111-111111111111';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  perform public.send_message('dddddddd-0000-0000-0000-00000000000a', 'Odpoveď tebe', null, q);
  reset role;

  select count(*) into after_n from public.notifications
  where user_id = '11111111-1111-1111-1111-111111111111';

  assert after_n = before_n + 1,
    format('muting a room is not ignoring an answer to your own message (%s -> %s)',
           before_n, after_n);

  raise notice 'PASS a muted room still tells you when somebody answers you';
end $$;

rollback;
