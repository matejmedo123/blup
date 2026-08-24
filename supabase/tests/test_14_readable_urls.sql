-- ============================================================================
-- BLUP test 14 · Addresses made of words
-- ============================================================================
-- What is actually being proved here:
--
--   · a title becomes a slug, with Slovak diacritics folded, not dropped
--   · two events with the same title both get a usable, distinct slug
--   · a title of nothing but punctuation still yields an address
--   · fixing a typo in the title fixes the address
--   · the old uuid still resolves, so links already handed out keep working
--   · @handle, handle and a uuid all resolve to the same profile
-- ============================================================================
\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a1414141-0000-0000-0000-000000000001', 'slug14@example.com', '{"display_name":"Slug"}');

update public.profiles set username = 'dj_matej' where id = 'a1414141-0000-0000-0000-000000000001';

do $$
declare
  v_user uuid := 'a1414141-0000-0000-0000-000000000001';
  v_a uuid; v_b uuid; v_c uuid;
  s text; got uuid;
begin
  -- ---- the fold ------------------------------------------------------------
  assert public.slugify('Techno v Starej Tržnici') = 'techno-v-starej-trznici',
    format('got %s', public.slugify('Techno v Starej Tržnici'));
  assert public.slugify('Kúpeľňa — ŽIVĚ!  ') = 'kupelna-zive',
    format('got %s', public.slugify('Kúpeľňa — ŽIVĚ!  '));
  raise notice 'PASS Slovak diacritics fold to letters rather than vanishing';

  perform set_config('request.jwt.claim.sub', v_user::text, true);

  insert into public.events (creator_id, title, category, start_at, latitude, longitude, is_free, status)
  values (v_user, 'Silvester 2026', 'techno', now() + interval '30 days', 48.1, 17.1, true, 'published')
  returning id into v_a;

  select slug into s from public.events where id = v_a;
  assert s = 'silvester-2026', format('first slug should be clean, got %s', s);
  raise notice 'PASS a title becomes a readable slug';

  -- ---- a repeated title ----------------------------------------------------
  insert into public.events (creator_id, title, category, start_at, latitude, longitude, is_free, status)
  values (v_user, 'Silvester 2026', 'techno', now() + interval '31 days', 48.1, 17.1, true, 'published')
  returning id into v_b;

  select slug into s from public.events where id = v_b;
  assert s <> 'silvester-2026', 'the second must not collide';
  assert s like 'silvester-2026-%', format('and should still be readable, got %s', s);
  raise notice 'PASS a repeated title still gets a distinct, readable slug';

  -- ---- a title with no letters in it ---------------------------------------
  insert into public.events (creator_id, title, category, start_at, latitude, longitude, is_free, status)
  values (v_user, '?!  ***', 'techno', now() + interval '32 days', 48.1, 17.1, true, 'published')
  returning id into v_c;

  select slug into s from public.events where id = v_c;
  assert s is not null and s like 'event-%', format('should fall back, got %s', s);
  raise notice 'PASS a title with no letters still yields an address';

  -- ---- fixing the title fixes the address ----------------------------------
  update public.events set title = 'Silvester 2027' where id = v_a;
  select slug into s from public.events where id = v_a;
  assert s = 'silvester-2027', format('slug should follow the title, got %s', s);
  raise notice 'PASS correcting a title corrects the address';

  -- ---- resolution ----------------------------------------------------------
  got := public.event_id_from_ref('silvester-2027');
  assert got = v_a, 'a slug resolves';
  got := public.event_id_from_ref(v_a::text);
  assert got = v_a, 'the uuid still resolves, so old links keep working';
  got := public.event_id_from_ref('nothing-like-this');
  assert got is null, 'an unknown slug resolves to nothing rather than erroring';
  raise notice 'PASS a slug and the old uuid both resolve, and nonsense resolves to null';

  -- ---- profiles ------------------------------------------------------------
  assert public.profile_id_from_ref('@dj_matej') = v_user, '@handle resolves';
  assert public.profile_id_from_ref('dj_matej') = v_user, 'bare handle resolves';
  assert public.profile_id_from_ref('DJ_Matej') = v_user, 'handles are case-insensitive';
  assert public.profile_id_from_ref(v_user::text) = v_user, 'the uuid still resolves';
  raise notice 'PASS @handle, handle and uuid all reach the same profile';
end $$;

rollback;
