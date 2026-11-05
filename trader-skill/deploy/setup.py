#!/usr/bin/env python3
"""Sprievodca nastavením pre zákazníka: heslo k prehľadu, licencia, kľúč k Bybitu, riziko a upozornenia — bez úprav
súborov. Spúšťa sa ako root cez ``sudo traderctl setup`` po install-vps.sh. Stdlib only.

Tajné hodnoty (heslo, kľúče) idú len do /etc/trader/trader.env (0600) a nikdy sa nevypíšu. Nastavenia bota zapisuje
bot sám (``autopilot.py profile`` pod používateľom trader), aby jeho súbory patrili jemu. Ostrý účet sa nezapne
sám: treba licenciu, živé kľúče a vlastnoručne napísať potvrdenie rizika.
"""
from __future__ import annotations

import getpass
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

PREFIX = Path(os.environ.get("TRADER_PREFIX", "/opt/trader"))
DATA = Path(os.environ.get("TRADER_DATA", "/var/lib/trader"))
ENV = Path(os.environ.get("TRADER_ENV_FILE", "/etc/trader/trader.env"))
CONFIRM = "I ACCEPT REAL MONEY RISK"
KEY_LINE = re.compile(r"^([A-Z0-9_]+)=")


def set_env(path: Path, values: dict) -> None:
    """Set KEY=value lines in the settings file, keep every other line, 0600 the whole time."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    done = set()
    for i, line in enumerate(lines):
        m = KEY_LINE.match(line)
        if m and m.group(1) in values:
            lines[i] = "%s=%s" % (m.group(1), values[m.group(1)])
            done.add(m.group(1))
    lines += ["%s=%s" % (k, v) for k, v in values.items() if k not in done]
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.replace(str(tmp), str(path))


def get_env(path: Path, key: str) -> str:
    if not path.exists():
        return ""
    for line in path.read_text(encoding="utf-8").splitlines():
        m = KEY_LINE.match(line)
        if m and m.group(1) == key:
            return line.split("=", 1)[1].strip()
    return ""


def update_config(changes: dict, run=subprocess.run) -> None:
    """Merge changes into the bot's config.json and hand the file back to the bot's user."""
    cfg = DATA / "config.json"
    doc = json.loads(cfg.read_text(encoding="utf-8")) if cfg.exists() else {}
    for k, v in changes.items():
        if isinstance(v, dict) and isinstance(doc.get(k), dict):
            doc[k].update(v)
        else:
            doc[k] = v
    tmp = cfg.with_name("config.json.tmp")
    tmp.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    os.replace(str(tmp), str(cfg))
    run(["chown", "trader:trader", str(cfg)])


class Wizard:
    def __init__(self, ask=input, secret=getpass.getpass, out=print, run=subprocess.run):
        self.ask, self.secret, self.out, self.run_cmd = ask, secret, out, run

    def yes(self, q: str, default: bool = False) -> bool:
        a = self.ask("%s [%s] " % (q, "Á/n" if default else "a/N")).strip().lower()
        return default if not a else a in ("a", "á", "ano", "áno", "y", "yes")

    def number(self, q: str, default: float, lo: float, hi: float) -> float:
        while True:
            a = self.ask("%s [%g] " % (q, default)).strip().replace(",", ".")
            if not a:
                return default
            try:
                v = float(a)
            except ValueError:
                self.out("  Napíš číslo, napríklad %g." % default)
                continue
            if lo <= v <= hi:
                return v
            self.out("  Musí byť od %g do %g." % (lo, hi))

    def bot(self, *args, stdin: str = None):
        """The bot's own command, as its own user, so the files it writes stay its own."""
        cmd = ["runuser", "-u", "trader", "--", "python3", str(PREFIX / "trader-autopilot" / "autopilot.py")] + \
            list(args) + ["--home", str(DATA)]
        return self.run_cmd(cmd, input=stdin, text=True, capture_output=True)

    # ------------------------------------------------------------------ the steps
    def password(self) -> None:
        self.out("\n1/5 Heslo k prehľadu (webová stránka bota)")
        if get_env(ENV, "TRADER_DASHBOARD_PASSWORD") and not self.yes("Heslo už je nastavené. Zmeniť ho?"):
            return
        pw = self.secret("  Nové heslo (Enter = vymyslím silné heslo za teba): ").strip()
        if not pw:
            pw = secrets.token_urlsafe(14)
            self.out("  Tvoje heslo: %s   ← zapíš si ho, ukážem ho len raz" % pw)
        elif len(pw) < 10:
            pw = secrets.token_urlsafe(14)
            self.out("  Príliš krátke, vymyslel som silnejšie: %s   ← zapíš si ho" % pw)
        set_env(ENV, {"TRADER_DASHBOARD_PASSWORD": pw})

    def licence(self) -> bool:
        self.out("\n2/5 Licencia (bez nej beží simulátor zadarmo)")
        path = self.ask("  Cesta k súboru s licenciou (Enter = preskočiť): ").strip()
        if path:
            try:
                raw = Path(path).expanduser().read_text(encoding="utf-8")
            except OSError as exc:
                self.out("  Súbor sa nedá prečítať: %s" % exc)
                raw = ""
            if raw:
                r = self.bot("license", "--install", "-", stdin=raw)
                self.out("  " + ((r.stdout or "").splitlines() or [""])[0] if r.returncode == 0 else
                         "  Licencia odmietnutá: %s" % (r.stderr or "").strip())
        r = self.bot("license", "--json")
        try:
            st = json.loads(r.stdout or "{}")
        except ValueError:
            st = {}
        return bool(st.get("valid"))

    def bybit(self, licensed: bool) -> bool:
        self.out("\n3/5 Bybit (www.bybit.eu → API → nový kľúč: iba čítanie a obchodovanie, BEZ výberu)")
        if not licensed:
            self.out("  Bez licencie bot obchoduje len na simulátore — kľúč môžeš pridať neskôr.")
        if not self.yes("  Chceš teraz pridať kľúč k Bybitu?"):
            return bool(get_env(ENV, "BYBIT_LIVE_KEY"))
        key = self.secret("  API Key: ").strip()
        sec = self.secret("  API Secret: ").strip()
        if not key or not sec:
            self.out("  Prázdne — preskakujem.")
            return False
        set_env(ENV, {"BYBIT_LIVE_KEY": key, "BYBIT_LIVE_SECRET": sec})
        self.out("  Uložené (%s…%s). Overenie: sudo traderctl broker-test --live-keys" % (key[:4], key[-4:]))
        return True

    def profile(self, licensed: bool) -> None:
        self.out("\n4/5 Riziko")
        capital = self.number("  Koľko peňazí má bot spravovať (USD)?", 1000, 100, 10_000_000)
        risk = self.number("  Riziko na jeden obchod v %?", 2, 0.25, 5)
        args = ["profile", "--write", "--capital", "%g" % capital, "--risk", "%g" % risk, "--venue", "bybit",
                "--fixed-risk"]
        if licensed and self.yes("  Použiť páku 1,5× (len plán Pro/Max)?"):
            args += ["--leverage", "1.5"]
        r = self.bot(*args)
        self.out("  Nastavené." if r.returncode == 0 else "  Nastavenie zlyhalo: %s" % (r.stderr or r.stdout).strip()[:300])

    def notifications(self) -> None:
        self.out("\n5/5 Upozornenia na mobil")
        if not self.yes("  Chceš upozornenia cez Telegram?"):
            return
        token = self.secret("  Token bota od @BotFather: ").strip()
        chat = self.ask("  Tvoje chat ID (napíš botovi @userinfobot): ").strip()
        if token and chat:
            set_env(ENV, {"TELEGRAM_BOT_TOKEN": token, "TELEGRAM_CHAT_ID": chat})
            update_config({"notify": {"enabled": True, "telegram": True}}, self.run_cmd)
            self.out("  Zapnuté. Skúška: sudo traderctl notify-test")

    def live(self, licensed: bool, has_keys: bool) -> None:
        if not (licensed and has_keys):
            return
        self.out("\nOstrý účet: bot bude obchodovať so skutočnými peniazmi na Bybite.")
        a = self.ask('  Ak to naozaj chceš, napíš presne "%s" (Enter = zostať na simulátore): ' % CONFIRM).strip()
        if a != CONFIRM:
            self.out("  Zostávam na simulátore. Zapneš to neskôr: sudo traderctl setup")
            return
        # the five live steps, each one the person chose here: broker, mode, paper, keys (step 3), the phrase
        update_config({"paper": False, "autopilot": {"broker": "bybit", "mode": "live", "live_confirmation": CONFIRM}},
                      self.run_cmd)
        r = self.bot("check-live")
        self.out("  " + ((r.stdout or "").strip().splitlines() or ["(skontroluj: sudo traderctl check-live)"])[0])

    def run(self) -> int:
        self.out("Trader · nastavenie. Každý krok môžeš preskočiť Enterom a spustiť sprievodcu neskôr znova.")
        self.password()
        licensed = self.licence()
        keys = self.bybit(licensed)
        self.profile(licensed)
        self.notifications()
        self.live(licensed, keys)
        self.run_cmd(["systemctl", "restart", "trader-autopilot", "trader-dashboard"])
        self.out("\nHotovo. Bot beží. Stav: sudo traderctl status · prehľad: tvoja doména alebo SSH tunel na port 8765.")
        return 0


def main() -> int:
    if os.geteuid() != 0:
        print("Spusti ako root: sudo traderctl setup", file=sys.stderr)
        return 1
    if not ENV.exists():
        print("Trader ešte nie je nainštalovaný — najprv: sudo bash %s/deploy/install-vps.sh" % PREFIX, file=sys.stderr)
        return 1
    try:
        return Wizard().run()
    except (KeyboardInterrupt, EOFError):
        print("\nPrerušené — nič ďalšie sa nezmenilo. Spusti znova: sudo traderctl setup")
        return 1


if __name__ == "__main__":
    sys.exit(main())
