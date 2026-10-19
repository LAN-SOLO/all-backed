# all/backed — 1.0

Backup-Tool als Browser-Extension (Chrome + Firefox, MV3). Free-Tier: einfache
lokale Sicherungen auf externe Laufwerke, verschlüsselt und dedupliziert — keine
Systemdateien, keine Cloud, kein Konto. Produktseite:
https://lan-solo.com/de/tools/all-backed/ · Plan: `ALL_BACKED_PLAN.md` im
Website-Repo.

## Entwicklung

```bash
pnpm install
pnpm test             # Engine-Selbsttest unter Node (In-Memory-Dateisystem, inkl. Regressionstests)
pnpm typecheck        # tsc --noEmit
pnpm dev              # App als normale Web-App unter http://localhost:5173
pnpm build            # Type-Check + dist/ (Chrome, entpackte Extension)
pnpm build:firefox    # dist-firefox/ mit Firefox-Manifest
pnpm pack:chrome      # Store-Paket all-backed-chrome-v*.zip
pnpm pack:firefox     # AMO-Paket all-backed-firefox-v*.zip
node scripts/gen-icons.mjs   # Icons neu generieren (public/icons/)
```

Extension laden: `chrome://extensions` → Entwicklermodus → „Entpackte
Erweiterung laden" → `dist/`-Ordner wählen. Firefox: `about:debugging` →
„Temporäres Add-on laden" → `dist-firefox/manifest.json`. Der Toolbar-Button
öffnet die App als Tab.

Engine-Selbsttest ohne Browser: `pnpm test` baut die Engine per Vite (SSR) und
führt `src/engine/selftest.ts` gegen `scripts/memfs.mjs` aus — eine
In-Memory-Nachbildung der File System Access API mit Chromium-Semantik
(unzulässige Namen wie unter Windows, Groß-/Kleinschreibung und NFC/NFD
gleichgesetzt wie bei APFS/NTFS, atomares `close()`, `abort()`). Exit-Code 0 = PASS.

Engine-Selbsttest im Browser (Dev-Server, läuft komplett über OPFS):
Konsole öffnen → `await window.abSelfTest()` — deckt auch die
Firefox-Fallback-Pfade ab (Listen-Quelle, Tar-Roundtrip).
Fallback-UI in Chrome erzwingen: `http://localhost:5173/?fallback`.

Store-Listings (Texte, Grafiken, Privacy-Angaben): `store/chrome-web-store.md`.

## Firefox-Modus (Archiv-Modus)

Firefox bietet keine File System Access API. Dort (Erkennung via
`src/engine/caps.ts`) arbeitet die App im Archiv-Modus:

- Quelle: Ordner-Auswahl per `webkitdirectory`-Input
- Ziel: Repository wird in OPFS aufgebaut (Dedup bleibt über Läufe erhalten)
  und nach jedem Lauf als `.tar` heruntergeladen
- Restore: `.tar`-Archiv einlesen → Version wählen → Ergebnis als
  `restored-*.tar`-Download

Gleiches Repository-Format, gleiche Engine — nur die Ein-/Ausgänge wechseln.

## Architektur (MVP)

- **UI:** React + Tailwind, Task-Modell nach CCC-Vorbild (Quelle → Ziel → Sichern),
  alle Texte zweisprachig (EN/DE) in `src/i18n.ts`; Dunkel-Modus (Standard) und
  Hell-Modus per Umschalter in der Seitenleiste (`src/theme.ts`, Tailwind-Variante `light:`)
- **Engine** (`src/engine/`): File System Access API, Chunking (4 MiB fest),
  SHA-256-Dedup, gzip (CompressionStream), AES-256-GCM (WebCrypto),
  Schlüssel aus Passphrase via PBKDF2-SHA-256 (600k Iterationen für neue
  Repositories, bestehende behalten ihren Wert aus `ab-repo.json`),
  Passphrase-Prüfung gegen vorhandene Daten vor jedem Folge-Lauf,
  Stichproben-Verify vor dem Schreiben des Manifests, Restore aus jeder Version
  mit Prüfsummen-Check je Block und Pfad-Validierung (kein `..`, keine
  absoluten Pfade)
- **Repository-Format v1:** `allbacked/<task>/ab-repo.json` + `blocks/<hh>/<hash>`
  + `manifests/manifest-<ts>.json[.enc]` — selbstbeschreibend, dokumentiert in
  `src/engine/types.ts`

Audit, Testmatrix und manuelle Checkliste für 1.0: `AUDIT-1.0.md`.

## Bewusste Vereinfachungen (Upgrade-Pfad im Plan)

- TypeScript-Engine statt Rust/WASM-Core (Format bleibt stabil, Core austauschbar)
- Fixe Chunk-Größe statt content-defined chunking
- gzip statt zstd, PBKDF2 statt Argon2id
- Block-Dateinamen = Klartext-SHA-256 (Fingerprint-Leak; später keyed hashes)
- Kein Zeitplan (Pro)
- Keine leeren Ordner, Dateirechte oder Änderungszeiten im Restore
- Aufgaben-Ordnername wird beim ersten Lauf festgeschrieben (`repoSlug`);
  ist er schon von einer anderen Aufgabe belegt, wird nummeriert
  (`<name>-2`) — zwei Aufgaben teilen sich nie ein Repository

## Verhalten seit Audit-Runde 2

- Backup und Restore lassen sich mit **[Abbrechen]** stoppen
  (`AbortSignal` in `runBackup`/`runRestore`/`untarToDirectory`): kein Manifest,
  keine halbe Datei; geschriebene Blöcke dedupen den nächsten Lauf.
- Restore legt Zielnamen in der Engine fest (`src/engine/portable.ts`):
  unter Windows/macOS unzulässige Namen (`a:b.txt`, `CON`, `x?`, Punkt/Leerzeichen
  am Ende) → `_`, Kollisionen nach Groß-/Kleinschreibung bzw. NFC/NFD →
  `name (2).ext`; alle Umbenennungen werden gelistet.
- Nicht leerer Restore-Zielordner → Rückfrage mit Inhaltsvorschau; ein Ordner
  innerhalb des Repositories wird als Ziel abgelehnt.
- Block-/Manifest-Schreiben wiederholt bei kurzen Sperren
  (`NoModificationAllowedError`/`InvalidStateError`, z. B. Virenscanner unter
  Windows) bis zu dreimal.
- Fehler werden sprachneutral gespeichert (`errorInfo`) und in der aktuellen
  Sprache angezeigt; `.tar`-Fehler sind übersetzt.
- Download-Namen tragen das lokale Datum (nicht UTC).
