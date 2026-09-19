-- ============================================================================
-- Admin si vie Premium vypnúť, aby videl appku ako bežný človek
--
-- „admin je automaticky premium pouzivatel?? alebo prepinanie pre admina aspon
-- nech to mozeme testovat."
--
-- Áno, je — od migrácie 0071, a bol to dobrý nápad z presne opačného dôvodu,
-- než sa teraz ukazuje. Bez toho sa Premium funkcie nedali vyskúšať vôbec.
-- S tým sa zase nedá vyskúšať to, čo vidí väčšina ľudí: zamknuté stavy,
-- ponuky na predplatenie, obrazovky, ktoré hovoria „toto má Premium".
-- Admin ich neuvidí nikdy, a tie sú pritom to, čo rozhoduje, či si niekto
-- Premium kúpi.
--
-- Prepínač je ZÁMERNE serverový, nie v appke.
--
-- Keby si appka len sama pre seba myslela, že Premium nemá, server by ju ďalej
-- púšťal všade — zamknuté tlačidlo by po stlačení fungovalo. To nie je test
-- ničoho. Takto sa celý systém správa k adminovi ako k človeku bez Premia, a
-- to, čo vidí, je naozaj to, čo uvidí on.
-- ============================================================================
set search_path = public, extensions;

alter table public.profiles
  add column if not exists premium_preview_off boolean not null default false;

comment on column public.profiles.premium_preview_off is
  'Admin si dočasne vypol Premium, aby videl appku ako bežný používateľ.';

-- ---------------------------------------------------------------------------
-- Aj tento stĺpec musí strážiť trigger
-- ---------------------------------------------------------------------------
-- Sám o sebe nie je nebezpečný — vypnúť si Premium nikomu nič nedá. Ale
-- `premium_until` vedľa neho nebezpečný je, a jediný spôsob, ako sa v tom
-- nepomýliť, je držať pravidlo rovnaké pre oba: o Premium na profile
-- rozhodujú funkcie, nie priamy zápis.
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
    if coalesce(current_setting('blup.premium_write', true), 'off') <> 'on' then
      new.premium_until := old.premium_until;
    end if;
    -- Nie je to admin, takže nemá čo prepínať.
    new.premium_preview_off := old.premium_preview_off;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- A jedna odpoveď, ktorá to rešpektuje
-- ---------------------------------------------------------------------------
create or replace function public.is_premium(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select case
    -- Vypnuté na skúšanie znamená vypnuté pre celý systém, vrátane servera.
    -- Inak by sa testovala appka, ktorá klame sama sebe.
    when exists (select 1 from public.profiles p
                 where p.id = uid and p.premium_preview_off)
      then false
    else
      exists (select 1 from public.profiles p where p.id = uid and p.app_role = 'admin')
      or exists (
        select 1
        from public.premium_subscriptions s
        where s.user_id = uid
          and s.status in ('active', 'trialing', 'grace_period')
          and (s.expires_at is null or s.expires_at > now())
      )
      or exists (
        select 1 from public.profiles p
        where p.id = uid and p.premium_until is not null and p.premium_until > now()
      )
  end;
$$;

/**
 * Zapne alebo vypne si Premium na skúšanie.
 *
 * Len plný admin, a len sebe. Nie je to nástroj na odoberanie Premia iným —
 * na to je `admin_set_premium()`, ktoré sa zapisuje do auditu a týka sa toho,
 * čo si človek zaplatil.
 */
create or replace function public.set_premium_preview(p_off boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_me uuid := auth.uid();
begin
  if not public.is_full_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.profiles
  set premium_preview_off = coalesce(p_off, false)
  where id = v_me;

  return jsonb_build_object(
    'preview_off', coalesce(p_off, false),
    'is_premium', public.is_premium(v_me)
  );
end;
$$;

revoke execute on function public.set_premium_preview(boolean) from public, anon;
grant execute on function public.set_premium_preview(boolean) to authenticated;

/**
 * Stav Premia — teraz aj s tým, že si ho admin vypol.
 *
 * `preview_off` je tu preto, aby obrazovka vedela povedať rozdiel medzi
 * „Premium nemáš" a „Premium máš, ale práve sa tváriš, že nie". Bez toho by
 * admin videl presne to, čo chcel vidieť, a nevedel by, ako sa z toho dostať
 * späť.
 */
create or replace function public.my_premium_status()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'is_premium', false,
        'source', 'none',
        'status', 'preview',
        'preview_off', true
      )
      from public.profiles p
      where p.id = auth.uid() and p.premium_preview_off
    ),
    (
      select jsonb_build_object(
        'is_premium', true,
        'source', 'subscription',
        'platform', s.platform,
        'product_id', s.product_id,
        'status', s.status,
        'expires_at', s.expires_at,
        'auto_renew', s.auto_renew,
        'preview_off', false
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
          'is_premium', true, 'source', 'admin', 'status', 'admin',
          'expires_at', null, 'auto_renew', false, 'preview_off', false
        )
        when p.premium_until is not null and p.premium_until > now() then jsonb_build_object(
          'is_premium', true, 'source', 'granted', 'status', 'granted',
          'expires_at', p.premium_until, 'auto_renew', false, 'preview_off', false
        )
        else null
      end
      from public.profiles p
      where p.id = auth.uid()
    ),
    jsonb_build_object('is_premium', false, 'source', 'none', 'status', 'none', 'preview_off', false)
  );
$$;

grant execute on function public.my_premium_status() to authenticated;
