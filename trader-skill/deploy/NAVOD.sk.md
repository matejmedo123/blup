# Trader 24/7 na vlastnom serveri — celý návod krok za krokom

Robot obchoduje len vtedy, keď beží. Na notebooku to znamená „kým je zapnutý“, na malom serveri v cloude
(VPS) nonstop. Tento návod ťa prevedie všetkým: od prenájmu servera cez prvé spustenie na simulátore až po
ostré peniaze na Bybit EU. Netreba byť programátor, stačí kopírovať príkazy do terminálu.

**Na konci budeš mať:** robota, ktorý beží 24/7 na serveri, nástenku v prehliadači (aj v mobile),
upozornenia na mobil a jasný postup: simulátor → overenie spojenia s Bybit EU → malý ostrý účet.

---

## 0. Čo budeš potrebovať

| Čo | Načo | Cena |
|---|---|---|
| VPS v EÚ, napr. OVHcloud VPS-1 (Ubuntu 24.04, 4 GB RAM) | tu robot beží nonstop | ~5–6 € / mesiac s DPH |
| Prístup ku kódu na GitHube (`matejmedo123/blup`) | stiahnutie robota na server | zadarmo |
| Mobilná aplikácia **ntfy** | upozornenia na mobil | zadarmo |
| Účet na **bybit.eu** | najprv overenie spojenia kľúčom len na čítanie, potom ostrý účet | zadarmo |
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

* **Server musí byť v EÚ** (Nemecko, Poľsko, Francúzsko, Rakúsko…) — Bybit blokuje servery z USA. Nie Londýn:
  Bybit Spojené kráľovstvo obmedzuje.
* Aspoň **2 GB RAM**, ideálne 4 GB (backtest laboratórium raz týždenne potrebuje pár stoviek MB), systém **Ubuntu 24.04**.
* **Bežný webhosting (ako má web ENZO) nestačí** — nedovolí, aby program bežal nepretržite.

| Poskytovateľ | Plán | Cena (bez DPH, október 2026) | Poznámka |
|---|---|---|---|
| **OVHcloud** (odporúčam) | VPS-1: 2 vCore, 4 GB RAM, 40 GB | od ~4,5 € / mes. | bez viazanosti, Frankfurt / Varšava / Francúzsko |
| netcup | VPS 500: 2 vCore, 4 GB RAM, 64 GB | ~8,3 € / mes. (12 mes.) | dátové centrum aj vo Viedni |
| Websupport | Linux VPS, vlastná konfigurácia (zvoľ 2 vCPU, 2–4 GB RAM, ~30 GB) | od 9,90 € / mes. (pri ročnej platbe) | slovenské dátové centrum a podpora, 7 dní na skúšku; Starter s 1 GB RAM je na robota málo |
| Hetzner Cloud | CX23 | od 5,99 € / mes. | lacné servery sú teraz vypredané, noví zákazníci ich často nevytvoria |

Ceny sa v roku 2026 viackrát menili — presnú cenu uvidíš pri objednávke.

### Objednávka na OVHcloud krok za krokom

1. Na **www.ovhcloud.com** choď na *Bare Metal Cloud → Virtual Private Servers* (alebo vyhľadaj „VPS“).
2. Pri pláne **VPS-1** klikni *Configure* / *Objednať*.
3. Obdobie: *No commitment* (mesačne, bez viazanosti).
4. Lokalita: **Frankfurt** alebo **Varšava** (prípadne Francúzsko).
5. Obraz: *Distribution only → Ubuntu → 24.04*.
6. SSH kľúč môžeš preskočiť, doplnkové služby nechaj vypnuté → *Continue*.
7. *Create an account*: e-mail, heslo, fyzická osoba, adresa, krajina Slovensko, telefón.
8. Platba kartou alebo PayPalom, odsúhlas podmienky.
9. Počkaj na e-mail „Your VPS is ready“ (zvyčajne do hodiny). Nájdeš v ňom **IP adresu**, používateľa
   **`ubuntu`** a odkaz na **dočasné heslo**.

