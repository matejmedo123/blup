# Trader 24/7 na vlastnom serveri — návod krok za krokom

Robot obchoduje len vtedy, keď beží. Na notebooku to znamená „kým je zapnutý“, na malom serveri
v cloude (VPS) nonstop. Tento návod ťa prevedie celým nastavením — netreba byť programátor, stačí
vedieť skopírovať príkaz do terminálu.

## Najprv úprimne

* **Kryptomeny obchoduje 24/7**, každý deň vrátane víkendov.
* **Americké akcie len počas riadnej seansy burzy**: 9:30–16:00 newyorského času, čo je u nás
  **15:30–22:00** (pár týždňov v marci a na prelome októbra/novembra, keď sa čas mení v inom termíne,
  je to 14:30–21:00). Nové obchody otvára do 15:30 newyorského času (u nás 21:30) a pred 15:55 (21:55)
  všetko zavrie. Pred otvorením, po zatvorení ani v noci akcie neobchoduje — zámerne: všetky jeho
  pravidlá a spätné testy sú postavené na dátach z riadnej seansy. Mimo seansy obchoduje kryptomeny,
  číta správy a hlásenia firiem (SEC filingy) a vyberá si akcie na ďalší deň.
* **Začína na simulátore** — lokálna „papierová“ kniha, žiadny účet, žiadne skutočné peniaze.
  Skutočné peniaze zapneš len vtedy, keď sám prejdeš všetkých päť krokov z hlavného README (časť
  *Live mode*). Samotný kľúč od brokera ho na skutočné peniaze nikdy neprepne.
* **Obchodovanie môže prerobiť peniaze** — aj automatické, aj s týmito bezpečnostnými poistkami.
  Ide o vzdelávací nástroj, nie o finančné poradenstvo.

## 1. Prenajmi si server (VPS)

* Stačí najmenší VPS: 1 vCPU, 1–2 GB RAM, ~5 GB disk, systém **Ubuntu 24.04** (alebo 22.04, Debian 12).
* Orientačne **4–6 € mesačne** — napr. Hetzner Cloud alebo VPS od Websupportu. Aktuálne ceny si
  over priamo u poskytovateľa.
* **Bežný webhosting (ako má web ENZO) na to nestačí** — nedovolí, aby program bežal nepretržite.
  Potrebuješ VPS.
* Pri objednávke si zvoľ prihlásenie cez SSH kľúč (bezpečnejšie) alebo heslo. Poskytovateľ ti dá
  **IP adresu** servera, napr. `203.0.113.10`.

## 2. Pripoj sa na server

Na Macu alebo Linuxe otvor Terminál, na Windows PowerShell:

```bash
ssh root@203.0.113.10
```

(Namiesto `203.0.113.10` daj IP adresu svojho servera. Ak ti poskytovateľ dal iného používateľa než
`root`, použi ten a pred príkazy nižšie píš `sudo`.)

Hneď zapni firewall, aby bol otvorený len SSH:

```bash
ufw allow OpenSSH
ufw enable
```

## 3. Nahraj priečinok `trader-skill` na server

V **novom** okne terminálu na svojom počítači (nie na serveri), v priečinku, kde máš `trader-skill`:

```bash
scp -r trader-skill root@203.0.113.10:~/
```

## 4. Spusti inštaláciu

Späť v okne pripojenom na server:

```bash
sudo bash ~/trader-skill/deploy/install-vps.sh
```

Skript sám:

* vytvorí systémového používateľa `trader` (robot nebeží ako správca),
* skopíruje program do `/opt/trader`,
* stav robota (nastavenia, denník obchodov, pozície) bude v `/var/lib/trader`,
* vytvorí súbor s kľúčmi `/etc/trader/trader.env` (prístupný len správcovi),
* nainštaluje dve služby, zapne ich pri štarte servera a spustí ich:
  * `trader-autopilot` — samotný robot, beží nonstop,
  * `trader-dashboard` — webová nástenka, kde všetko vidíš a ovládaš.

## 5. Doplň heslo a kľúče

```bash
sudo nano /etc/trader/trader.env
```

Vyplň aspoň:

* `TRADER_DASHBOARD_PASSWORD=` — dlhé heslo k nástenke (kto ho má, môže robota zastaviť alebo stlačiť KILL),
* `SEC_USER_AGENT="Meno Priezvisko tvoj@email.sk"` — americký úrad SEC to vyžaduje, aby robot mohol čítať
  hlásenia firiem (8-K). Bez toho kontrola „správy a filingy“ filingy nevidí.

Ostatné je voliteľné (broker Alpaca — najprv **paper** účet s falošnými peniazmi, X/Twitter token,
Telegram, Anthropic kľúč pre AI desk). Uložíš **Ctrl+O**, Enter, zavrieš **Ctrl+X**. Potom:

```bash
sudo traderctl restart
```

**Zastavenie alebo reštart môže trvať až dve minúty** — robot najprv dokončí rozbehnutý cyklus
(pri novom signáli robí spätný test a simuláciu Time Machine, to trvá 60–90 sekúnd) a až potom skončí.
To je v poriadku, nič nevypínaj „natvrdo“.

## 6. Skontroluj, že žije

