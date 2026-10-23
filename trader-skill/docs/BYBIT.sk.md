# Bybit EU — burza s pákou pre bota (návod)

## Prečo Bybit EU a nie futures

Bot zarába na trendoch a často by chcel držať viac pozícií naraz, než mu stačí hotovosť. Páka 1,5× tento
problém rieši: od roku 2020 by z 1 000 € bolo približne 24 000 € namiesto 15 500 € pri rovnakom najhoršom
poklese (−30 %). Záleží však na tom, **odkiaľ** páka pochádza:

| Zdroj páky | Čo stojí | Výsledok od 2020 (1 000 €) |
|---|---|---|
| Perpetual futures (Kraken, Bybit, Hyperliquid…) | funding z **celej** pozície, v priemere 10–15 % ročne, v býčom trhu aj 30 %+ | 11 397 € (horšie ako bez páky) |
| **Spot marža (Bybit EU)** | úrok **len z požičanej časti** a len kým chýba hotovosť | 24 270 € pri 10 %, 21 771 € aj pri 75 % ročne |
| Bez páky (Alpaca) | — | 15 452 € |

Bybit EU GmbH (Viedeň) má licenciu MiCA pre celý EHP vrátane Slovenska, ponúka spot maržu, poplatok 0,1 %
(počítame opatrne 0,15 %) a API, ktoré bot obsluhuje priamo. Binance licenciu MiCA nemá, Kraken spot marža stojí
0,01–0,05 % každé 4 hodiny (22–110 % ročne) a Kraken spot poplatky sú vyššie.

## Čo bot na Bybite robí

* Nakupuje spot (napr. `BTCUSDC`) limitným príkazom hneď po dennom uzavretí (00:00:05 UTC).
* **Stop-loss je priamo na burze** (TP/SL príkaz, pri spustení predaj za trh) — spustí sa okamžite, keď cena
  dosiahne stop, nie až keď sa bot znova pozrie. Coiny sú pre stop rezervované.
* S pákou si požičia len chýbajúcu časť (`isLeverage=1` len pri nákupe). **Predaj si nikdy nepožičiava** —
  bot nikdy neotvorí short. Páku na účte nastaví na 2× (viac nikdy), bot sám drží 1,5×.
* Pôžičku Bybit automaticky spláca z predajov (auto-repay každých 30 minút).
* Meme coiny nikdy na páku. Akcie na Bybit nikdy (Bybit ich nemá).

## Krok za krokom

### 1. Najprv testnet (papierové obchodovanie s reálnym API)

1. Zaregistruj sa na **testnet.bybit.com** (samostatný účet, bez KYC) a v ňom si vyžiadaj testovacie USDC.
2. *API Management → Create New Key → System-generated*, práva: **Read-Write**, *Unified Trading → Spot*
   (Trade). **Withdraw nezaškrtávaj.** Ideálne naviaž kľúč na IP adresu servera, kde bot beží.
3. Do `trader/secrets.env` (práva 0600):

   ```
   BYBIT_TESTNET_KEY=...
   BYBIT_TESTNET_SECRET=...
   ```

4. V `trader/config.json` nastav `"autopilot": {"broker": "bybit", "mode": "paper"}` a profil:

   ```bash
   python3 trader-autopilot/autopilot.py profile --risk 2 --core-risk 3 --capital 1000 --fixed-risk \
       --leverage 1.5 --venue bybit --write
   python3 trader-autopilot/autopilot.py broker-test      # len čítanie: kľúče, IP, zostatok, coiny
   ```

5. Spusti bota (`autopilot.py daemon --approve`) a nechaj ho bežať aspoň pár týždňov.

### 2. Ostrý účet (až keď testnet funguje)

1. Účet na **bybit.eu**, overenie totožnosti (KYC), vklad v EUR → zmena na USDC.
2. *Spot margin* treba raz zapnúť na webe alebo v aplikácii (Bybit chce krátky kvíz).
3. API kľúč ako vyššie: **bez práva výberu**, naviazaný na IP servera.
4. `trader/secrets.env`: `BYBIT_LIVE_KEY=...`, `BYBIT_LIVE_SECRET=...`
5. Živé obchodovanie sa zapne iba po všetkých piatich krokoch (inak bot odmietne):
   `autopilot.broker "bybit"`, `autopilot.mode "live"`, `"paper": false`, živé kľúče a
   `autopilot.live_confirmation "I ACCEPT REAL MONEY RISK"`. Overenie: `autopilot.py check-live`.

## Dôležité upozornenia

* **Z cloudového prostredia, kde bol bot vyvíjaný, sa na Bybit nedá pripojiť** (Bybit blokuje USA). Napojenie je
  postavené presne podľa dokumentácie API v5 a otestované na simulovaných odpovediach burzy (24 testov vrátane
  celého cyklu nákup → stop na burze → uzavretie), ale **prvé reálne spojenie bude až u teba** — preto testnet
  a `broker-test` ako prvé.
* Bybit EU uvádza poplatky nejednotne (0,1 % aj 0,15 % pre taker) — simulátor počíta 0,15 % + 0,03 % sklz.
* Úrok z marže sa mení každú hodinu; simulátor počíta opatrných 20 % ročne z požičanej časti.
* Páka nezvyšuje riziko obchodu (to určuje stop), ale pri prudkom skoku ceny cez stop je strata väčšia.
* Na hotovosti na burze sa neúročí nič (MiCA zakazuje úrok zo stablecoinov) — preto v profile 0 %.