## 3. Pripoj sa na server

**Z počítača:** na Windows stlač Win, napíš *PowerShell* a otvor ho; na Macu Cmd+Medzerník → *Terminal*. Potom
(IP nahraď svojou):

```bash
ssh ubuntu@203.0.113.10
```

* Na otázku „Are you sure you want to continue connecting?“ napíš `yes`.
* Vlož dočasné heslo z e-mailu (pri písaní ho nevidno). Server ťa vyzve na zmenu: znova dočasné heslo, potom
  dvakrát nové. Spojenie sa zavrie — pripoj sa znova, už novým heslom.
* Pri netcupe alebo Hetzneri býva používateľ `root` — vtedy píš `ssh root@…`.

**Len z mobilu:** aplikácia **Termius** (iPhone aj Android) → *+* → *New Host* → Address = IP, Username = `ubuntu`,
Password = dočasné heslo → uložiť → ťuknúť a zmeniť heslo ako vyššie.

Hneď aktualizuj systém, nainštaluj git a zapni firewall (otvorené zostane len SSH). Ak sa `sudo` spýta heslo,
zadaj svoje nové:

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y git ufw
sudo ufw allow OpenSSH
sudo ufw enable
```

**netcup a iné servery s Debianom, kde si prihlásený ako `root`:** `sudo` ani firewall tam ešte nie sú. Ak ti
po prihlásení vypíše *„WARNING! Your environment specifies an invalid locale“* a *„setlocale: LC_CTYPE: cannot
change locale (UTF-8)“*, je to neškodné (Mac posiela svoje nastavenie jazyka, ktoré Linux nepozná). Namiesto
príkazov vyššie vlož tieto — opravia aj to varovanie:

```bash
apt update && apt -y upgrade
apt install -y sudo git ufw
echo 'LANG=C.UTF-8' > /etc/default/locale
sed -i 's/^AcceptEnv/#AcceptEnv/' /etc/ssh/sshd_config
sshd -t && systemctl restart ssh
[ -d /var/lib/cloud/instance ] && touch /var/lib/cloud/instance/locale-check.skip
ufw allow 22/tcp
ufw enable
```

Pri `ufw enable` potvrď `y`. Potom `exit` a pripoj sa znova — varovania zmiznú. Ďalšie kroky fungujú aj pod
`root`, príkazy so `sudo` tiež.

## 4. Stiahni robota na server

Repozitár je na GitHube. Ak je súkromný, GitHub chce namiesto hesla **token**:

1. Na GitHube: ikona vpravo hore → *Settings* → úplne dole *Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token*.
2. *Repository access:* len `matejmedo123/blup`, *Permissions → Contents:* **Read-only**. Platnosť napr. 90 dní.
3. Token si skopíruj (začína `github_pat_…`).

Na serveri:

```bash
cd ~
git clone --depth 1 --branch claude/enzo-burger-website-lc5i0e https://github.com/matejmedo123/blup.git
```

Keď sa spýta: *Username* = tvoje meno na GitHube, *Password* = token (pri vkladaní ho nevidno, to je v poriadku).

> **Bez gitu:** na GitHube prepni na vetvu `claude/enzo-burger-website-lc5i0e`, *Code → Download ZIP*, rozbaľ
> v počítači a nahraj priečinok na server: `scp -r blup-…/trader-skill ubuntu@203.0.113.10:~/` — potom v kroku 5
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
* Chceš popri tom na simulátore skúšať aj vyššie riziko? Na to je porovnávací robot — krok 18.

Reštart alebo zastavenie môže trvať **až 2 minúty** — robot najprv dokončí rozbehnutý cyklus. Nič nevypínaj natvrdo.

---

## 8. Prvé spustenie: backtest laboratórium

Pri prvom štarte robot ešte nemá „playbook“ — zoznam kombinácií mince a stratégie, ktoré obstáli v teste.
**Sám si spustí backtest laboratórium** (stiahne históriu cien a otestuje stratégie). Zvyčajne to trvá
5–30 minút. Kým nedobehne, krypto neobchoduje a v stave uvidíš *„no backtest-lab playbook yet“*.

Potom si laboratórium zopakuje každý týždeň samo, aby sledovalo trh. Výsledok ti príde aj ako upozornenie
(„Backtest lab: N validated“).

Reštart robota (kroky 6 a 7) rozbehnuté laboratórium preruší — pri ďalšom štarte sa spustí znova samo. Ak ho
chceš mať hneď, spusti ho ručne a nechaj okno otvorené, kým nenapíše *Done*:

```bash
sudo traderctl lab
```

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

## 10. Nástenka ako normálna webstránka

Robot má vlastnú webovú stránku — **nástenku** (kapitál, obchody, rozhodnutia, tlačidlá Pause a KILL). Terminál
potrebuješ len pri inštalácii; potom všetko vidíš v prehliadači, v počítači aj v mobile. Nástenka beží na serveri
a z bezpečnosti je najprv zamknutá len pre server samotný. Tu jej dáš **vlastnú adresu s HTTPS a heslom**.

**A) Vlastná adresa, napr. `https://bot.tvojadomena.sk` (odporúčam).** Stačí subdoména domény, ktorú už máš
(napr. tej pre web ENZO), alebo lacná nová doména (~10 € ročne). Zvoľ nenápadný názov, napr. `panel-7k`.

