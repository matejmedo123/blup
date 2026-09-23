-- ============================================================================
-- Mazanie chatu, hľadanie ľudí v správach, príbehy na 24 h, nové eventy vo
-- feede, odbavovanie pri dverách a kruhy, ktoré dnes naozaj niekam idú
-- ============================================================================
-- Šesť vecí, ktoré majú jedno spoločné: každá z nich niečo tvrdila a nemala to
-- čím podložiť. Ring nad feedom svietil aj keď nikto nič nepridal; riadok
-- „Tvoje kruhy dnes niekam idú" sa ukázal každému, kto niekoho sleduje; lupa
-- v správach hľadala eventy. Test sa pýta presne na tie tvrdenia.
-- ============================================================================
begin;
set search_path = public, extensions;

-- --- ľudia -------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a5252525-0000-0000-0000-000000000001', 'ana52@example.com',  now(), '{"display_name":"Ana Nováková"}'),
  ('a5252525-0000-0000-0000-000000000002', 'bob52@example.com',  now(), '{"display_name":"Bob Kováč"}'),
  ('a5252525-0000-0000-0000-000000000003', 'cyd52@example.com',  now(), '{"display_name":"Cyd Malá"}');

update public.profiles set username = 'ana52' where id = 'a5252525-0000-0000-0000-000000000001';
update public.profiles set username = 'bob52' where id = 'a5252525-0000-0000-0000-000000000002';
update public.profiles set username = 'cyd52' where id = 'a5252525-0000-0000-0000-000000000003';

-- Ana sleduje Boba. Cyd nesleduje nikoho a nikto ju.
insert into public.follows (follower_id, following_id)
values ('a5252525-0000-0000-0000-000000000001', 'a5252525-0000-0000-0000-000000000002');

-- ============================================================================
-- 1. Zmazať chat znamená zmazať si ho — nie druhej strane
-- ============================================================================
do $$
declare
  v_ana  uuid := 'a5252525-0000-0000-0000-000000000001';
  v_bob  uuid := 'a5252525-0000-0000-0000-000000000002';
  v_conv uuid;
  v_seen integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);

  v_conv := public.start_direct_conversation(v_bob);
  perform public.send_message(v_conv, 'ahoj', null, null);

  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  perform public.send_message(v_conv, 'ahoj aj tebe', null, null);

  -- Ana chat zmaže.
  perform set_config('request.jwt.claim.sub', v_ana::text, true);
  perform public.delete_conversation(v_conv);

  select count(*) into v_seen from public.my_conversations(50) where id = v_conv;
  assert v_seen = 0, 'zmazaný chat zostal v prehľade';

  select count(*) into v_seen from public.messages where conversation_id = v_conv;
  assert v_seen = 0, 'zmazaný chat ešte ukazuje staré správy';

  -- Bobovi sa nestalo nič.
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  select count(*) into v_seen from public.messages where conversation_id = v_conv;
  assert v_seen = 2, format('Bob mal vidieť obe správy, vidí %s', v_seen);

  -- Bob napíše znova — chat sa Ane vráti, ale bez histórie.
  perform public.send_message(v_conv, 'si tam?', null, null);

  perform set_config('request.jwt.claim.sub', v_ana::text, true);
  select count(*) into v_seen from public.my_conversations(50) where id = v_conv;
  assert v_seen = 1, 'po novej správe sa chat nevrátil';

  select count(*) into v_seen from public.messages where conversation_id = v_conv;
  assert v_seen = 1, format('vrátiť sa mala len nová správa, vrátilo sa %s', v_seen);

  reset role;
  raise notice 'PASS zmazanie chatu zmaže len moju kópiu a nezablokuje druhú stranu';
end $$;

-- ============================================================================
-- 2. Lupa v správach hľadá ľudí, nie eventy
-- ============================================================================
do $$
declare
  v_ana uuid := 'a5252525-0000-0000-0000-000000000001';
  v_bob uuid := 'a5252525-0000-0000-0000-000000000002';
  v_hits integer;
  v_person uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);

  -- Boba Ana sleduje a má s ním chat — musí ho nájsť podľa mena aj prezývky.
  select count(*) into v_hits from public.search_my_chats('Kováč', 30);
  assert v_hits >= 1, 'hľadanie podľa mena nenašlo človeka z mojich chatov';

  select count(*) into v_hits from public.search_my_chats('bob52', 30);
  assert v_hits >= 1, 'hľadanie podľa prezývky nenašlo nič';

  -- Cyd Ana nesleduje a nikdy jej nepísala: v jej správach nemá čo hľadať.
  select count(*) into v_hits from public.search_my_chats('Cyd', 30);
  assert v_hits = 0, 'hľadanie v správach ponúklo cudzieho človeka';

  -- A vôbec nič, čo by sa volalo ako event.
  select count(*) into v_hits from public.search_my_chats('zzz-nic-take', 30);
  assert v_hits = 0, 'hľadanie vrátilo niečo, čo sa nezhoduje';

  select user_id into v_person from public.search_my_chats('bob52', 30) limit 1;
  assert v_person = v_bob, 'našiel sa nesprávny človek';

  reset role;
  raise notice 'PASS hľadanie v správach nájde človeka a cudzích neponúka';
