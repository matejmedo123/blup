-- ============================================================================
-- BLUP test 28 · The handle comes from the name, not the e-mail address
-- ============================================================================
\set ON_ERROR_STOP on

begin;

-- --- a name beats the address ------------------------------------------------
do $$
declare u text;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values ('aaaa1111-0000-0000-0000-000000000001',
          'jozko.mrkvicka@gmail.com',
          jsonb_build_object('display_name', 'Jožko Mrkvička'));

  select username into u from public.profiles
  where id = 'aaaa1111-0000-0000-0000-000000000001';

  assert u = 'jozkomrkvicka', format('expected jozkomrkvicka, got %s', u);
  assert u not like '%.%', 'and it must not carry the shape of the address';
  raise notice 'PASS the handle is made from the name, with the accents folded';
end $$;

-- --- no name: the address is the fallback, not the first choice ---------------
do $$
declare u text;
begin
  insert into auth.users (id, email)
  values ('aaaa1111-0000-0000-0000-000000000002', 'ticho@example.com');

  select username into u from public.profiles
  where id = 'aaaa1111-0000-0000-0000-000000000002';
  assert u = 'ticho', format('expected ticho, got %s', u);
  raise notice 'PASS an account with no name still gets a handle';
end $$;

-- --- two people with the same name do not collide ----------------------------
do $$
declare u text;
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values ('aaaa1111-0000-0000-0000-000000000003',
          'druhy@example.com',
          jsonb_build_object('display_name', 'Jožko Mrkvička'));

  select username into u from public.profiles
  where id = 'aaaa1111-0000-0000-0000-000000000003';
  assert u = 'jozkomrkvicka1', format('expected jozkomrkvicka1, got %s', u);
  raise notice 'PASS a taken handle gets a number, not a failure';
end $$;

-- --- checking one ------------------------------------------------------------
do $$
begin
  assert (public.username_available('nieknieje')->>'ok')::boolean, 'a free handle is free';

  assert not (public.username_available('jozkomrkvicka')->>'ok')::boolean, 'a taken one is not';
  assert public.username_available('jozkomrkvicka')->>'reason' = 'TAKEN',
    format('expected TAKEN, got %s', public.username_available('jozkomrkvicka')->>'reason');

  assert public.username_available('ab')->>'reason' = 'TOO_SHORT', 'two characters is too short';
  assert public.username_available('má medzeru')->>'reason' = 'BAD_CHARACTERS',
    'spaces and accents are not handles';
  assert public.username_available(repeat('a', 21))->>'reason' = 'TOO_LONG', 'twenty-one is too long';

  raise notice 'PASS username_available answers about one handle';
end $$;

-- --- my own handle is not "taken" by me --------------------------------------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', 'aaaa1111-0000-0000-0000-000000000001', true);
  assert (public.username_available('jozkomrkvicka')->>'ok')::boolean,
    'keeping your own handle is not a collision';
  reset role;
  raise notice 'PASS your own handle stays available to you';
end $$;

rollback;
