-- ============================================================================
-- SWAP: pohľad swap_live_listings pod právami toho, kto sa pýta
-- ============================================================================
-- Supabase linter na ňom hlási CRITICAL „Security Definer View". Pohľad bez
-- `security_invoker` beží pod právami svojho vlastníka, takže RLS tabuliek pod
-- ním sa neuplatní — uplatní sa RLS toho, kto pohľad vytvoril.
--
-- Dnes z toho reálne neunikalo nič: telo pohľadu si samo filtruje
-- `status = 'active'` a to je presne to, čo `resale_listings_select` dovolí
-- komukoľvek. Lenže to je náhoda, nie záruka. Stačí raz pridať do pohľadu
-- `reserved` ponuky alebo stĺpec z `profiles` a z neškodného pohľadu je únik,
-- ktorý nikde nevidno — žiadna politika sa neporuší, lebo žiadna neplatí.
-- `organization_balances` to má zapnuté od začiatku (migrácia 001500); tento
-- pohľad vznikol neskôr a vypadol z toho.
--
-- Prepnúť prepínač ale nestačí, a to je tu to podstatné.
--
-- Pohľad sa pýta na `profiles`, aby vedel, či predajca nie je zablokovaný.
-- Politika `profiles_select` pritom skrýva súkromné profily pred tými, čo ich
-- nesledujú. S `security_invoker` by sa teda ponuka predajcu so súkromným
-- profilom stratila zo SWAPu každému, kto ho nesleduje — vrátane
-- neprihláseného. Ponuka by nezmizla z databázy, iba by ju nebolo vidno, a to
-- je presne ten druh chyby, ktorý sa hľadá týždne.
--
-- Preto sa otázka „je tento predajca zablokovaný?" presúva do funkcie, ktorá
-- vráti jediný boolean a nič iné. Zablokovanie nie je súkromný údaj — je to
-- stav, ktorý už dnes rozhoduje o tom, či ponuka je alebo nie je na stránke.
-- ============================================================================
set search_path = public, extensions;

-- --- je predajca zablokovaný? ------------------------------------------------
--
-- `security definer`, lebo odpoveď sa nesmie meniť podľa toho, či sa pýtajúci
-- na profil pozrieť smie. Vracia jediný boolean a žiadny riadok, takže sa cez
-- ňu nedá prečítať nič iné. Neexistujúci profil berieme ako zablokovaný:
-- ponuka bez predajcu nemá na burze čo robiť.
create or replace function public.seller_is_suspended(p_seller uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce((select p.is_suspended from public.profiles p where p.id = p_seller), true);
$$;

revoke all on function public.seller_is_suspended(uuid) from public;
grant execute on function public.seller_is_suspended(uuid) to anon, authenticated, service_role;

-- --- čo sa práve dá kúpiť ----------------------------------------------------
--
-- Rovnaké pravidlo ako predtým, len bez joinu na `profiles`. Podmienky na
-- `resale_listings` a `events` zostávajú ako boli: `status = 'active'` aj
-- `published` + `public` sú to, čo RLS týchto dvoch tabuliek dovolí
-- komukoľvek, takže prepnutie na práva pýtajúceho sa na nich neprejaví.
create or replace view public.swap_live_listings
with (security_invoker = on)
as
select l.*
from public.resale_listings l
where l.status = 'active'
  and (l.expires_at is null or l.expires_at > now())
  and not public.seller_is_suspended(l.seller_id)
  and exists (
    select 1 from public.events e
    where e.id = l.event_id
      and e.status = 'published'
      and e.visibility = 'public'
      and coalesce(e.end_at, e.start_at) > now()
  );

grant select on public.swap_live_listings to anon, authenticated;
