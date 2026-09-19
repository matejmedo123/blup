-- ============================================================================
-- Premium sa dá prideliť z adminu — a je vidieť, kto ho má a prečo
--
-- Dve veci, ktoré spolu súvisia viac, než vyzerajú.
--
-- 1. `my_premium_status()` čítala IBA `premium_subscriptions`. Admin žiadne
--    predplatné nemá — má grant (migrácia 0071) — takže obrazovka Premium mu
--    tvrdila, že Premium NEMÁ, zatiaľ čo `is_premium()` hovorilo opak a funkcie
--    mu fungovali. Dve odpovede na tú istú otázku, obe „pravdivé".
--
-- 2. Prideliť Premium človeku sa nedalo vôbec. Pritom to treba na úplne bežné
--    veci: kompenzácia za pokazený event, skúšobné mesiace, partner.
--
-- Fingovaný riadok v `premium_subscriptions` by to vyriešil na jeden riadok
-- kódu a bola by to lož: účtovníctvo by ho videlo ako tržbu, ktorá neexistuje.
-- Preto grant zostáva grantom — `premium_until` na profile — a predplatné
-- zostáva záznamom o tom, kto naozaj platí.
-- ============================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 0. Najprv dieru zavrieť
-- ---------------------------------------------------------------------------
-- `premium_until` je stĺpec na `profiles` a `protect_profile_privileges()` ho
-- doteraz nestrážil — používateľ si smie upraviť vlastný profil, takže si doň
-- vedel zapísať čokoľvek. Zatiaľ to znamenalo len odznak navyše, lebo
-- `is_premium()` ten stĺpec vôbec nečítalo.
--
-- O dva odseky nižšie ho čítať začne. Bez tohto kroku by si v tej chvíli
-- ktokoľvek zapol Premium jedným UPDATE-om.
create or replace function public.protect_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is not null and not public.is_full_admin() then
    new.app_role := old.app_role;
    new.is_suspended := old.is_suspended;
    new.suspended_reason := old.suspended_reason;
    -- Premium sa nedáva zápisom do vlastného profilu. Mení ho buď trigger od
    -- predplatného, alebo admin cez admin_set_premium(); obe si pred zápisom
    -- zapnú príznak nižšie, takže ich to neblokuje.
    --
    -- Príznak, a nie „security definer stačí": sync_premium_badge() je trigger,
    -- ktorý beží v rovnakej transakcii ako zápis, čo ho vyvolal, takže
    -- `auth.uid()` je stále nastavené na bežného používateľa. Bez tohto by
    -- vypršané predplatné neodstránilo odznak — presne to zachytil test 35.
    if coalesce(current_setting('blup.premium_write', true), 'off') <> 'on' then
      new.premium_until := old.premium_until;
    end if;
  end if;
  return new;
end;
$$;

/**
 * Ten istý trigger ako v 0061, len si pred zápisom zapne príznak.
 *
 * Musí, lebo odteraz `premium_until` rozhoduje o funkciách, nielen o odznaku —
 * a keď predplatné vyprší, tento zápis ho MUSÍ prejsť.
 */
