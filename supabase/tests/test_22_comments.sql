-- ============================================================================
-- BLUP test 22 · A comment posts, and the count follows it
-- ============================================================================
-- What is actually being proved here:
--
--   · a signed-in visitor can comment on a published event, through RLS
--   · the insert returns the row (the app reads it back to render it)
--   · the event's comment_count follows, and comes back down on delete
--   · a comment on an event nobody may see is refused
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a2222222-0000-0000-0000-000000000001', 'org22@example.com',  '{"display_name":"Org"}'),
  ('a2222222-0000-0000-0000-000000000002', 'goer22@example.com', '{"display_name":"Goer"}');

insert into public.events (id, creator_id, title, category, start_at, latitude, longitude, is_free, status)
values
  ('e2222222-0000-0000-0000-000000000001', 'a2222222-0000-0000-0000-000000000001',
   'Verejny', 'techno', now() + interval '4 days', 48.3, 18.08, true, 'published'),
  ('e2222222-0000-0000-0000-000000000002', 'a2222222-0000-0000-0000-000000000001',
   'Koncept', 'techno', now() + interval '4 days', 48.3, 18.08, true, 'draft');

set local role authenticated;

-- --- the ordinary case, which is what the app does ---------------------------
do $$
declare v_id uuid; n integer;
begin
  perform set_config('request.jwt.claim.sub', 'a2222222-0000-0000-0000-000000000002', true);

  insert into public.comments (event_id, user_id, body)
  values ('e2222222-0000-0000-0000-000000000001',
          'a2222222-0000-0000-0000-000000000002',
          'O kolkej sa otvara?')
  returning id into v_id;

  assert v_id is not null, 'the insert returns the row the app renders';

  -- ...and it can be read straight back, which is the same round trip the app
  -- makes with .insert().select().single().
  assert exists (select 1 from public.comments where id = v_id),
    'the comment is readable by the person who wrote it';

  select comment_count into n from public.events
   where id = 'e2222222-0000-0000-0000-000000000001';
  assert n = 1, format('the event counts one comment, got %s', n);

  raise notice 'PASS a visitor can comment and the count follows';
end $$;

-- --- deleting takes the count back down --------------------------------------
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub', 'a2222222-0000-0000-0000-000000000002', true);

  update public.comments set is_deleted = true
   where event_id = 'e2222222-0000-0000-0000-000000000001';

  select comment_count into n from public.events
   where id = 'e2222222-0000-0000-0000-000000000001';
  assert n = 0, format('a deleted comment stops counting, got %s', n);
  raise notice 'PASS deleting a comment takes the count back down';
end $$;

-- --- an event nobody may see takes no comments -------------------------------
do $$
begin
  perform set_config('request.jwt.claim.sub', 'a2222222-0000-0000-0000-000000000002', true);
  begin
    insert into public.comments (event_id, user_id, body)
    values ('e2222222-0000-0000-0000-000000000002',
            'a2222222-0000-0000-0000-000000000002', 'Ahoj?');
    raise exception 'TEST FAILED: commented on somebody else''s draft';
  exception
    when insufficient_privilege then
      raise notice 'PASS a draft nobody can see takes no comments';
    when raise_exception then raise;
  end;
end $$;

rollback;
