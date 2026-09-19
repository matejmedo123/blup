-- ============================================================================
-- BLUP test 48 · Premium sa dá prideliť — a nedá sa ukradnúť
-- ============================================================================
-- Tento test existuje kvôli jednej vete v migrácii: `is_premium()` odteraz číta
-- `profiles.premium_until`. Ten stĺpec je na profile, ktorý si každý smie
-- upraviť. Keby ho nestrážil trigger, Premium by si zaplo ktokoľvek jedným
-- UPDATE-om — takže to, čo sa tu overuje najprísnejšie, nie je prideľovanie,
-- ale že si ho človek prideliť NEVIE.
-- ============================================================================
\set ON_ERROR_STOP on

begin;

set local search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4848484-0000-0000-0000-000000000001', 'admin48@example.com',  now(), '{"display_name":"Admin"}'),
  ('a4848484-0000-0000-0000-000000000002', 'clovek48@example.com', now(), '{"display_name":"Človek"}'),
  ('a4848484-0000-0000-0000-000000000003', 'platca48@example.com', now(), '{"display_name":"Platca"}'),
  ('a4848484-0000-0000-0000-000000000004', 'mod48@example.com',    now(), '{"display_name":"Moderátor"}');

update public.profiles set app_role = 'admin'     where id = 'a4848484-0000-0000-0000-000000000001';
update public.profiles set app_role = 'moderator' where id = 'a4848484-0000-0000-0000-000000000004';

-- --- nikto si Premium nezapne sám -------------------------------------------
do $$
declare me uuid := 'a4848484-0000-0000-0000-000000000002';
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', me::text, true);

  -- Nie je to chyba — zápis prejde. Trigger len vráti pôvodnú hodnotu, presne
  -- ako pri app_role. Preto sa tu kontroluje výsledok, nie výnimka.
  update public.profiles
  set premium_until = now() + interval '10 years'
  where id = me;

  reset role;

  assert (select premium_until from public.profiles where id = me) is null,
    'úprava vlastného profilu Premium nezapne';
  assert not public.is_premium(me),
    'a teda ani funkcie sa neodomknú';

  raise notice 'PASS Premium si zápisom do vlastného profilu nikto nedá';
end $$;

-- --- ani cez cudzí profil ----------------------------------------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a4848484-0000-0000-0000-000000000002', true);
  begin
    perform public.admin_set_premium('a4848484-0000-0000-0000-000000000002', 365);
  exception when others then failed := true;
  end;

  -- Moderátor moderuje obsah; toto je vec prevádzky.
  perform set_config('request.jwt.claim.sub',
                     'a4848484-0000-0000-0000-000000000004', true);
  begin
    perform public.admin_set_premium('a4848484-0000-0000-0000-000000000002', 365);
    failed := failed and false;
  exception when others then null;
  end;
  reset role;

  assert failed, 'prideľovanie Premium nie je pre každého';
  assert not public.is_premium('a4848484-0000-0000-0000-000000000002'),
    'a nič sa nezmenilo';

  raise notice 'PASS prideliť Premium smie len plný admin';
end $$;

-- --- admin ho prideliť vie ---------------------------------------------------
do $$
declare
  admin  uuid := 'a4848484-0000-0000-0000-000000000001';
  clovek uuid := 'a4848484-0000-0000-0000-000000000002';
  result jsonb;
  until1 timestamptz;
  until2 timestamptz;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  result := public.admin_set_premium(clovek, 30, 'kompenzácia za zrušený event');
  assert (result ->> 'is_premium')::boolean, 'tridsať dní znamená Premium';
  until1 := (result ->> 'premium_until')::timestamptz;
  assert until1 > now() + interval '29 days', 'a je to naozaj tridsať dní';

  reset role;
  assert public.is_premium(clovek), 'a funkcie sa odomknú, nielen odznak';

  -- Predĺženie sa počíta od toho, čo zostáva. Inak by pridanie mesiaca
  -- človeku s mesiacom jeden mesiac zobralo.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  until2 := (public.admin_set_premium(clovek, 30) ->> 'premium_until')::timestamptz;
  reset role;

  assert until2 > until1 + interval '29 days',
    'predĺženie pripočítava, neprepisuje';

  raise notice 'PASS admin vie Premium prideliť aj predĺžiť';
end $$;

-- --- a je vidieť, PREČO ho človek má -----------------------------------------
-- Toto bolo pôvodné hlásenie: obrazovka Premium tvrdila adminovi, že Premium
-- nemá, hoci mu všetky funkcie fungovali. Dve odpovede na tú istú otázku.
do $$
declare
  status jsonb;
begin
  set local role authenticated;

  perform set_config('request.jwt.claim.sub',
                     'a4848484-0000-0000-0000-000000000001', true);
  status := public.my_premium_status();
  assert (status ->> 'is_premium')::boolean, 'admin Premium má';
  assert status ->> 'source' = 'admin', 'a je vidieť, že z roly';

  perform set_config('request.jwt.claim.sub',
                     'a4848484-0000-0000-0000-000000000002', true);
  status := public.my_premium_status();
  assert (status ->> 'is_premium')::boolean, 'obdarovaný tiež';
  assert status ->> 'source' = 'granted', 'a je vidieť, že mu ho niekto dal';
  assert (status ->> 'expires_at') is not null, 'aj dokedy';

  perform set_config('request.jwt.claim.sub',
                     'a4848484-0000-0000-0000-000000000004', true);
  status := public.my_premium_status();
  assert not (status ->> 'is_premium')::boolean, 'moderátor Premium nemá';
  assert status ->> 'source' = 'none', 'a hovorí to rovno';

  reset role;
  raise notice 'PASS obrazovka Premium povie aj to, odkiaľ Premium je';
