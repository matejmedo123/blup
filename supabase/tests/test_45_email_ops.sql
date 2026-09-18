-- ============================================================================
-- BLUP test 45 · Vidieť, či e-maily naozaj chodia
-- ============================================================================
-- Testovací e-mail má zmysel len vtedy, keď ide tou istou cestou ako ostrá
-- pošta. Preto sa tu overuje, že sa zaradí do FRONTY — nie že sa „odoslal".
-- ============================================================================
\set ON_ERROR_STOP on

begin;

set local search_path = public, extensions;

insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('a4545454-0000-0000-0000-000000000001', 'admin45@example.com', now(), '{"display_name":"Admin"}'),
  ('a4545454-0000-0000-0000-000000000002', 'user45@example.com',  now(), '{"display_name":"Človek"}');

update public.profiles set app_role = 'admin' where id = 'a4545454-0000-0000-0000-000000000001';

-- --- testovací e-mail ide do fronty, nie mimo nej -----------------------------
do $$
declare
  admin uuid := 'a4545454-0000-0000-0000-000000000001';
  v_id  uuid;
  row   public.email_deliveries%rowtype;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  v_id := public.send_test_email();

  reset role;
  select * into row from public.email_deliveries where id = v_id;

  assert row.kind = 'test', 'je to testovací e-mail';
  assert row.status = 'pending',
    'a čaká vo fronte — keby sa poslal mimo nej, test by prešiel aj s pokazeným workerom';
  assert row.to_email = 'admin45@example.com',
    'chodí na adresu, ktorou je admin prihlásený, nie na ľubovoľnú';
  assert row.payload ->> 'body' is not null, 'a má čo napísať';

  raise notice 'PASS testovací e-mail ide tou istou cestou ako ostrá pošta';
end $$;

-- --- a nie je to nástroj pre kohokoľvek --------------------------------------
do $$
declare failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub',
                     'a4545454-0000-0000-0000-000000000002', true);
  begin
    perform public.send_test_email();
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'bežný účet si testovacie e-maily neposiela';
  raise notice 'PASS testovací e-mail je adminská vec';
end $$;

-- --- desať za hodinu, potom dosť ---------------------------------------------
do $$
declare
  admin  uuid := 'a4545454-0000-0000-0000-000000000001';
  failed boolean := false;
  i      integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  -- Jeden už je z prvého bloku.
  for i in 1..9 loop
    perform public.send_test_email();
  end loop;

  begin
    perform public.send_test_email();
  exception when others then failed := true;
  end;

  reset role;
  assert failed, 'jedenásty test za hodinu sa neposiela';
  raise notice 'PASS ani testovacie e-maily nejdú bez stropu';
end $$;

-- --- a zdravie doručovania vidí admin ----------------------------------------
do $$
declare
  admin  uuid := 'a4545454-0000-0000-0000-000000000001';
  health jsonb;
  failed boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);

  health := public.email_health();
  assert health ? 'failure_rate_pct', 'podiel zlyhaní je to číslo, o ktoré ide';
  assert (health ->> 'failure_rate_pct')::numeric = 0,
    'zatiaľ nič nezlyhalo';
  assert jsonb_array_length(health -> 'days') >= 1, 'a je vidieť aj priebeh po dňoch';

  -- Jeden mŕtvy e-mail a podiel zlyhaní sa pohne.
  reset role;
  update public.email_deliveries
  set status = 'failed', last_error = 'EMAIL_SEND_FAILED: 550 mailbox unavailable'
  where kind = 'test'
    and id = (select id from public.email_deliveries where kind = 'test' limit 1);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', admin::text, true);
  health := public.email_health();
  assert (health ->> 'failed_7d')::int = 1, 'zlyhanie je započítané';
  assert jsonb_array_length(health -> 'errors') = 1,
    'a je vidieť dôvod, nie len počet';

  perform set_config('request.jwt.claim.sub',
                     'a4545454-0000-0000-0000-000000000002', true);
  begin
    perform public.email_health();
  exception when others then failed := true;
  end;
  reset role;
  assert failed, 'prevádzkové čísla nie sú verejné';

  raise notice 'PASS zlyhania e-mailov je vidieť skôr, než prestane chodiť všetko';
end $$;

-- --- tvrdý odraz zastaví ďalšie pokusy na tú adresu ---------------------------
-- Toto je dôvod, prečo webhook vôbec existuje: adresa, na ktorú sa stále píše,
-- kazí reputáciu domény a napokon zhorší doručovanie všetkým ostatným.
do $$
declare
  dropped integer;
begin
  insert into public.email_deliveries (kind, to_email, subject, status)
  values ('digest', 'mrtva@example.com', 'Týždenný prehľad', 'pending');

  dropped := public.mark_email_undeliverable('mrtva@example.com', false);

  assert (select status from public.email_deliveries
          where to_email = 'mrtva@example.com') = 'skipped',
    'čakajúca pošta na mŕtvu adresu sa zahodí';
  assert not public.can_email('mrtva@example.com', 'digest'),
    'a nič nové sa na ňu už neposiela';
  assert (select bounced_at is not null from public.email_contacts
          where email = 'mrtva@example.com'),
    'adresa je označená ako odrazená';

  raise notice 'PASS odraz z webhooku naozaj zastaví ďalšiu poštu na tú adresu';
end $$;

rollback;
