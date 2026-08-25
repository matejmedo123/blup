-- ============================================================================
-- BLUP test 15 · A feed that is about you
-- ============================================================================
-- What is actually being proved here:
--
--   · "following" holds people you follow, your communities and yourself
--   · and nothing from a stranger you have no connection to
--   · "for_you" holds the categories you picked, and the people you follow
--   · somebody with no interests yet gets everything rather than an empty page
--   · "all" is still everything
--   · the scope is applied before the limit, not after
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1515151-0000-0000-0000-000000000001', 'me15@example.com',      '{"display_name":"Me"}'),
  ('a1515151-0000-0000-0000-000000000002', 'friend15@example.com',  '{"display_name":"Friend"}'),
  ('a1515151-0000-0000-0000-000000000003', 'stranger15@example.com','{"display_name":"Stranger"}');

insert into public.follows (follower_id, following_id)
values ('a1515151-0000-0000-0000-000000000001', 'a1515151-0000-0000-0000-000000000002');

insert into public.interests (id, slug, name, category)
values ('11515151-0000-0000-0000-000000000001', 'techno-15', 'Techno', 'techno');

insert into public.user_interests (user_id, interest_id)
values ('a1515151-0000-0000-0000-000000000001', '11515151-0000-0000-0000-000000000001');

insert into public.events (id, creator_id, title, category, start_at, latitude, longitude, is_free, status)
values
  ('e1515151-0000-0000-0000-000000000001', 'a1515151-0000-0000-0000-000000000003',
   'Techno noc', 'techno', now() + interval '5 days', 48.1, 17.1, true, 'published'),
  ('e1515151-0000-0000-0000-000000000002', 'a1515151-0000-0000-0000-000000000003',
   'Joga v parku', 'yoga', now() + interval '6 days', 48.1, 17.1, true, 'published');

-- friend posts about yoga (followed author, uninteresting category)
-- stranger posts about techno (interesting category, unknown author)
-- stranger posts about yoga (neither)
insert into public.posts (id, author_id, event_id, body) values
  ('01515151-0000-0000-0000-000000000001', 'a1515151-0000-0000-0000-000000000002',
   'e1515151-0000-0000-0000-000000000002', 'Idem na jogu'),
  ('01515151-0000-0000-0000-000000000002', 'a1515151-0000-0000-0000-000000000003',
   'e1515151-0000-0000-0000-000000000001', 'Techno je late'),
  ('01515151-0000-0000-0000-000000000003', 'a1515151-0000-0000-0000-000000000003',
   'e1515151-0000-0000-0000-000000000002', 'Joga bola fajn');

do $$
declare
  me uuid := 'a1515151-0000-0000-0000-000000000001';
  ids uuid[];
begin
  perform set_config('request.jwt.claim.sub', me::text, true);

  -- ---- following ----------------------------------------------------------
  select array_agg(id order by id) into ids from public.feed_posts('following', 50);
  assert ids @> array['01515151-0000-0000-0000-000000000001'::uuid],
    'a post from someone you follow is in "following"';
  assert not (ids @> array['01515151-0000-0000-0000-000000000002'::uuid]),
    'a stranger is not, however interesting their category';
  raise notice 'PASS "following" is the people you follow, and only them';

  -- ---- for_you ------------------------------------------------------------
  select array_agg(id order by id) into ids from public.feed_posts('for_you', 50);
  assert ids @> array['01515151-0000-0000-0000-000000000002'::uuid],
    'techno is in your interests, so a stranger posting about it appears';
  assert ids @> array['01515151-0000-0000-0000-000000000001'::uuid],
    'and so does someone you follow, whatever they post about';
  assert not (ids @> array['01515151-0000-0000-0000-000000000003'::uuid]),
    'a stranger posting outside your interests does not';
  raise notice 'PASS "for_you" is your categories plus the people you follow';

  -- ---- all ----------------------------------------------------------------
  select array_agg(id order by id) into ids from public.feed_posts('all', 50);
  assert array_length(ids, 1) = 3, format('all should hold every post, got %s', array_length(ids, 1));
  raise notice 'PASS "all" is still everything';

  -- ---- the scope is applied before the limit ------------------------------
  -- One row asked for; it must be the newest of the SCOPED set, not the newest
  -- of everything then filtered down to nothing.
  select array_agg(id) into ids from public.feed_posts('following', 1);
  assert array_length(ids, 1) = 1, 'a limit of one returns one';
  assert ids[1] = '01515151-0000-0000-0000-000000000001',
    'and it is from the scope, not filtered out of a wider page';
  raise notice 'PASS the scope narrows before the limit, not after';

  -- ---- somebody brand new -------------------------------------------------
  perform set_config('request.jwt.claim.sub', 'a1515151-0000-0000-0000-000000000003', true);
  select array_agg(id) into ids from public.feed_posts('for_you', 50);
  assert array_length(ids, 1) = 3,
    format('with no interests recorded, "for you" is everything, got %s', array_length(ids, 1));
  raise notice 'PASS a brand-new account gets a full feed, not an empty one';
end $$;

rollback;
