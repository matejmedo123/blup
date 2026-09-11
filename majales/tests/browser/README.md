# Prehliadačové scenáre

Overujú, čo sa nedá skontrolovať zo servera: kliknutia, modály, odpočet,
nahrávanie fotiek, oprávnenia a správanie na telefóne.

```bash
# v jednom okne
bash scripts/dev-server.sh

# v druhom
npx playwright install chromium   # prvýkrát
bash tests/run-browser.sh
```

Skript pred spustením vráti vývojovú inštanciu do východiskového stavu
a doplní zástupné fotky, takže scenáre začínajú vždy rovnako.
