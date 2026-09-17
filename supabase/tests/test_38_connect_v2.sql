-- ============================================================================
-- BLUP test 38 · Who Blup Connect suggests, and why
-- ============================================================================
-- The point of the rewrite: two people who both ticked "techno" have nothing in
-- common — there are forty thousand of them. Somebody in your community, who
-- was at the same event last month, does. The test is that the second one wins.
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ja@blup.test'),
  ('22222222-2222-2222-2222-222222222222', 'zkomunity@blup.test'),
  ('33333333-3333-3333-3333-333333333333', 'lentechno@blup.test'),
  ('44444444-4444-4444-4444-444444444444', 'sledujema@blup.test'),
  ('55555555-5555-5555-5555-555555555555', 'cudzi@blup.test');

update public.profiles set latitude = 48.1486, longitude = 17.1077, username = 'jaja'
where id = '11111111-1111-1111-1111-111111111111';
update public.profiles set latitude = 48.1490, longitude = 17.1080, username = 'zkomunity'
where id = '22222222-2222-2222-2222-222222222222';
update public.profiles set latitude = 48.1490, longitude = 17.1080, username = 'lentechno'
where id = '33333333-3333-3333-3333-333333333333';
update public.profiles set latitude = 48.1490, longitude = 17.1080, username = 'sledujema'
where id = '44444444-4444-4444-4444-444444444444';
update public.profiles set latitude = 48.1490, longitude = 17.1080, username = 'cudzi'
where id = '55555555-5555-5555-5555-555555555555';

-- Everybody likes the same four things. Under v1 that was 45 % of the score.
insert into public.user_interests (user_id, interest_id)
select u.id, i.id
from (values
  ('11111111-1111-1111-1111-111111111111'::uuid),
  ('22222222-2222-2222-2222-222222222222'::uuid),
  ('33333333-3333-3333-3333-333333333333'::uuid),
  ('44444444-4444-4444-4444-444444444444'::uuid)
) u(id)
cross join (select id from public.interests order by sort_order limit 4) i;

-- One community, with me and one other person in it.
insert into public.communities (id, slug, name, created_by, category)
values ('ccccccc1-0000-0000-0000-00000000000a', 'nocna-scena', 'Nočná scéna',
        '11111111-1111-1111-1111-111111111111', 'music');

-- The creator is added by a trigger, so this only has to add the other one.
insert into public.community_members (community_id, user_id) values
  ('ccccccc1-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111'),
  ('ccccccc1-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222')
on conflict do nothing;

-- And one person who already follows me.
insert into public.follows (follower_id, following_id)
values ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111');

-- --- the community beats the checkbox ---------------------------------------
do $$
declare
  community_score numeric;
  interests_score numeric;
  bd              jsonb;
begin
  select score, score_breakdown into community_score, bd
  from public.recommend_people('11111111-1111-1111-1111-111111111111')
  where username = 'zkomunity';

  select score into interests_score
  from public.recommend_people('11111111-1111-1111-1111-111111111111')
  where username = 'lentechno';

  assert community_score > interests_score,
    format('the same community must beat the same checkbox (%s vs %s)',
           community_score, interests_score);
  assert bd ->> 'reason' = 'community', format('and say so, got %s', bd ->> 'reason');
  assert (bd -> 'facts' ->> 'shared_communities')::int = 1, 'with the fact behind it';
  assert (bd -> 'facts' -> 'shared_community_names') ? 'Nočná scéna',
    'and the name, so the card can say which one';

  raise notice 'PASS a shared community outranks a shared interest (% > %)',
    community_score, interests_score;
end $$;

-- --- somebody who already follows you is the first suggestion ---------------
do $$
declare r record;
begin
  select * into r from public.recommend_people('11111111-1111-1111-1111-111111111111') limit 1;
  assert r.username = 'sledujema',
    format('the person who reached out first comes first, got %s', r.username);
  assert r.score_breakdown ->> 'reason' = 'follows_you', 'and the reason says why';
  raise notice 'PASS somebody who already follows you is suggested first';
end $$;