end $$;

-- --- odobratie vráti človeka k tomu, čo si platí ------------------------------
do $$
declare
  admin  uuid := 'a4848484-0000-0000-0000-000000000001';
  clovek uuid := 'a4848484-0000-0000-0000-000000000002';
  platca uuid := 'a4848484-0000-0000-0000-000000000003';
  status jsonb;
begin
  -- Platca má skutočné predplatné a k nemu grant.
  insert into public.premium_subscriptions (user_id, platform, status, product_id, expires_at)
  values (platca, 'apple', 'active', 'com.blup.app.premium.monthly', now() + interval '60 days');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  perform public.admin_set_premium(platca, 30);

  -- Odobratie grantu.
  perform public.admin_set_premium(platca, 0);
  perform public.admin_set_premium(clovek, 0);
  reset role;

  assert public.is_premium(platca),
    'kto si platí, o Premium odobratím grantu nepríde';
  assert not public.is_premium(clovek),
    'kto nič neplatí, oň príde';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', platca::text, true);
  status := public.my_premium_status();
  reset role;
  assert status ->> 'source' = 'subscription',
    'a je to zase predplatné, nie grant';

  raise notice 'PASS odobratie grantu nesiahne na skutočné predplatné';
end $$;

-- --- účtovníctvo to nevidí ako tržbu -----------------------------------------
-- Fingovaný riadok v premium_subscriptions by bol o jeden príkaz kratší a
-- účtovníctvo by ukazovalo peniaze, ktoré neprišli.
do $$
declare
  admin  uuid := 'a4848484-0000-0000-0000-000000000001';
  clovek uuid := 'a4848484-0000-0000-0000-000000000002';
  subs   integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  perform public.admin_set_premium(clovek, 365);
  reset role;

  select count(*) into subs from public.premium_subscriptions where user_id = clovek;
  assert subs = 0, 'grant nie je predplatné a nevyrobí ho';
  assert public.is_premium(clovek), 'hoci Premium naozaj má';

  raise notice 'PASS grant sa nikdy netvári ako zaplatené predplatné';
end $$;

-- --- a adminovi sa prideľovať nedá -------------------------------------------
do $$
declare failed text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a4848484-0000-0000-0000-000000000001', true);
  begin
    perform public.admin_set_premium('a4848484-0000-0000-0000-000000000001', 30);
  exception when others then failed := sqlerrm;
  end;
  reset role;

  assert failed like '%TARGET_IS_ADMIN%',
    'povie prečo, namiesto tlačidla, ktoré nič nerobí';
  raise notice 'PASS adminovi sa Premium neprideľuje — má ho z roly';
end $$;

-- --- admin si Premium vie vypnúť, aby videl appku ako bežný človek ------------
-- Vypnuté musí platiť aj na SERVERI. Keby si to appka myslela len sama pre
-- seba, zamknuté tlačidlo by po stlačení fungovalo a netestovalo by sa nič.
do $$
declare
  admin  uuid := 'a4848484-0000-0000-0000-000000000001';
  status jsonb;
  failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  assert public.is_premium(admin), 'admin Premium má';

  status := public.set_premium_preview(true);
  assert not (status ->> 'is_premium')::boolean, 'a vie si ho vypnúť';

  reset role;
  assert not public.is_premium(admin),
    'vypnuté platí aj mimo appky — inak by server púšťal to, čo obrazovka zamkla';

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  status := public.my_premium_status();
  assert (status ->> 'preview_off')::boolean,
    'a obrazovka vie rozoznať „nemáš" od „vypol si si to"';
  assert status ->> 'source' = 'none', 'navonok je to obyčajný účet';

  -- A späť.
  perform public.set_premium_preview(false);
  reset role;
  assert public.is_premium(admin), 'zapnúť sa to dá rovnako ľahko';

  -- Bežný účet si nemá čo prepínať.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a4848484-0000-0000-0000-000000000002', true);
  begin
    perform public.set_premium_preview(true);
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'prepínač je adminská vec';

  raise notice 'PASS admin si Premium vie vypnúť a systém ho naozaj berie ako bežný účet';
end $$;

-- --- a nedá sa to obísť zápisom do vlastného profilu ---------------------------
do $$
declare clovek uuid := 'a4848484-0000-0000-0000-000000000002';
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', clovek::text, true);
  update public.profiles set premium_preview_off = true where id = clovek;
  reset role;

  assert not (select premium_preview_off from public.profiles where id = clovek),
    'o Premium na profile rozhodujú funkcie, nie priamy zápis — aj pri tomto stĺpci';
  raise notice 'PASS prepínač sa nedá prepnúť mimo funkcie';
end $$;

rollback;
