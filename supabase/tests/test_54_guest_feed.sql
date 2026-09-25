-- ============================================================================
-- Čo vidí neprihlásený človek vo feede
-- ============================================================================
-- Dve veci, ktoré spolu súvisia viac, než vyzerajú.
--
-- Prvá je kozmetická: neprihlásenému sa ponúkalo „Pre teba", hoci nemá účet,
-- nemá záujmy a nikoho nesleduje — takže „pre teba" nemalo z čoho vzniknúť.
--
-- Druhá už kozmetická nie je. `feed_posts` je `security definer`, čo znamená,
-- že beží s právami vlastníka a RLS na `posts` ho neobmedzuje. Politika
-- `posts_select` skrýva príspevky zo súkromných komunít; funkcia sa pýtala len
-- na `not is_deleted`. Súkromná komunita teda nebola súkromná — stačilo
-- otvoriť feed.
--
-- Test sa pýta na oboje z pohľadu `anon`, teda presne tak, ako sa appka pýta
-- za nikým neprihláseného.
-- ============================================================================
begin;
set search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5454545-0000-0000-0000-000000000001', 'ana54@example.com', now(), '{"display_name":"Ana Nováková"}'),
  ('a5454545-0000-0000-0000-000000000002', 'bob54@example.com', now(), '{"display_name":"Bob Kováč"}');

update public.profiles set username = 'ana54' where id = 'a5454545-0000-0000-0000-000000000001';
update public.profiles set username = 'bob54' where id = 'a5454545-0000-0000-0000-000000000002';

-- Jedna komunita verejná, jedna súkromná. Ana je v oboch.
insert into public.communities (id, slug, name, is_private, created_by) values
  ('c5454545-0000-0000-0000-000000000001', 'verejna54', 'Verejná',  false,
   'a5454545-0000-0000-0000-000000000001'),
  ('c5454545-0000-0000-0000-000000000002', 'sukromna54', 'Súkromná', true,
   'a5454545-0000-0000-0000-000000000001');

insert into public.community_members (community_id, user_id, role) values
  ('c5454545-0000-0000-0000-000000000001', 'a5454545-0000-0000-0000-000000000001', 'owner'),
  ('c5454545-0000-0000-0000-000000000002', 'a5454545-0000-0000-0000-000000000001', 'owner')
on conflict do nothing;

-- ============================================================================
-- 1. Súkromná komunita je súkromná aj vo feede
-- ============================================================================
do $$
declare
  v_ana     uuid := 'a5454545-0000-0000-0000-000000000001';
  v_public  uuid := 'c5454545-0000-0000-0000-000000000001';
  v_private uuid := 'c5454545-0000-0000-0000-000000000002';
  v_seen    integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);

  insert into public.posts (author_id, community_id, body)
  values (v_ana, v_public,  'toto smie vidieť ktokoľvek');
  insert into public.posts (author_id, community_id, body)
  values (v_ana, v_private, 'toto je len pre členov');

  -- Ana je členka, takže vidí oboje.
  select count(*) into v_seen from public.feed_posts('all', 50)
  where community_id in (v_public, v_private);
  assert v_seen = 2, format('členka mala vidieť oba príspevky, vidí %s', v_seen);

  -- A teraz to isté za nikým neprihláseného.
  reset role;
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into v_seen from public.feed_posts('all', 50)
  where community_id = v_public;
  assert v_seen = 1, format('verejný príspevok mal byť vidno, vidno %s', v_seen);

  select count(*) into v_seen from public.feed_posts('all', 50)
  where community_id = v_private;
  assert v_seen = 0,
    format('ÚNIK: neprihlásený vidí %s príspevkov zo súkromnej komunity', v_seen);

  -- Rovnaká otázka cez ostatné dva pohľady — únik sa nesmie dať obísť tým,
  -- že si človek prepne záložku.
  select count(*) into v_seen from public.feed_posts('for_you', 50)
  where community_id = v_private;
  assert v_seen = 0, format('ÚNIK cez „Pre teba": %s príspevkov', v_seen);

  select count(*) into v_seen from public.feed_posts('following', 50)
  where community_id = v_private;
  assert v_seen = 0, format('ÚNIK cez „Sledujem": %s príspevkov', v_seen);

  reset role;
  raise notice 'PASS súkromná komunita zostáva súkromná aj vo feede';
end $$;

-- ============================================================================
-- 2. Neprihlásenému sa „Pre teba" ani neponúka
-- ============================================================================
-- Appka si záložku vyberá podľa `feed_counts`. Kým to hlásilo, že „Pre teba"
-- má obsah, appka ju otvorila ako prvú — a ukázala neprihlásenému celý web pod
-- nadpisom, ktorý tvrdil, že je vybraný preňho.
do $$
declare
  v_counts jsonb;
begin
  set local role anon;
  perform set_config('request.jwt.claim.sub', '', true);

  v_counts := public.feed_counts();

  assert (v_counts->>'for_you')::integer = 0,
    format('„Pre teba" hlási neprihlásenému %s položiek', v_counts->>'for_you');
  assert (v_counts->>'following')::integer = 0,
    format('„Sledujem" hlási neprihlásenému %s položiek', v_counts->>'following');
  -- „Všetko" obsah mať smie — to je jediný pohľad, ktorý bez účtu dáva zmysel.
  assert (v_counts->>'all')::integer >= 1,
    '„Všetko" má neprihlásenému ukázať verejné príspevky';

  reset role;
  raise notice 'PASS neprihlásenému sa osobné pohľady neponúkajú';
end $$;

rollback;