end $$;

-- ============================================================================
-- 3. Príbeh žije 24 hodín — a potom nie
-- ============================================================================
do $$
declare
  v_ana   uuid := 'a5252525-0000-0000-0000-000000000001';
  v_bob   uuid := 'a5252525-0000-0000-0000-000000000002';
  v_cyd   uuid := 'a5252525-0000-0000-0000-000000000003';
  v_story uuid;
  v_rings integer;
  v_unseen integer;
  v_views integer;
  v_failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);

  v_story := public.create_story(
    'https://tchvgzbxddqdneylkqvi.supabase.co/storage/v1/object/public/stories/b/1.jpg',
    'v klube', null, null
  );

  -- Ana Boba sleduje: ring vidí, a je farebný, lebo ho ešte nevidela.
  perform set_config('request.jwt.claim.sub', v_ana::text, true);
  select count(*), coalesce(max(unseen_count), 0)
    into v_rings, v_unseen
  from public.story_rings(30) where author_id = v_bob;

  assert v_rings = 1, 'príbeh sledovaného sa neukázal';
  assert v_unseen = 1, 'nevidený príbeh sa tvári ako videný';

  perform public.mark_story_seen(v_story);
  select coalesce(max(unseen_count), 0) into v_unseen
  from public.story_rings(30) where author_id = v_bob;
  assert v_unseen = 0, 'po pozretí ring stále svieti';

  -- Cyd Boba nesleduje: nevidí nič.
  perform set_config('request.jwt.claim.sub', v_cyd::text, true);
  select count(*) into v_rings from public.story_rings(30) where author_id = v_bob;
  assert v_rings = 0, 'príbeh videl aj niekto, kto autora nesleduje';

  select count(*) into v_rings from public.stories_of(v_bob);
  assert v_rings = 0, 'cudzí príbeh sa dal otvoriť priamo';

  -- Počítadlo videní je Bobova vec, nie verejná.
  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  select view_count into v_views from public.stories_of(v_bob) limit 1;
  assert v_views = 1, format('autor mal vidieť 1 videnie, vidí %s', v_views);

  perform set_config('request.jwt.claim.sub', v_ana::text, true);
  select view_count into v_views from public.stories_of(v_bob) limit 1;
  assert v_views = 0, 'počet videní sa ukázal niekomu inému než autorovi';

  -- Kto videl môj príbeh: smie sa pýtať len autor.
  select count(*) into v_rings from public.story_viewers(v_story, 100);
  assert v_rings = 0, 'zoznam divákov videl aj niekto iný než autor';

  perform set_config('request.jwt.claim.sub', v_bob::text, true);
  select count(*) into v_rings from public.story_viewers(v_story, 100);
  assert v_rings = 1, 'autor nevidí, kto mu príbeh pozrel';

  -- Odkaz na obrázok musí smerovať do nášho úložiska.
  begin
    perform public.create_story('https://zle.example.com/hack.jpg', null, null, null);
    v_failed := false;
  exception when others then
    v_failed := true;
  end;
  assert v_failed, 'príbeh prijal obrázok odkiaľkoľvek';

  reset role;
  raise notice 'PASS príbeh vidí len sledujúci, počet videní len autor a obrázok musí byť náš';
end $$;

-- --- a po 24 hodinách zmizne -------------------------------------------------
do $$
declare
  v_ana   uuid := 'a5252525-0000-0000-0000-000000000001';
  v_bob   uuid := 'a5252525-0000-0000-0000-000000000002';
  v_rings integer;
  v_gone  integer;