create or replace function public.sync_premium_badge()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target uuid := coalesce(new.user_id, old.user_id);
begin
  perform set_config('blup.premium_write', 'on', true);

  update public.profiles p
  set premium_until = (
    select max(s.expires_at)
    from public.premium_subscriptions s
    where s.user_id = target
      and s.status in ('active', 'trialing', 'grace_period')
      and (s.expires_at is null or s.expires_at > now())
  )
  where p.id = target;

  perform set_config('blup.premium_write', 'off', true);
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Jedna odpoveď na otázku „má tento človek Premium"
-- ---------------------------------------------------------------------------
create or replace function public.is_premium(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    -- Plný admin, aby sa funkcie dali vôbec vyskúšať. Nie moderátor:
    -- moderovanie obsahu je iná práca než prevádzkovanie miesta.
    exists (select 1 from public.profiles p where p.id = uid and p.app_role = 'admin')
    -- Skutočné predplatné.
    or exists (
      select 1
      from public.premium_subscriptions s
      where s.user_id = uid
        and s.status in ('active', 'trialing', 'grace_period')
        and (s.expires_at is null or s.expires_at > now())
    )
    -- Alebo pridelené adminom. Ten istý stĺpec, z ktorého sa kreslí odznak,
    -- takže odznak a funkcie už nemôžu tvrdiť každý niečo iné. Keď predplatné
    -- vyprší, sync_premium_badge() sem zapíše minulosť a podmienka prestane
    -- platiť sama.
    or exists (
      select 1 from public.profiles p
      where p.id = uid and p.premium_until is not null and p.premium_until > now()
    );
$$;

-- ---------------------------------------------------------------------------
-- 2. A nech to povie aj nahlas
-- ---------------------------------------------------------------------------
/**
 * Čo appka zobrazí na obrazovke Premium.
 *
 * Pribudol `source`, lebo „máš Premium" je pravda z troch rôznych dôvodov a
 * každý znamená niečo iné: predplatné sa dá zrušiť, grant vyprší, adminovi
 * platí, kým je adminom. Bez toho obrazovka ponúkala „Zrušiť predplatné"
 * niekomu, kto žiadne nemá.
 */
create or replace function public.my_premium_status()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    -- Skutočné predplatné má prednosť: je jediné, ktoré sa dá spravovať.
    (
      select jsonb_build_object(
        'is_premium', true,
        'source', 'subscription',
        'platform', s.platform,
        'product_id', s.product_id,
        'status', s.status,
        'expires_at', s.expires_at,
        'auto_renew', s.auto_renew
      )
      from public.premium_subscriptions s
      where s.user_id = auth.uid()
        and s.status in ('active', 'trialing', 'grace_period')
        and (s.expires_at is null or s.expires_at > now())
      order by s.expires_at desc nulls first
      limit 1
    ),
    (
      select case
        when p.app_role = 'admin' then jsonb_build_object(
          'is_premium', true,
          'source', 'admin',
          'status', 'admin',
          'expires_at', null,
          'auto_renew', false
        )
        when p.premium_until is not null and p.premium_until > now() then jsonb_build_object(
          'is_premium', true,
          'source', 'granted',
          'status', 'granted',
          'expires_at', p.premium_until,
          'auto_renew', false
        )
        else null
      end
      from public.profiles p
      where p.id = auth.uid()
    ),
    jsonb_build_object('is_premium', false, 'source', 'none', 'status', 'none')
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Prideliť a odobrať
-- ---------------------------------------------------------------------------
/**
 * Dá človeku Premium na p_days dní, predĺži ho, alebo ho odoberie (p_days = 0).
 *
 * Nikdy nezapíše riadok do `premium_subscriptions`. Fingované predplatné by sa
 * v účtovníctve objavilo ako tržba, ktorá neprišla — a čísla, ktorým sa nedá
 * veriť, sú horšie než žiadne.
 *
 * Adminovi sa prideľovať nedá a netreba: Premium má z roly a odobratím dní by
 * oň aj tak neprišiel. Radšej to povie, než aby tlačidlo nerobilo nič.
 */
create or replace function public.admin_set_premium(
  p_user_id uuid,
  p_days    integer,
  p_reason  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_profile public.profiles%rowtype;
  v_until   timestamptz;
begin
  if not public.is_full_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'NOT_FOUND';
  end if;
  if p_days is null or p_days < 0 or p_days > 3650 then
    raise exception 'INVALID_PERIOD'
      using hint = 'Premium sa dá prideliť na 0 až 3650 dní.';
  end if;

  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  if v_profile.app_role = 'admin' then
    raise exception 'TARGET_IS_ADMIN'
      using hint = 'Admin má Premium z roly — prideľovať mu ho netreba.';
  end if;

  if p_days = 0 then
    -- Odobratie vráti človeka k tomu, čo si naozaj platí. Ak platí, nepríde
    -- o nič; to je celý rozdiel medzi grantom a predplatným.
    v_until := (
      select max(s.expires_at)
      from public.premium_subscriptions s
      where s.user_id = p_user_id
        and s.status in ('active', 'trialing', 'grace_period')
    );
  else
    -- Predĺženie sa počíta od toho, čo mu ešte zostáva, nie od dneška —
    -- inak by pridanie mesiaca človeku s dvoma mesiacmi jeden zobralo.
    v_until := greatest(coalesce(v_profile.premium_until, now()), now())
             + make_interval(days => p_days);
  end if;

  perform set_config('blup.premium_write', 'on', true);
  update public.profiles set premium_until = v_until where id = p_user_id;
  perform set_config('blup.premium_write', 'off', true);

  perform public.log_admin_action(
    case when p_days = 0 then 'premium_revoked' else 'premium_granted' end,
    'profile',
    p_user_id,
    jsonb_build_object('days', p_days, 'until', v_until, 'reason', p_reason)
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'premium_until', v_until,
    'is_premium', v_until is not null and v_until > now()
  );
end;
$$;

revoke execute on function public.admin_set_premium(uuid, integer, text) from public, anon;
grant execute on function public.admin_set_premium(uuid, integer, text) to authenticated;