1. Tam, kde máš doménu (napr. admin.websupport.sk → *Domény* → doména → *DNS*), klikni *Pridať záznam*:
   typ **A**, názov = prvá časť adresy (napr. `bot`), hodnota = IP servera. Ulož a počkaj 5–60 minút.
   Názov **nenechávaj prázdny** — prázdny názov je samotná doména (tam beží web) a polovica návštevníkov webu by
   potom skončila na serveri robota. **Existujúce záznamy nemaž ani neprepisuj** (`@`, `www`, `mail`, MX, TXT…) — na nich beží web a e-mail
   domény. Len pridávaš nový. Upravuješ iba záznam s presne tým istým názvom (`bot`), ak už nejaký je.
2. Heslo `TRADER_DASHBOARD_PASSWORD` musí byť nastavené (krok 6). Na serveri (adresu prepíš na svoju):

   ```bash
   sudo apt install -y caddy
   sudo cp /opt/trader/deploy/Caddyfile.example /etc/caddy/Caddyfile
   sudo sed -i 's/trader\.example\.com/bot.tvojadomena.sk/' /etc/caddy/Caddyfile
   sudo ufw allow 80,443/tcp
   sudo systemctl restart trader-dashboard caddy
   ```

3. Otvor **https://bot.tvojadomena.sk** a prihlás sa heslom. V mobile *Pridať na plochu* (iPhone: Safari →
   Zdieľať; Android: Chrome → ⋮) — otvára sa potom ako aplikácia.

Prihlasovaciu stránku môže vidieť ktokoľvek, kto adresu pozná, ale bez hesla neuvidí nič a pokusy o heslo sú
brzdené — preto dlhé heslo. Ostré peniaze sa z nástenky zapnúť nedajú.

**B) Bez domény: Tailscale** (bezplatná súkromná sieť len pre tvoje zariadenia, nástenka nie je na internete):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up              # otvor vypísaný odkaz a prihlás sa (napr. účtom Google)
sudo tailscale serve --bg 8765 # vypíše adresu https://….ts.net (ak najprv odkaz na zapnutie HTTPS, potvrď ho)
```

Do mobilu nainštaluj aplikáciu Tailscale, prihlás sa tým istým účtom a otvor adresu `https://….ts.net`.