begin
  -- Posunieme príbeh o deň dozadu. Toto je jediné miesto, kde test siaha na
  -- riadok priamo: expirácia sa inak nedá odmerať bez čakania.
  update public.stories
    set created_at = now() - interval '27 hours',
        -- Viac než hodinu po expirácii: upratovanie schválne necháva čerstvo
        -- vypršané riadky chvíľu ležať, aby sa nemazalo niekomu pod rukami.
        expires_at = now() - interval '3 hours'
    where author_id = v_bob;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);

  select count(*) into v_rings from public.story_rings(30) where author_id = v_bob;
  assert v_rings = 0, 'vypršaný príbeh sa stále ukazuje';

  select count(*) into v_rings from public.stories_of(v_bob);
  assert v_rings = 0, 'vypršaný príbeh sa dal otvoriť';

  reset role;

  -- A upratovanie ho naozaj zmaže, nielen skryje.
  select public.purge_expired_stories() into v_gone;
  assert v_gone >= 1, 'upratovanie vypršaný príbeh nezmazalo';
  assert not exists (select 1 from public.stories where author_id = v_bob),
    'riadok vypršaného príbehu zostal v tabuľke';

  raise notice 'PASS príbeh po 24 hodinách zmizne aj z pohľadu aj z tabuľky';
end $$;

-- ============================================================================
-- 4. Nový event sledovaného sa objaví vo feede
-- ============================================================================
do $$
declare
  v_ana   uuid := 'a5252525-0000-0000-0000-000000000001';
  v_bob   uuid := 'a5252525-0000-0000-0000-000000000002';
  v_cyd   uuid := 'a5252525-0000-0000-0000-000000000003';
  v_event uuid;
  v_hits  integer;
begin
  insert into public.events (
    creator_id, title, description, category, latitude, longitude,
    start_at, end_at, is_free, status, visibility, city
  ) values (
    v_bob, 'Bobov koncert', 'Prvý ročník', 'music', 48.15, 17.11,
    now() + interval '3 days', now() + interval '3 days 4 hours',
    true, 'published', 'public', 'Bratislava'
  ) returning id into v_event;

  set local role authenticated;

  -- Ana Boba sleduje.
  perform set_config('request.jwt.claim.sub', v_ana::text, true);
  select count(*) into v_hits
  from public.feed_new_events('following', 20) where id = v_event;
  assert v_hits = 1, 'nový event sledovaného sa vo feede neukázal';

  -- Cyd ho nesleduje: v „Sledujem" ho nemá, vo „Všetko" áno.
  perform set_config('request.jwt.claim.sub', v_cyd::text, true);
  select count(*) into v_hits
  from public.feed_new_events('following', 20) where id = v_event;
  assert v_hits = 0, 'event sa ukázal aj tomu, kto autora nesleduje';

  select count(*) into v_hits
  from public.feed_new_events('all', 20) where id = v_event;
  assert v_hits = 1, 'event chýba aj vo „Všetko"';

  -- Event, ktorý už bol, nie je novinka.
  -- reset role najprv: inak ide UPDATE cez RLS ako Cyd, ktorá event nevlastní,
  -- ticho neurobí nič a test by potom meral nezmenený riadok.
  reset role;
  update public.events
    set start_at = now() - interval '2 days', end_at = now() - interval '2 days' + interval '3 hours'
    where id = v_event;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);
  select count(*) into v_hits
  from public.feed_new_events('following', 20) where id = v_event;
  assert v_hits = 0, 'feed oznamuje event, ktorý už skončil';

  reset role;
  raise notice 'PASS nový event sledovaného je vo feede, skončený už nie';
end $$;

-- ============================================================================
-- 5. Pri dverách: koľko je vnútri a koľko ešte príde
-- ============================================================================
do $$
declare
  v_bob   uuid := 'a5252525-0000-0000-0000-000000000002';
  v_ana   uuid := 'a5252525-0000-0000-0000-000000000001';
  v_event uuid;
  v_door  jsonb;
