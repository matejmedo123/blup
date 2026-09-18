-- ============================================================================
-- Aby bolo vidieť, či e-maily naozaj chodia
--
-- "nech nechodia emaily do spamu keby nahodou, nech tie emaily vobec aj
-- pridu" — a doteraz sa to nedalo zistiť. E-mail, ktorý sa odošle a skončí v
-- spame, vyzerá v `email_deliveries` úplne rovnako ako e-mail, ktorý dorazil:
-- status 'sent'. `email_queue_stats()` existuje od mailing migrácie a nevolala
-- ho ani jedna obrazovka.
--
-- Tri veci tu pribúdajú:
--   1. testovací e-mail, ktorý prejde CELOU skutočnou cestou (fronta → worker →
--      Resend), nie skratkou — inak by test testoval niečo iné než prevádzku,
--   2. `email_health()`: koľko sa za posledný týždeň odoslalo, koľko zlyhalo a
--      na čom, plus tvrdé odrazy a sťažnosti,
--   3. `kind = 'test'`, aby ten e-mail mal kde bývať.
-- ============================================================================
set search_path = public, extensions;

alter table public.email_deliveries drop constraint if exists email_deliveries_kind_check;
alter table public.email_deliveries add constraint email_deliveries_kind_check
  check (kind in ('ticket', 'order_refunded', 'waitlist_open', 'invite',
                  'announcement', 'digest', 'test'));

-- ---------------------------------------------------------------------------
-- Testovací e-mail
-- ---------------------------------------------------------------------------
/**
 * Pošle testovací e-mail cez úplne rovnakú cestu ako každý iný.
 *
 * Zámerne NEobchádza frontu. Keby test volal Resend priamo, prešiel by aj vtedy,
 * keď je pokazený worker, cron alebo rozpočet na hodinu — teda presne vtedy,
 * keď potrebujeme vedieť, že niečo nefunguje.
 *
 * Adresa je vždy tá, ktorou je admin prihlásený. Ľubovoľná adresa by z tohto
 * spravila nástroj na overovanie, či daná schránka existuje.
 */
create or replace function public.send_test_email()
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me    uuid := auth.uid();
  v_email text;
  v_recent integer;
  v_id    uuid;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select email into v_email from auth.users where id = v_me;
  if v_email is null or position('@' in v_email) < 2 then
    raise exception 'NO_EMAIL_ON_ACCOUNT';
  end if;

  select count(*) into v_recent
  from public.email_deliveries
  where kind = 'test' and created_at > now() - interval '1 hour';

  if v_recent >= 10 then
    raise exception 'RATE_LIMITED'
      using hint = 'Testovacích e-mailov je dosť — počkaj hodinu.';
  end if;

  perform public.ensure_email_contact(v_email, v_me);

  insert into public.email_deliveries (kind, user_id, to_email, subject, payload)
  values (
    'test', v_me, v_email, 'BLUP — testovací e-mail',
    jsonb_build_object(
      'organizer', 'BLUP',
      'body', 'Toto je testovací e-mail z BLUPu. Ak ho čítaš, fronta, worker aj '
              || 'poskytovateľ fungujú. Ak si ho našiel v spame, chyba nie je v '
              || 'texte — pozri DNS záznamy domény (npm run check:dns).'
    )
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.send_test_email() from public, anon;
grant execute on function public.send_test_email() to authenticated;

-- ---------------------------------------------------------------------------
-- Ako sa darí doručovaniu
-- ---------------------------------------------------------------------------
/**
 * Týždeň odosielania, po dňoch, plus dôvody zlyhaní.
 *
 * `email_queue_stats()` hovorí, čo sa deje TERAZ. Toto hovorí, či sa to zhoršuje
 * — čo je jediný spôsob, ako si všimnúť problém s reputáciou domény skôr, než
 * prestane chodiť všetko.
 */
create or replace function public.email_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_days       jsonb;
  v_errors     jsonb;
  v_sent       integer;
  v_failed     integer;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select
    coalesce(jsonb_agg(d order by d.day), '[]'::jsonb)
  into v_days
  from (
    select
      date_trunc('day', created_at)::date as day,
      count(*) filter (where status = 'sent')    as sent,
      count(*) filter (where status = 'failed')  as failed,
      count(*) filter (where status = 'skipped') as skipped,
      count(*) filter (where status = 'pending') as pending
    from public.email_deliveries
    where created_at > now() - interval '7 days'
    group by 1
  ) d;

  -- Nie zoznam chýb, ale dôvody zoradené podľa toho, koľkých ľudí sa týkajú.
  select coalesce(jsonb_agg(e order by e.n desc), '[]'::jsonb)
  into v_errors
  from (
    select left(coalesce(last_error, 'neznáma chyba'), 120) as reason, count(*) as n
    from public.email_deliveries
    where status = 'failed' and created_at > now() - interval '7 days'
    group by 1
    order by 2 desc
    limit 5
  ) e;

  select
    count(*) filter (where status = 'sent'),
    count(*) filter (where status = 'failed')
  into v_sent, v_failed
  from public.email_deliveries
  where created_at > now() - interval '7 days';

  return jsonb_build_object(
    'days', v_days,
    'errors', v_errors,
    'sent_7d', coalesce(v_sent, 0),
    'failed_7d', coalesce(v_failed, 0),
    -- Toto je to číslo. Nad pár percent nejde o jednu adresu, ale o doménu.
    'failure_rate_pct', case
      when coalesce(v_sent, 0) + coalesce(v_failed, 0) = 0 then 0
      else round((coalesce(v_failed, 0)::numeric * 100)
                 / (coalesce(v_sent, 0) + coalesce(v_failed, 0)), 1)
    end,
    'bounced', (select count(*) from public.email_contacts where bounced_at is not null),
    'complained', (select count(*) from public.email_contacts where complained_at is not null),
    'last_sent_at', (select max(sent_at) from public.email_deliveries)
  );
end;
$$;

revoke execute on function public.email_health() from public, anon;
grant execute on function public.email_health() to authenticated;