**C) Rýchly pohľad bez nastavovania: SSH tunel z počítača.** `ssh -L 8765:127.0.0.1:8765 ubuntu@203.0.113.10`,
a kým je okno otvorené, v prehliadači **http://127.0.0.1:8765**.

Čo na nástenke nájdeš:

* **Overview** — „Is everything OK?“, kapitál, zisky a straty, otvorené pozície, posledné rozhodnutia.
* **Trades** — každý obchod s grafom.
* **Bot** — či žije, každé rozhodnutie s dôvodom, tlačidlá **Pause**, **Run once** a **KILL**.
* **Checks** — či výsledky zodpovedajú backtestu a či dodržal pravidlá.

---

## 11. Upozornenia na mobil

**ntfy (zadarmo, bez registrácie):**

1. Nainštaluj aplikáciu **ntfy**, klikni *+* (Subscribe to topic) a prihlás sa na odber témy s dlhým náhodným
   názvom, napr. `trader-7f3k9q2m8x4v-matej`. Kto názov pozná, môže tvoje upozornenia čítať.
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

### Fáza 2 · Simulátor + overenie spojenia s Bybit EU (aspoň 2–3 týždne)

Bybit EU Demo Trading zatiaľ cez API nepustí k demo účtu: trhové dáta áno, zostatok a príkazy nie (overené
25. 10. 2026 so správnym demo kľúčom na `api-demo.bybit.eu` aj `api-demo.bybit.com`). Preto robot papierovo
obchoduje ďalej na **simulátore** (so skutočnými cenami a nákladmi Bybitu) a spojenie s Bybitom overíš kľúčom
**ostrého** účtu, ktorý vie **len čítať** — nič nekúpi ani nepredá.

1. Na **bybit.eu** v ostrom účte (nie v Demo Trading): profil → **API** → *Create New Key → System-generated*,
   práva **Read-Only**, IP adresa servera. Withdraw ani Transfer nezaškrtávaj.
2. Kľúče daj do `sudo nano /etc/trader/trader.env`:

   ```
   BYBIT_LIVE_KEY=...
   BYBIT_LIVE_SECRET=...
   ```

3. Over spojenie (robot ostáva na simulátore, tento príkaz ho na ostrý účet neprepne):

   ```bash
   sudo traderctl broker-test --live-keys
   ```

   Majú byť štyri ✓ a riadok `✓ key  read only · IP …`. Tým je overené, že robot s Bybit EU správne komunikuje.

Ak by Bybit EU demo cez API neskôr sprístupnil: kľúč z Demo Trading do `BYBIT_DEMO_KEY` / `BYBIT_DEMO_SECRET`,
v `config.json` `"broker": "bybit"` a `sudo traderctl broker-test` (robot skúsi obe demo adresy sám).

### Fáza 3 · Ostrý účet na bybit.eu (začni malou sumou)

1. Účet na **bybit.eu**, overenie totožnosti, vklad v EUR → zmeň na **USDC**.
2. Ak chceš páku 1,5×, zapni na webe alebo v aplikácii **Spot margin** (Bybit chce krátky kvíz). Bez nej
   nastav profil s `--leverage 1` (krok 7).
