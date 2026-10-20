# UI-Szenarien in echtem Chromium

Steuern die App im Vite-Dev-Server (Test-Brücken gibt es nur dort) über das
Chrome DevTools Protocol in `chrome-headless-shell` (Playwright-Cache, oder
`CHROME=/pfad/zum/binary`). Keine zusätzlichen Abhängigkeiten.

```bash
tests/ui/run.sh tests/ui/self.mjs                          # abSelfTest() mit echtem OPFS
LANG_UI=de tests/ui/run.sh tests/ui/journeys.mjs            # 8 Nutzerwege inkl. Fehlerfälle
LANG_UI=en THEME=light W=760 H=520 tests/ui/run.sh tests/ui/journeys.mjs
LANG_UI=de tests/ui/run.sh tests/ui/flow.mjs                # Backup, Abbruch, falsche Passphrase, Restore-Rückfrage
LANG_UI=en tests/ui/run.sh tests/ui/archive.mjs             # Archiv-Modus (?fallback): .tar, kaputte Archive, Umbenennungen
tests/ui/run.sh tests/ui/base.mjs                           # nur Screenshots (Tutorial, Aufgabe, Restore, Hilfe)
```

Exit-Code 0 = alle `check()` bestanden. Screenshots: `testdata-out/ui/`
(gitignored, Ort per `AB_UI_OUT`).

Was simuliert wird: Der native Ordner-Dialog ist durch einen Stub ersetzt, der
OPFS-Ordner zurückgibt oder wie beim Abbrechen `AbortError` wirft. Fehlerfälle
werden an den Prototypen der File System Access API eingespeist (echte Handles
bleiben erhalten): volles Laufwerk = `QuotaExceededError` beim Schreiben,
schreibgeschützter/verweigerter Ordner = `requestPermission() → 'denied'`,
gesperrte Datei = `NoModificationAllowedError` beim `close()`. Welche
`DOMException` Chrome auf echtem Windows/macOS tatsächlich liefert, lässt sich
nur dort prüfen (siehe `AUDIT-1.0.md`).

Ports: Dev-Server 5794, DevTools 9494 — beide müssen frei sein.
