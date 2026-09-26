-- ============================================================================
-- Provízia SWAPu: 10 %, a platí ju predajca
-- ============================================================================
-- Doteraz to bolo 5 % od kupujúceho a 5 % od predajcu. Spolu tiež desať, ale
-- rozdelené tak, že kupujúci videl v ponuke jednu cenu a v pokladni vyššiu.
--
-- To je presne tá vec, ktorú ľudia na predaji vstupeniek neznášajú najviac —
-- a je to aj to, čo konkurencia rieši štítkom „no extra fees" priamo v
-- zozname ponúk. Cena v ponuke má byť cena, ktorú človek zaplatí.
--
--   kupujúci   0 %    zaplatí presne toľko, koľko videlo
--   predajca  10 %    z ceny, ktorú si sám určil
--
-- Predajcu to neprekvapí: pri vypisovaní vidí „dostaneš X €" ešte predtým,
-- než ponuku zverejní, a v prehľade to má pri každej ponuke.
--
-- Spolu si teda platforma berie 10 % z ceny vstupenky — rovnako ako predtým,
-- len je jasné, kto ich platí a kedy sa to dozvie.
--
-- Obe čísla zostávajú nastaviteľné v admine. Toto mení len východzí stav.
-- ============================================================================
set search_path = public, extensions;

alter table public.platform_settings
  alter column resale_buyer_fee_bps  set default 0,
  alter column resale_seller_fee_bps set default 1000;

-- Existujúci riadok nastavení (je práve jeden) sa posunie tiež — inak by sa
-- nová sadzba týkala len inštalácie, ktorá vznikne odznova.
update public.platform_settings
set resale_buyer_fee_bps = 0,
    resale_seller_fee_bps = 1000
where id;