-- --- a stranger with nothing in common is not a suggestion ------------------
do $$
declare n integer;
begin
  select count(*) into n
  from public.recommend_people('11111111-1111-1111-1111-111111111111')
  where username = 'cudzi';

  assert n = 0,
    'somebody with nothing in common is not a suggestion, they are a stranger nearby';
  raise notice 'PASS proximity alone is not a reason to meet somebody';
end $$;

-- --- recent time together counts for more than old ---------------------------
do $$
declare
  fresh_score numeric;
  stale_score numeric;
begin
  insert into public.events (id, creator_id, title, category, latitude, longitude,
                             start_at, end_at, is_free)
  values
    ('aaaaaaa1-0000-0000-0000-0000000000e1', '55555555-5555-5555-5555-555555555555',
     'Minulý mesiac', 'techno', 48.149, 17.108,
     now() - interval '30 days', now() - interval '30 days' + interval '5 hours', true),
    ('aaaaaaa1-0000-0000-0000-0000000000e2', '55555555-5555-5555-5555-555555555555',
     'Pred tromi rokmi', 'techno', 48.149, 17.108,
     now() - interval '3 years', now() - interval '3 years' + interval '5 hours', true);

  insert into auth.users (id, email) values
    ('66666666-6666-6666-6666-666666666666', 'nedavno@blup.test'),
    ('77777777-7777-7777-7777-777777777777', 'davno@blup.test');
  update public.profiles set username = 'nedavno' where id = '66666666-6666-6666-6666-666666666666';
  update public.profiles set username = 'davno'   where id = '77777777-7777-7777-7777-777777777777';

  insert into public.event_attendees (event_id, user_id, status) values
    ('aaaaaaa1-0000-0000-0000-0000000000e1', '11111111-1111-1111-1111-111111111111', 'going'),
    ('aaaaaaa1-0000-0000-0000-0000000000e1', '66666666-6666-6666-6666-666666666666', 'going'),
    ('aaaaaaa1-0000-0000-0000-0000000000e2', '11111111-1111-1111-1111-111111111111', 'going'),
    ('aaaaaaa1-0000-0000-0000-0000000000e2', '77777777-7777-7777-7777-777777777777', 'going');

  select score into fresh_score from public.recommend_people('11111111-1111-1111-1111-111111111111')
  where username = 'nedavno';
  select score into stale_score from public.recommend_people('11111111-1111-1111-1111-111111111111')
  where username = 'davno';

  assert fresh_score > stale_score,
    format('last month is a connection, three years ago is a coincidence (%s vs %s)',
           fresh_score, stale_score);

  raise notice 'PASS time together decays (% > %)', fresh_score, stale_score;
end $$;

-- --- passing on somebody is an answer ---------------------------------------
do $$
declare n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform public.dismiss_person('22222222-2222-2222-2222-222222222222');
  reset role;

  select count(*) into n from public.recommend_people('11111111-1111-1111-1111-111111111111')
  where username = 'zkomunity';
  assert n = 0, 'somebody you passed on does not come back tomorrow';

  raise notice 'PASS dismissing somebody sticks';
end $$;

-- --- people you may know, inside a community --------------------------------
do $$
declare
  n      integer;
  failed boolean := false;
begin
  -- A third member, so there is somebody to suggest.
  insert into public.community_members (community_id, user_id)
  values ('ccccccc1-0000-0000-0000-00000000000a', '33333333-3333-3333-3333-333333333333')
  on conflict do nothing;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  select count(*) into n from public.community_people_you_may_know(
    'ccccccc1-0000-0000-0000-00000000000a');
  assert n >= 1, format('a member sees the others, got %s', n);
  reset role;

  -- Somebody outside the community sees nothing: a private roll is not a
  -- directory, and this function reads it with the definer's rights.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
  select count(*) into n from public.community_people_you_may_know(
    'ccccccc1-0000-0000-0000-00000000000a');
  assert n = 0, 'a non-member gets nothing at all';
  reset role;

  raise notice 'PASS the community list is for its members';
end $$;

rollback;