3. Kľúču z fázy 2 daj na bybit.eu (*API → Edit*) práva **Read-Write** a *Unified Trading → Spot (Trade)*,
   alebo vytvor nový. Vždy **bez práva výberu**, naviazaný na IP servera.
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
sudo chown $USER ~/trader-zaloha-*.tgz
```

Na počítač si ju stiahneš: `scp ubuntu@203.0.113.10:~/trader-zaloha-*.tgz .`
**Záloha obsahuje kľúče** — nikomu ju neposielaj a nedávaj na verejné miesta.

---

## 16. Keď niečo nejde

| Príznak | Čo s tým |
|---|---|
| `ssh` píše „Could not resolve hostname“ | IP je napísaná zle: má presne 4 čísla oddelené bodkou, každé 0–255 (napr. `159.195.240.225`). Skopíruj ju z e-mailu alebo z ovládacieho panela poskytovateľa |
| `ssh` píše „Permission denied“ | zlé heslo alebo používateľ: pri OVH `ubuntu`, pri netcupe `root`; heslo je v e-mailu |
| Po prihlásení „invalid locale“ / „setlocale: LC_CTYPE“ | neškodné; oprava je v časti 3 (netcup / Debian) |
| Konzola v paneli poskytovateľa píše „systemd-ssh-generator … Failed to query local AF_VSOCK CID“ | neškodné hlásenie Debianu 13 (hľadá spojenie, ktoré tento server nemá). Konzolu zavri a pracuj cez `ssh` |
| `sudo: command not found` | Debian ako `root`: najprv `apt update && apt install -y sudo` (časť 3) |
| `ssh` píše „Connection timed out“ | server ešte nebeží alebo je IP zlá — skontroluj ju v e-maile a v ovládacom paneli |
| `health` píše FAIL / „no heartbeat“ | `sudo traderctl logs`, `sudo systemctl status trader-autopilot` |
| v `housekeeping.jsonl` „the lab exited with -15“ alebo „interrupted“ | laboratórium prerušil reštart robota; `sudo traderctl lab` ho spustí hneď |
| „no backtest-lab playbook yet“ | laboratórium ešte beží (časť 8) — počkaj; chybu uvidíš v `housekeeping.jsonl` |
| Robot nič nekupuje | normálne: denné signály prichádzajú raz za deň a nie každý deň. Dôvod každého rozhodnutia je na karte **Bot** |
| Bybit „Unmatched IP“ / 10010 | API kľúč je naviazaný na inú IP — v Bybite nastav IP servera |
| Bybit 10003 / HTTP 401 (neplatný kľúč) | v režime `paper` platia len kľúče vytvorené v **Demo Trading** na bybit.eu (riadky `BYBIT_DEMO_KEY` / `BYBIT_DEMO_SECRET`), nie kľúče ostrého účtu (Bybit EU demo však cez API zatiaľ nefunguje — fáza 2 ide cez `broker-test --live-keys`). Prvý riadok `broker-test` ukáže adresu, kam sa robot pripája. Inak: kľúč a secret prehodené alebo neúplne skopírované. Dĺžky over: `sudo bash -c '. /etc/trader/trader.env; echo ${#BYBIT_DEMO_KEY} ${#BYBIT_DEMO_SECRET}'` (zvyčajne 18 a 36) |
| Bybit 10004 (zlý podpis) | secret je zle skopírovaný |
| Bybit 170359 („not support leveraged“) | tvoj účet nemá spot maržu — zapni ju alebo daj profil s `--leverage 1` |
| Nástenka cez doménu vráti 403 | chýba `TRADER_DASHBOARD_PASSWORD` v `/etc/trader/trader.env`, potom `sudo traderctl restart` |
| Upozornenie „settings file … broken“ | preklep v `config.json` — robot beží so starým platným nastavením; oprav súbor alebo spusti skript znova |
| Málo miesta na disku | pri < 1 GB ťa upozorní, pri < 200 MB neotvára nové obchody (výstupy stráži ďalej) |

---

## 17. Bezpečnosť v skratke

* `/etc/trader/trader.env` a zálohy nikomu neposielaj, nedávaj do gitu ani nikam nevkladaj.
* API kľúče **vždy bez práva výberu** a naviazané na IP servera — aj ukradnutým kľúčom sa peniaze nedajú vybrať.
* Port 8765 na firewalle nikdy neotváraj — nástenka ide len cez HTTPS s heslom (časť 10), Tailscale alebo SSH tunel.
* Robot beží ako obyčajný používateľ `trader` a zapisovať môže len do `/var/lib/trader`.
* Nástenka nikdy neukáže hodnotu kľúča, len „set / not set“. Ostré peniaze sa z nástenky zapnúť nedajú.

---

## 18. Porovnávací robot: iné nastavenie vedľa ostrého

Chceš vidieť, ako by si viedlo vyššie riziko (napr. 3 %, BTC a ETH 4 %, páka 2×), a pritom nemeniť ostrého
robota? Spusti vedľa neho druhého robota, ktorý obchoduje **len na simulátore** — na tom istom trhu, s tou istou
sumou a s vlastnou nástenkou.

```bash
sudo bash /opt/trader/deploy/test-bot.sh
```

* Predvolené nastavenie: riziko 3 %, BTC a ETH 4 %, páka 2×, náklady Bybitu, rovnaký kapitál a rovnaký
  zoznam overených mincí (playbook) ako hlavný robot. Iné nastavenie, napr.:
  `sudo bash /opt/trader/deploy/test-bot.sh --risk 2 --core-risk 3 --leverage 1`
* **So skutočnými peniazmi nikdy neobchoduje:** má vlastný priečinok `/var/lib/trader-test`, nečíta súbor
  s kľúčmi `/etc/trader/trader.env` a nevidí priečinok ostrého robota. Zo súboru s kľúčmi si skopíruje iba heslo
  k nástenke. Keby jeho nastavenie niekedy ukazovalo na skutočnú burzu, skript ho odmietne spustiť.
* Neposiela upozornenia na mobil, nemá AI desk ani správy z X. Inak má rovnaké pravidlá.

**Porovnanie v termináli:**

```bash
sudo traderctl compare
```

Ukáže oba roboty vedľa seba: nastavenie, výnos od dňa, odkedy bežia oba, celkový výnos, najhorší prepad,
kapitál a obchody. **Hodnoť ich až po 20 a viac uzavretých obchodoch každého** — dovtedy je rozdiel hlavne
náhoda. Pri dennej stratégii to trvá mesiace.

**Jeho nástenka** beží na porte **8766** (hlavná na 8765). Na každej nástenke je pri nadpise štítok, napr.
„Risk 3 % · BTC/ETH 4 % · 2×“, a ten istý text je aj v názve karty prehliadača, takže si ich nepomýliš.

* **Vlastná adresa (ak máš krok 10 A):** pridaj druhý DNS záznam typu **A**, napr. názov `test.bot`, hodnota =
  tá istá IP servera. Po 5–60 minútach (adresu prepíš na svoju):

  ```bash
  printf '\ntest.bot.tvojadomena.sk {\n    encode gzip\n    reverse_proxy 127.0.0.1:8766\n}\n' | sudo tee -a /etc/caddy/Caddyfile
  sudo systemctl reload caddy
  ```

  Otvor **https://test.bot.tvojadomena.sk** — heslo je to isté ako pri hlavnej nástenke.
* **Tailscale (ak máš krok 10 B):** `sudo tailscale serve --bg --https=8443 8766` → adresa `https://….ts.net:8443`.
* **SSH tunel:** `ssh -L 8766:127.0.0.1:8766 ubuntu@203.0.113.10` a v prehliadači **http://127.0.0.1:8766**.

Ostatné príkazy sú rovnaké ako pri hlavnom robotovi, len so slovom `test`:

```bash
sudo traderctl test status
sudo traderctl test health
sudo traderctl test logs
sudo traderctl test pause      # a resume
```

**Iné nastavenie neskôr:** spusti `test-bot.sh` znova s inými číslami. Jeho história však zostane, takže
porovnanie by miešalo dve nastavenia. Pre čisté porovnanie ho najprv odstráň aj so záznamom:

```bash
sudo bash /opt/trader/deploy/test-bot.sh --remove    # zastaví ho, záznam ostane
sudo rm -rf /var/lib/trader-test                     # zmaže aj záznam
```

Pri aktualizácii (krok 14) sa porovnávací robot aktualizuje a reštartuje spolu s hlavným.

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