begin
  -- Predávať sa smie len pod overenou organizáciou, takže Bob jednu má.
  insert into public.organizations (id, name, slug, created_by, verification_status)
  values ('b5252525-0000-0000-0000-000000000001', 'Klub 52', 'klub-52', v_bob, 'verified')
  on conflict do nothing;
  insert into public.organization_members (organization_id, user_id, role)
  values ('b5252525-0000-0000-0000-000000000001', v_bob, 'owner')
  on conflict do nothing;

  insert into public.events (
    creator_id, organization_id, title, category, latitude, longitude,
    start_at, is_free, price_cents, status, visibility
  ) values (
    v_bob, 'b5252525-0000-0000-0000-000000000001', 'Dvere', 'music', 48.15, 17.11,
    now() + interval '1 day', false, 1000, 'published', 'public'
  ) returning id into v_event;

  -- Päť vstupeniek: dve odbavené, dve platné, jedna vrátená.
  insert into public.tickets (event_id, buyer_id, code, qr_secret, status, price_cents)
  values
    (v_event, v_ana, 'D52-1', 's1', 'used',     1000),
    (v_event, v_ana, 'D52-2', 's2', 'used',     1000),
    (v_event, v_ana, 'D52-3', 's3', 'valid',    1000),
    (v_event, v_ana, 'D52-4', 's4', 'valid',    1000),
    (v_event, v_ana, 'D52-5', 's5', 'refunded', 1000);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_bob::text, true);

  v_door := public.event_door_state(v_event);

  assert (v_door ->> 'inside')::integer = 2,
    format('vnútri mali byť 2, je %s', v_door ->> 'inside');
  assert (v_door ->> 'to_admit')::integer = 2,
    format('odbaviť sa malo ešte 2, hlási %s', v_door ->> 'to_admit');
  -- Toto je celý zmysel: vrátená vstupenka sa nesmie rátať medzi tých, na
  -- ktorých organizátor pri dverách ešte čaká.
  assert (v_door ->> 'tickets_live')::integer = 4,
    format('platných vstupeniek mali byť 4, hlási %s', v_door ->> 'tickets_live');
  assert (v_door ->> 'tickets_void')::integer = 1,
    'vrátená vstupenka sa nezapočítala medzi neplatné';
  assert (v_door ->> 'admitted_pct')::numeric = 50.0,
    format('odbavených malo byť 50 %%, hlási %s', v_door ->> 'admitted_pct');

  reset role;
  raise notice 'PASS pri dverách sedí vnútri, čaká sa a vrátená vstupenka sa neráta';
end $$;

-- --- a nikto cudzí sa na to nepozrie ----------------------------------------
do $$
declare
  v_cyd   uuid := 'a5252525-0000-0000-0000-000000000003';
  v_event uuid;
  v_failed boolean := false;
begin
  select id into v_event from public.events where title = 'Dvere' limit 1;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_cyd::text, true);

  begin
    perform public.event_door_state(v_event);
  exception when others then
    v_failed := true;
  end;

  reset role;
  assert v_failed, 'čísla pri dverách videl aj niekto, kto event nerobí';
  raise notice 'PASS čísla pri dverách vidí len organizátor';
end $$;

-- ============================================================================
-- 6. „Tvoje kruhy dnes niekam idú" — len keď naozaj idú
-- ============================================================================
do $$
declare
  v_ana   uuid := 'a5252525-0000-0000-0000-000000000001';
  v_bob   uuid := 'a5252525-0000-0000-0000-000000000002';
  v_today uuid;
  v_later uuid;
  v_hits  integer;
begin
  -- Ana sleduje Boba a Bob dnes nikam nejde.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);

  select count(*) into v_hits from public.circles_out_today(12);
  assert v_hits = 0,
    format('kruhy hlásia %s ľudí, hoci dnes nikto nikam nejde', v_hits);
  reset role;

  -- Event o týždeň: stále nie dnes.
  insert into public.events (
    creator_id, title, category, latitude, longitude, start_at, end_at,
    is_free, status, visibility
  ) values (
    v_ana, 'O týždeň', 'music', 48.15, 17.11,
    now() + interval '7 days', now() + interval '7 days 3 hours',
    true, 'published', 'public'
  ) returning id into v_later;

  insert into public.event_attendees (event_id, user_id, status)
  values (v_later, v_bob, 'going');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);
  select count(*) into v_hits from public.circles_out_today(12);
  assert v_hits = 0, 'event o týždeň sa ráta ako dnešný';
  reset role;

  -- A teraz event, ktorý je naozaj dnes.
  insert into public.events (
    creator_id, title, category, latitude, longitude, start_at, end_at,
    is_free, status, visibility
  ) values (
    v_ana, 'Dnes večer', 'music', 48.15, 17.11,
    date_trunc('day', now()) + interval '20 hours',
    date_trunc('day', now()) + interval '23 hours',
    true, 'published', 'public'
  ) returning id into v_today;

  insert into public.event_attendees (event_id, user_id, status)
  values (v_today, v_bob, 'going');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', v_ana::text, true);

  select count(*) into v_hits from public.circles_out_today(12);
  assert v_hits = 1, format('dnešný event sa v kruhoch neukázal (%s)', v_hits);

  assert (select event_title from public.circles_out_today(12) limit 1) = 'Dnes večer',
    'kruhy ukazujú iný event než ten dnešný';

  reset role;
  raise notice 'PASS kruhy hlásia len ľudí, ktorí dnes naozaj niekam idú';
end $$;

rollback;
