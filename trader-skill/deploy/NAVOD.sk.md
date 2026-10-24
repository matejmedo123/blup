# Trader 24/7 na vlastnom serveri — celý návod krok za krokom

Robot obchoduje len vtedy, keď beží. Na notebooku to znamená „kým je zapnutý“, na malom serveri v cloude
(VPS) nonstop. Tento návod ťa prevedie všetkým: od prenájmu servera cez prvé spustenie na simulátore až po
ostré peniaze na Bybit EU. Netreba byť programátor, stačí kopírovať príkazy do terminálu.

**Na konci budeš mať:** robota, ktorý beží 24/7 na serveri, nástenku v prehliadači (aj v mobile),
upozornenia na mobil a jasný postup: simulátor → Bybit testnet → malý ostrý účet.

---

## 0. Čo budeš potrebovať

| Čo | Načo | Cena |
|---|---|---|
| VPS v EÚ (Ubuntu 24.04, 2 GB RAM) | tu robot beží nonstop | ~5 € / mesiac |
| Prístup ku kódu na GitHube (`matejmedo123/blup`) | stiahnutie robota na server | zadarmo |
| Mobilná aplikácia **ntfy** | upozornenia na mobil | zadarmo |
| Účet na **testnet.bybit.com** | papierové obchodovanie cez skutočné API | zadarmo |
| Neskôr účet na **bybit.eu** (overenie totožnosti) | ostré peniaze | vklad podľa teba |
| Voliteľne doména (napr. z Websupportu) | nástenka cez HTTPS aj v mobile | ~10 € / rok |

---

## 1. Najprv úprimne

* **Čo robí:** sleduje 10 najväčších kryptomien a obchoduje denné trendy (prieraz, EMA trend, funding).
  Riziko 2 % kapitálu na obchod, BTC a ETH 3 %. Stop-loss je pri každom obchode.
* **Kedy obchoduje:** denné signály vyhodnocuje raz za deň, hneď po dennom uzavretí o 00:00 UTC (u nás
  1:00 alebo 2:00 v noci). Stopy a výstupy stráži každú minútu, nonstop.
* **Čo čakať** (z testov na dátach, ktoré robot pri výbere nevidel — minulosť, nie sľub):
  * rok s trendom na krypte: približne **+20 až +35 %**,
  * rok bez trendu: **0 až +8 %**,
  * prepady kapitálu **−25 až −35 %** treba vydržať.
* **Niekedy mesiace neobchoduje.** Ak backtest laboratórium nenájde stratégiu, ktorá po poplatkoch obstojí
  na nevidených dátach, robot sedí v hotovosti. Napríklad od októbra 2025 do marca 2026 nevalidovalo nič.
  Tak je to navrhnuté.
* **Začína na simulátore:** lokálna papierová kniha, žiadny účet, žiadne skutočné peniaze. Na ostré peniaze
  sa sám nikdy neprepne — treba spraviť všetkých 5 krokov z časti 12.
* **Obchodovanie môže prerobiť peniaze**, aj automatické, aj s poistkami. Je to vzdelávací nástroj, nie
  finančné poradenstvo. Vkladaj len toľko, koľko môžeš stratiť.

---

## 2. Prenajmi si server (VPS)

* **Server musí byť v EÚ** (Nemecko, Fínsko, Slovensko…) — Bybit blokuje servery z USA.
* Stačí malý VPS: 1–2 vCPU, **2 GB RAM** (backtest laboratórium raz týždenne potrebuje pár stoviek MB),
  aspoň 10 GB disk, systém **Ubuntu 24.04**.
* Napríklad Hetzner Cloud (CX22, Nemecko/Fínsko) alebo VPS od Websupportu. Aktuálne ceny over u poskytovateľa.
* **Bežný webhosting (ako má web ENZO) nestačí** — nedovolí, aby program bežal nepretržite.
* Pri objednávke si zvoľ prihlásenie cez SSH kľúč (bezpečnejšie) alebo heslo. Dostaneš **IP adresu**
  servera, napr. `203.0.113.10` — v návode ju všade nahraď svojou.

---

## 3. Pripoj sa na server

**Z počítača:** na Macu/Linuxe Terminál, na Windows PowerShell:

```bash
ssh root@203.0.113.10
```

**Len z mobilu:** nainštaluj aplikáciu **Termius** (iPhone aj Android), pridaj „Host“ s IP adresou,
používateľom `root` a heslom alebo kľúčom.