```bash
sudo traderctl health     # OK = robot sa ozval v posledných minútach
sudo traderctl status     # čo robí, dnešné obchody, otvorené pozície
sudo traderctl logs       # priebežný záznam (odchod: Ctrl+C)
```

## 7. Otvor nástenku

Nástenka nie je nikdy priamo vystavená na internet. Dve možnosti:

**A) SSH tunel (najjednoduchšie, nič netreba nastavovať).** Na svojom počítači spusti:

```bash
ssh -L 8765:127.0.0.1:8765 root@203.0.113.10
```

Kým je toto okno otvorené, v prehliadači otvor **http://127.0.0.1:8765**.

**B) Vlastná doména s HTTPS (aj na mobil).** Ak máš doménu, nasmeruj ju na IP servera a použi
`deploy/Caddyfile.example` (postup je priamo v súbore). Heslo `TRADER_DASHBOARD_PASSWORD` je vtedy
povinné — bez neho nástenka cez Caddy nič neukáže.

Na nástenke:

* **Bot** — či robot žije (heartbeat), obchodné hodiny v tvojom čase, každé rozhodnutie aj s dôvodom
  (prečo obchod vzal alebo vynechal), tlačidlá **Pause**, **Run once** a **KILL**.
* **Brain** — ktoré akcie a kryptomeny si sám vybral a prečo, čo sa naučil z vlastných obchodov
  (napr. stratégia, ktorá prerába, si dá pauzu; po sérii strát zníži riziko), AI desk a notifikácie.
* **Overview / Trades** — kapitál, zisky a straty, každý obchod s grafom.
* **News** — správy, filingy, X a StockTwits na jednom mieste.

## 8. Upozornenia na mobil

**ntfy (zadarmo, bez registrácie):**

1. Nainštaluj si aplikáciu **ntfy** (Android / iPhone).
2. Vymysli dlhý náhodný názov témy, napr. `trader-jana-7f3k9q2m8x4v` — kto ho pozná, môže tvoje
   upozornenia čítať, preto nie „trader“ či „jana“.
3. V aplikácii sa prihlás na odber tejto témy.
4. Na serveri: `sudo -u trader nano /var/lib/trader/config.json`, nájdi časť `"notify"` a nastav
   `"enabled": true` a `"ntfy_topic": "trader-jana-7f3k9q2m8x4v"`.
5. `sudo traderctl restart` a potom `sudo traderctl notify-test` — na mobil ti príde skúšobná správa.

**Telegram:** v Telegrame napíš @BotFather, vytvor si bota, jeho token daj do `TELEGRAM_BOT_TOKEN`,
svoje číslo chatu do `TELEGRAM_CHAT_ID` (v súbore `/etc/trader/trader.env`) a v `config.json` nastav
v časti `"notify"` hodnotu `"telegram": true`.

Dostaneš správu, keď robot štartuje, otvorí alebo zavrie obchod, keď sa zastaví (KILL, denný limit
straty, pokles kapitálu), keď sa niečo naučí, pri opakovaných chybách a raz denne súhrn po zatvorení
americkej burzy.

## 9. Zastavenie

| Chceš … | Urob |
|---------|------|
| žiadne nové obchody, otvorené nech dobehnú | **Pause** na nástenke alebo `sudo traderctl pause` |
| **okamžite všetko zavrieť** | **KILL** na nástenke alebo `sudo traderctl kill --confirm KILL` |
| vypnúť program | `sudo traderctl stop` (pozície ostanú otvorené — ak ich chceš zavrieť, najprv KILL) |
| znova spustiť | **Resume** na nástenke alebo `sudo traderctl resume`; program: `sudo traderctl start` |

Robot sa zastaví aj sám: pri dosiahnutí denného limitu straty spustí KILL a keď kapitál klesne o 10 %
pod svoje maximum, pozastaví sa a čaká, kým to skontroluješ a dáš **Resume**.

## 10. Aktualizácia

Nahraj novú verziu priečinka `trader-skill` (krok 3) a znova spusti:

```bash
sudo bash ~/trader-skill/deploy/install-vps.sh
```

Nastavenia, kľúče, denník obchodov aj pozície ostanú zachované.

## Alternatíva: Docker

Ak radšej používaš Docker:

```bash
cd trader-skill/deploy
cp trader.env.example trader.env     # povinné — docker-compose tento súbor číta
nano trader.env                      # TRADER_DASHBOARD_PASSWORD je pri Dockeri povinné
docker compose up -d --build
docker compose logs -f autopilot
```

Nástenka je potom na `127.0.0.1:8765` servera (otváraš ju rovnako cez SSH tunel). Aj tu môže
`docker compose stop` alebo `restart` trvať až dve minúty, kým robot dokončí cyklus.

## Bezpečnosť v skratke

* Súbor s kľúčmi (`/etc/trader/trader.env` alebo `deploy/trader.env`) nikomu neposielaj, nedávaj do
  gitu ani nikam nevkladaj. Do gitu patrí len `trader.env.example`.
* Port 8765 na firewalle nikdy neotváraj — nástenka ide len cez SSH tunel alebo HTTPS s heslom.
* Robot beží ako obyčajný používateľ `trader` a môže zapisovať len do `/var/lib/trader`.
* Nástenka nikdy neukáže hodnotu kľúča — len „set / not set“.