Ak ti poskytovateľ dal iného používateľa než `root`, prihlás sa ním — príkazy nižšie už `sudo` majú.

Hneď aktualizuj systém, nainštaluj git a zapni firewall (otvorené zostane len SSH):

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y git
sudo ufw allow OpenSSH
sudo ufw enable
```

---

## 4. Stiahni robota na server

Repozitár je na GitHube. Ak je súkromný, GitHub chce namiesto hesla **token**:

1. Na GitHube: *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*.
2. *Repository access:* len `matejmedo123/blup`, *Permissions → Contents:* **Read-only**. Platnosť napr. 90 dní.
3. Token si skopíruj (začína `github_pat_…`).

Na serveri:

```bash
cd ~
git clone --depth 1 --branch claude/enzo-burger-website-lc5i0e https://github.com/matejmedo123/blup.git
```

Keď sa spýta: *Username* = tvoje meno na GitHube, *Password* = token (pri vkladaní ho nevidno, to je v poriadku).

> **Bez gitu:** na GitHube prepni na vetvu `claude/enzo-burger-website-lc5i0e`, *Code → Download ZIP*, rozbaľ
> v počítači a nahraj priečinok na server: `scp -r blup-…/trader-skill root@203.0.113.10:~/` — potom v kroku 5
> použi cestu `~/trader-skill/deploy/install-vps.sh`.

---

## 5. Inštalácia

```bash
sudo bash ~/blup/trader-skill/deploy/install-vps.sh
```

Skript sám:

* vytvorí systémového používateľa `trader` (robot nebeží ako správca),
* skopíruje program do `/opt/trader`; stav robota (nastavenia, denník obchodov, pozície) bude v `/var/lib/trader`,
* vytvorí súbor s heslami a kľúčmi `/etc/trader/trader.env` (prístupný len správcovi),
* nainštaluje a spustí dve služby, ktoré sa samy zapnú aj po reštarte servera:
  * `trader-autopilot` — samotný robot, beží nonstop,
  * `trader-dashboard` — webová nástenka.

Na konci vypíše „Done.“ a ďalšie kroky.

---

## 6. Heslo a kľúče

```bash
sudo nano /etc/trader/trader.env
```

Teraz vyplň:

* `TRADER_DASHBOARD_PASSWORD=` — **dlhé heslo k nástenke** (kto ho má, môže robota pozastaviť alebo stlačiť KILL).
* `SEC_USER_AGENT="Meno Priezvisko tvoj@email.sk"` — americký úrad SEC to vyžaduje pri čítaní hlásení firiem.

Kľúče od Bybitu doplníš až v časti 12. Ostatné (Alpaca, X/Twitter, Telegram, Anthropic) je voliteľné.

Uložíš **Ctrl+O**, Enter, zavrieš **Ctrl+X**.

---

## 7. Nastav stratégiu (profil)

Toto je nastavenie, ktoré v testoch vyšlo najlepšie a na ktorom beží aj papierový robot:
2 % riziko, BTC a ETH 3 %, páka 1,5× (spot marža), náklady Bybitu, „nechaj víťazov bežať“.

Najprv si pozri, čo sa zmení (nič sa ešte neuloží):

```bash
sudo traderctl profile --risk 2 --core-risk 3 --capital 1000 --fixed-risk --leverage 1.5 --venue bybit
```

Ak to sedí, ulož to a reštartuj:

```bash
sudo traderctl profile --risk 2 --core-risk 3 --capital 1000 --fixed-risk --leverage 1.5 --venue bybit --write
sudo traderctl restart
```

* `--capital 1000` = s koľkými peniazmi počítať (v USD/USDC). Pri ostrom účte sem dáš skutočný vklad.
* **Bez páky** (opatrnejšie, alebo ak ti Bybit maržu neponúkne): namiesto `--leverage 1.5` daj `--leverage 1`.
* Profil sa **nikdy** nedotkne brokera, režimu, kľúčov ani prepínača na ostré peniaze.

Reštart alebo zastavenie môže trvať **až 2 minúty** — robot najprv dokončí rozbehnutý cyklus. Nič nevypínaj natvrdo.

---

## 8. Prvé spustenie: backtest laboratórium

Pri prvom štarte robot ešte nemá „playbook“ — zoznam kombinácií mince a stratégie, ktoré obstáli v teste.
**Sám si spustí backtest laboratórium** (stiahne históriu cien a otestuje stratégie). Zvyčajne to trvá
5–30 minút. Kým nedobehne, krypto neobchoduje a v stave uvidíš *„no backtest-lab playbook yet“*.

Potom si laboratórium zopakuje každý týždeň samo, aby sledovalo trh. Výsledok ti príde aj ako upozornenie
(„Backtest lab: N validated“).

Ako to sledovať:

```bash
sudo tail -3 /var/lib/trader/autopilot/housekeeping.jsonl    # "task": "lab" = dobehlo (alebo chyba)
sudo traderctl universe                                     # ktoré mince sleduje a prečo
```

---

## 9. Skontroluj, že žije

```bash
sudo traderctl health     # OK = robot sa ozval v posledných minútach
sudo traderctl status     # čo robí, dnešné obchody, otvorené pozície
sudo traderctl logs       # priebežný záznam (odchod: Ctrl+C)
sudo traderctl learned    # čo sa naučil z vlastných obchodov
```

`health` napíše **FAIL**, ak sa robot dlho neozval alebo mu opakovane zlyhávajú výstupy — vtedy pozri `logs`.

---

## 10. Otvor nástenku

Nástenka nie je nikdy priamo na internete. Máš tri možnosti:

**A) SSH tunel z počítača (najjednoduchšie).** V novom okne terminálu na svojom počítači:

```bash
ssh -L 8765:127.0.0.1:8765 root@203.0.113.10
```

Kým je okno otvorené, v prehliadači otvor **http://127.0.0.1:8765**.

**B) Z mobilu cez Termius.** V hoste pridaj *Port Forwarding → Local*: port `8765`, cieľ `127.0.0.1:8765`.
Pripoj sa a v mobilnom prehliadači otvor **http://127.0.0.1:8765**.

**C) Vlastná doména s HTTPS (najpohodlnejšie v mobile).**

1. U registrátora domény nastav DNS záznam typu **A**, napr. `trader.tvojadomena.sk` → IP servera.
2. Na serveri:

   ```bash
   sudo apt install -y caddy
   sudo cp /opt/trader/deploy/Caddyfile.example /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile        # trader.example.com prepíš na svoju doménu
   sudo systemctl restart trader-dashboard caddy
   sudo ufw allow 80,443/tcp
   ```

3. Otvor **https://trader.tvojadomena.sk** a prihlás sa heslom z kroku 6. Bez hesla nástenka cez doménu nič
   neukáže. Na mobile ju môžeš *Pridať na plochu* — správa sa ako aplikácia.

Čo na nástenke nájdeš:

* **Overview** — „Je všetko OK?“, kapitál, zisky a straty, otvorené pozície, posledné rozhodnutia.
* **Bot** — či žije, každé rozhodnutie s dôvodom, tlačidlá **Pause**, **Run once** a **KILL**.
* **Checks** — či výsledky zodpovedajú backtestu a či dodržal pravidlá.
* **Brain**, **Trades**, **News**, **Help**.

---

## 11. Upozornenia na mobil

**ntfy (zadarmo, bez registrácie):**

1. Nainštaluj aplikáciu **ntfy** a prihlás sa na odber témy s dlhým náhodným názvom, napr.
   `trader-7f3k9q2m8x4v-matej`. Kto názov pozná, môže tvoje upozornenia čítať.
2. Na serveri (názov témy prepíš na svoj):

   ```bash
   sudo -u trader python3 - <<'EOF'
   import json
   p = "/var/lib/trader/config.json"
   c = json.load(open(p))
   c["notify"]["enabled"] = True
   c["notify"]["ntfy_topic"] = "trader-7f3k9q2m8x4v-matej"
   json.dump(c, open(p, "w"), indent=2)
   EOF
   sudo traderctl restart
   sudo traderctl notify-test
   ```

   Na mobil ti príde skúšobná správa.

**Telegram (voliteľne):** v Telegrame napíš @BotFather, vytvor bota a jeho token daj do `TELEGRAM_BOT_TOKEN`
a číslo svojho chatu do `TELEGRAM_CHAT_ID` v `/etc/trader/trader.env`. V skripte vyššie potom nastav
`c["notify"]["telegram"] = True`.

Správa ti príde, keď robot:

* štartuje, otvorí alebo zavrie obchod,
* sa zastaví (KILL, denný limit straty, veľký prepad kapitálu),
* sa niečo naučí, alebo laboratórium validuje nové kombinácie,
* má opakované chyby,
* a raz denne s denným súhrnom.

---

## 12. Z papiera na skutočné peniaze — tri fázy

### Fáza 1 · Simulátor (hneď po inštalácii, 2–4 týždne)

Robot obchoduje na lokálnej papierovej knihe so skutočnými cenami. Sleduj, či žije, či obchoduje podľa
pravidiel (karta **Checks**) a či ti chodia upozornenia.

### Fáza 2 · Bybit testnet (papier, ale cez skutočné API burzy, aspoň 2–3 týždne)

1. Zaregistruj sa na **testnet.bybit.com** (samostatný účet, bez overenia totožnosti) a vyžiadaj si testovacie USDC.
2. *API Management → Create New Key → System-generated*, práva **Read-Write**, *Unified Trading → Spot (Trade)*.
   **Withdraw (výber) nezaškrtávaj.** Kľúč naviaž na IP adresu servera.
3. Kľúče daj do `sudo nano /etc/trader/trader.env`:

   ```
   BYBIT_TESTNET_KEY=...
   BYBIT_TESTNET_SECRET=...
   ```

4. Prepni brokera na Bybit (režim ostáva `paper` = testnet) a over spojenie:

   ```bash
   sudo -u trader python3 - <<'EOF'
   import json
   p = "/var/lib/trader/config.json"
   c = json.load(open(p))
   c["autopilot"]["broker"] = "bybit"
   json.dump(c, open(p, "w"), indent=2)
   EOF
   sudo traderctl restart
   sudo traderctl broker-test      # len čítanie: kľúče, IP, zostatok, mince — nič neposiela
   ```

`broker-test` musí skončiť bez chyby. Ak nie, pozri časť 16.

### Fáza 3 · Ostrý účet na bybit.eu (začni malou sumou)

1. Účet na **bybit.eu**, overenie totožnosti, vklad v EUR → zmeň na **USDC**.
2. Ak chceš páku 1,5×, zapni na webe alebo v aplikácii **Spot margin** (Bybit chce krátky kvíz). Bez nej
   nastav profil s `--leverage 1` (krok 7).
3. Nový API kľúč ako v testnete: **bez práva výberu**, naviazaný na IP servera.
4. Do `/etc/trader/trader.env`:

   ```
   BYBIT_LIVE_KEY=...
   BYBIT_LIVE_SECRET=...
   ```

5. Nastav profil na skutočný vklad (napr. 500 USDC):

   ```bash
   sudo traderctl profile --risk 2 --core-risk 3 --capital 500 --fixed-risk --leverage 1.5 --venue bybit --write
   ```

6. **Päť krokov, bez ktorých robot ostré peniaze odmietne:**
   1. broker `bybit`,
   2. `autopilot.mode` = `live`,
   3. `paper` = `false`,
   4. živé kľúče (bod 4),
   5. `live_confirmation` = `I ACCEPT REAL MONEY RISK`.

   Kroky 2, 3 a 5 nastavíš takto (broker je už `bybit` z fázy 2):

   ```bash
   sudo -u trader python3 - <<'EOF'
   import json
   p = "/var/lib/trader/config.json"
   c = json.load(open(p))
   c["paper"] = False
   c["autopilot"]["broker"] = "bybit"
   c["autopilot"]["mode"] = "live"
   c["autopilot"]["live_confirmation"] = "I ACCEPT REAL MONEY RISK"
   json.dump(c, open(p, "w"), indent=2)
   EOF
   sudo traderctl check-live       # vypíše, či je všetkých 5 krokov splnených
   sudo traderctl broker-test
   sudo traderctl restart
   ```

**Späť na papier:** ten istý skript s `c["paper"] = True`, `c["autopilot"]["mode"] = "paper"`, a reštart.

Keď kapitál výrazne narastie (alebo dovložíš), spusti znova profil s novou sumou v `--capital`. Robot ti sám
napíše, keď ho dolárové poistky začnú brzdiť.

---

## 13. Každodenná obsluha

| Chceš … | Urob |
|---|---|
| žiadne nové obchody, otvorené nech dobehnú | **Pause** na nástenke alebo `sudo traderctl pause` |
| **okamžite všetko zavrieť** | **KILL** na nástenke alebo `sudo traderctl kill --confirm KILL` |
| znova povoliť obchody | **Resume** na nástenke alebo `sudo traderctl resume` |
| vypnúť program | `sudo traderctl stop` (pozície ostanú otvorené — ak ich chceš zavrieť, najprv KILL) |
| znova spustiť program | `sudo traderctl start` |

Robot sa zastaví aj sám:

* **Denný limit straty:** pri dosiahnutí limitu prestane otvárať nové obchody do ďalšieho dňa.
* **Veľký prepad:** keď kapitál klesne o 35 % pod svoje maximum, pozastaví sa a čaká, kým to skontroluješ a dáš **Resume**.
* **Séria strát:** po 7 stratách po sebe zníži riziko na polovicu.

**Na Bybite je stop-loss priamo na burze**, takže pozíciu chráni, aj keby server na chvíľu vypadol.

---

## 14. Aktualizácia na novú verziu

```bash
cd ~/blup
git pull
sudo bash ~/blup/trader-skill/deploy/install-vps.sh
```

Nastavenia, kľúče, denník obchodov aj pozície ostanú zachované. Reštart počká, kým robot dokončí cyklus.

---

## 15. Záloha

Raz za čas (a vždy pred väčšou zmenou):

```bash
sudo tar czf ~/trader-zaloha-$(date +%F).tgz /var/lib/trader /etc/trader
```

Na počítač si ju stiahneš: `scp root@203.0.113.10:~/trader-zaloha-*.tgz .`
**Záloha obsahuje kľúče** — nikomu ju neposielaj a nedávaj na verejné miesta.

---

## 16. Keď niečo nejde

| Príznak | Čo s tým |
|---|---|
| `health` píše FAIL / „no heartbeat“ | `sudo traderctl logs`, `sudo systemctl status trader-autopilot` |
| „no backtest-lab playbook yet“ | laboratórium ešte beží (časť 8) — počkaj; chybu uvidíš v `housekeeping.jsonl` |
| Robot nič nekupuje | normálne: denné signály prichádzajú raz za deň a nie každý deň. Dôvod každého rozhodnutia je na karte **Bot** |
| Bybit „Unmatched IP“ / 10010 | API kľúč je naviazaný na inú IP — v Bybite nastav IP servera |
| Bybit 10003 / 10004 (neplatný kľúč, podpis) | kľúč alebo secret je zle skopírovaný, alebo máš testnet kľúč pri ostrom režime (či naopak) |
| Bybit 170359 („not support leveraged“) | tvoj účet nemá spot maržu — zapni ju alebo daj profil s `--leverage 1` |
| Nástenka cez doménu vráti 403 | chýba `TRADER_DASHBOARD_PASSWORD` v `/etc/trader/trader.env`, potom `sudo traderctl restart` |
| Upozornenie „settings file … broken“ | preklep v `config.json` — robot beží so starým platným nastavením; oprav súbor alebo spusti skript znova |
| Málo miesta na disku | pri < 1 GB ťa upozorní, pri < 200 MB neotvára nové obchody (výstupy stráži ďalej) |

---

## 17. Bezpečnosť v skratke

* `/etc/trader/trader.env` a zálohy nikomu neposielaj, nedávaj do gitu ani nikam nevkladaj.
* API kľúče **vždy bez práva výberu** a naviazané na IP servera — aj ukradnutým kľúčom sa peniaze nedajú vybrať.
* Port 8765 na firewalle nikdy neotváraj — nástenka ide len cez SSH tunel alebo HTTPS s heslom.
* Robot beží ako obyčajný používateľ `trader` a zapisovať môže len do `/var/lib/trader`.
* Nástenka nikdy neukáže hodnotu kľúča, len „set / not set“. Ostré peniaze sa z nástenky zapnúť nedajú.

---

## Čo nenasadzovať

**Meme-coin sniper** (`trader-sniper`) v testoch na histórii aj naživo prerábal (137 obchodov, −25 % na obchod).
Na skutočné peniaze ho nespúšťaj. Robot sám meme coiny nikdy automaticky neobchoduje.

---

## Alternatíva: Docker

Ak radšej používaš Docker (namiesto krokov 5–6):

```bash
cd ~/blup/trader-skill/deploy
cp trader.env.example trader.env     # povinné — docker-compose tento súbor číta
nano trader.env                      # TRADER_DASHBOARD_PASSWORD je pri Dockeri povinné
docker compose up -d --build
docker compose logs -f autopilot
```

Profil potom nastavíš:

```bash
docker compose exec autopilot python3 trader-autopilot/autopilot.py profile --risk 2 --core-risk 3 --capital 1000 --fixed-risk --leverage 1.5 --venue bybit --write
docker compose restart
```

Nástenka je na `127.0.0.1:8765` servera (cez SSH tunel ako v časti 10). Aj tu môže `docker compose stop`
alebo `restart` trvať až dve minúty.
