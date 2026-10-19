# all/backed 1.0 — Audit, Tests, Checkliste

Stand: 2026-10-19 · Basis: `1065bfb` · Ziel: Release 1.0.0 (Chrome + Firefox, MV3)

all/backed ist eine Browser-Extension (keine Tauri-App): Die ganze App läuft als
Tab-Seite `index.html`, der Hintergrund-Skript `sw.js` öffnet/fokussiert nur
diesen Tab. Laufzeit-Abhängigkeiten: nur `react` und `react-dom`. Keine
Netzwerkzugriffe, keine Host-Permissions, Permissions: `storage`,
`unlimitedStorage`.

## 1. Testumgebung — was wirklich ausgeführt wurde

| Weg | Was | Ergebnis |
| --- | --- | --- |
| `pnpm test` | Engine-Selbsttest (`src/engine/selftest.ts`) unter Node 22 gegen `scripts/memfs.mjs` (In-Memory-File-System-Access-API mit Chromium-Semantik: verbotene Namen `..`/`/`/`\` → TypeError, `close()` atomar, `abort()` verwirft) | PASS (9 Basis-Schritte + R1–R8) |
| `pnpm typecheck` / `pnpm build` / `pnpm build:firefox` | TypeScript strict, Vite-Build beider Varianten | fehlerfrei |
| Build-Inspektion | `dist/index.html` ohne Inline-Skripte (MV3-CSP-tauglich), Test-Brücken (`abSelfTest`, `ab:test:*`, `/__abtest`) nicht im Produktions-Bundle | geprüft |
| SSR-Smoke-Render (Scratch) | `App`, `TaskView` (normal + fehlgeschlagener letzter Lauf), `RestoreView`, `Help` per `react-dom/server` in EN und DE gerendert | ohne Fehler, Wortmarke + Fehlerkarte vorhanden |
| `sw.js` mit Mock-API (Scratch) | 4 Szenarien: App-Tab vorhanden → fokussieren; keiner → neu; URL-Filter ignoriert/fremde Tabs → neu (nie fremden Tab fokussieren); `tabs.query` wirft → neu | alle korrekt |
| Tar-Interop (Scratch) | eigenes Archiv mit 289-Byte-Pfad + Umlauten → macOS `tar -xf` (bsdtar) entpackt vollständig; bsdtar-Archiv mit Pax-Langpfad → eigener Reader liest korrekt | beide Richtungen OK |
| i18n-Abgleich (Skript) | Schlüsselmengen EN/DE identisch | OK |

**Nicht automatisiert ausführbar in dieser Umgebung:** echter Browser. Headless
Chrome/Firefox lässt die Sandbox nicht starten, die Chrome-Erweiterung zur
Fernsteuerung war nicht verbunden. Native Ordner-Dialoge, Berechtigungs-
Prompts, Drag & Drop, Downloads und das Toolbar-Icon sind deshalb nur statisch
geprüft → manuelle Checkliste in Abschnitt 5. Der Browser-Selbsttest
(`await window.abSelfTest()` im Dev-Server) enthält dieselben Fälle und sollte
einmal in Chrome und Firefox laufen.

## 2. Feature-Inventar mit Teststatus

Legende: **T** = automatisiert getestet · **S** = statisch geprüft (Code-Pfad
gelesen, Typen geprüft, gerendert) · **M** = manuell in der Checkliste

| Bereich | Feature | Status |
| --- | --- | --- |
| Aufgaben | Anlegen (F2, „+ Neue Aufgabe"), Umbenennen, Löschen (F8/Knopf, Doppelklick-Bestätigung, während Lauf gesperrt), Persistenz in IndexedDB inkl. Migration `source`→`sources` | S, M |
| Quellen | Ordner-Picker (Chrome), `webkitdirectory` (Firefox/Safari), Drag & Drop (Handles bzw. `webkitGetAsEntry`), Mischquellen, Entfernen, Datei-/Größenstatistik, Duplikat-Sperre (`isSameEntry`) | Engine T (R4), UI S/M |
| Quellen | Gleichnamige Quellen → „Name (2)", identische Pfade → Suffix | T (R4) |
| Ziel | Ordner-Picker readwrite (Chrome); Archiv-Modus OPFS + `.tar`-Download (Firefox/Safari, `?fallback`) | Engine T, UI M |
| Backup | Scan, 4-MiB-Chunks, SHA-256-Dedup (innerhalb/zwischen Läufen/über Quellen), gzip, AES-256-GCM, Fortschritt/Terminal-Log, Banner, letzter Lauf, Status-Punkt (grün/rot/Ring) | T (Basis, R1), UI S |
| Backup | Passphrase-Prüfung vor dem Schreiben bei Folge-Läufen | T (R2) |
| Backup | Aufgabe umbenennen → gleiches Repository (`repoSlug`) | T (R3) |
| Backup | Verify-Stichprobe (5 eindeutige Blöcke) vor dem Manifest | T (R1, R6) |
| Backup | Speicher-Vorprüfung im Archiv-Modus (`storage.estimate`) | S |
| Backup | Fehlgeschlagener Lauf wird als rot + Grund gespeichert | S (Smoke-Render) |
| Restore | Repos finden (Ordner selbst / `allbacked/*` / `allbacked`-Ordner), Label aus `ab-repo.json`, Passphrase-Abfrage + Sofortprüfung, Versionsliste, Restore in Zielordner | T (Basis), UI S/M |
| Restore | Archiv-Modus: `.tar`-Import → Restore → `restored-<datum>.tar` | T (Tar-Roundtrip), UI M |
| Restore | Prüfsummen-Check je Block, Größen-Check je Datei, defekte Datei wird übersprungen + gelistet, keine Halb-Dateien, bestehende Datei bleibt bei Fehler unverändert | T (R6) |
| Restore | Pfad-Validierung (kein `..`, `/abs`, `C:`, `\`, leere Segmente) | T (R5) |
| Tar | ustar + Pax (lange/mehrbyteige Pfade, Dateien ≥ 8 GiB), GNU-`L`-Langnamen lesen, Prüfsummen-/Trunkierungs-Erkennung, Zip-Slip-Schutz | T (R8 + Interop) |
| Hilfe | Tutorial (6 Schritte, ←/→, Esc), Handbuch mit Suche, DE/EN-Umschalter im Kopf, F1/?-Knopf/F-Leiste | S (Render), M |
| Darstellung | EN/DE-Umschalter (persistiert), Dunkel/Hell-Umschalter (persistiert, vor erstem Render gesetzt) | S, M |
| Tasten | F1 Hilfe, F2 neu, F5 Backup, F6 Restore, F8 löschen | S, M |
| Extension | Toolbar-Klick öffnet/fokussiert App-Tab | T (Mock), M |
| Aufräumen | OPFS-Scratch (`restore-import`, `restore-out`) wird beim App-Start gelöscht, Web-Lock schützt laufenden Restore in anderem Tab | S |

## 3. Behobene Fehler (Funktion)

| # | Schwere | Fehler | Fix |
| --- | --- | --- | --- |
| F1 | hoch | **Endlosschleife/Tab-Freeze** im Verify, sobald Dateien Blöcke teilen (z. B. zwei leere oder zwei gleiche Dateien bei < 5 eindeutigen Blöcken). Synchrone `while`-Schleife — Tab hängt dauerhaft. Mit altem Code reproduziert. | Stichprobe aus eindeutigen Blöcken (Fisher-Yates) — R1 |
| F2 | hoch | Falsche Passphrase bei einem **Folge-Backup** wurde nicht erkannt: neue Blöcke mit anderem Schlüssel → Repository mit zwei Schlüsseln, nicht mehr vollständig wiederherstellbar | Passphrase wird vor dem Schreiben gegen das neueste Manifest (bzw. einen Block) geprüft — R2 |
| F3 | mittel | Umbenennen einer Aufgabe legte ein **neues Repository** an (Dedup weg, Versionen verteilt) | `repoSlug` wird beim ersten erfolgreichen Lauf festgeschrieben — R3 |
| F4 | mittel | Zwei Quellen gleichen Namens (z. B. zweimal „Dokumente") **überschrieben sich** beim Restore; gleicher Ordner doppelt → doppelt gesichert | Eindeutige Wurzelnamen „Name (2)", `isSameEntry`-Duplikatsperre (Engine + UI) — R4 |
| F5 | mittel | Restore-Fehler mitten in einer Datei schrieb eine **halbe Datei** (`close()` im `finally`) und brach den ganzen Restore ab | `abort()` statt `close()`, neu angelegte Datei wird entfernt, übrige Dateien werden weiter hergestellt, Fehlerliste in der UI — R6 |
| F6 | mittel | Verify lief **nach** dem Manifest: ein fehlgeschlagener Lauf hinterließ eine kaputte Version in der Liste | Verify vor `writeManifest` |
| F7 | mittel | Archiv-Modus-Restore scheiterte komplett bei Pfaden > 255 Byte, Dateinamen > 100 Byte (auch Umlaut-Namen nach Byte-Länge) oder Dateien ≥ 8 GiB (`tar field overflow`) | Pax-Header beim Schreiben, Pax/GNU-L beim Lesen — R8 + Interop |
| F8 | mittel | Fehlgeschlagene Läufe wurden nie gespeichert — Status-Punkt „rot" (laut Handbuch) trat nie auf | Fehllauf mit Grund als `lastRun` gespeichert, Karte „Letzter Lauf" zeigt ihn |
| F9 | niedrig | Engine-Fehler (`repo-unencrypted`, `verify-failed`, `permission-denied`, …) erschienen als englischer Rohtext | `src/errors.ts` mappt alle Codes und DOMExceptions (Quota, NotAllowed, NotFound, NotReadable) auf DE/EN |
| F10 | niedrig | Toolbar-Klick konnte ohne `tabs`-Permission theoretisch einen **fremden Tab** fokussieren (URL-Filter ignoriert) bzw. bei abgelehntem Muster nichts tun | Treffer nur bei sichtbar eigener URL, sonst neuer Tab; `try/catch` |
| F11 | niedrig | Quellen-Statistik blieb nach Browser-Neustart ewig auf „scanne…" | Hinweis „Zugriff wird beim nächsten Lauf angefragt", Neuberechnung nach dem Lauf |
| F12 | niedrig | Während eines Laufs ließen sich Name ändern (wurde beim Abschluss zurückgesetzt) und die Aufgabe löschen | Name/Löschen während des Laufs gesperrt |
| F13 | niedrig | Ungültiges/abgeschnittenes `.tar` beim Restore-Import wurde stillschweigend teilweise gelesen | Header-Prüfsumme, Oktal-Prüfung, End-Marker-Pflicht — R8 |
| F14 | niedrig | Wortmarke „all backed." statt „all/backed." (Punkt neutral, Styleguide) | Sidebar, Hilfe-Kopf, Texte, `_locales` |

## 4. Sicherheits-Audit

| # | Schwere | Befund | Status |
| --- | --- | --- | --- |
| S1 | hoch | = F2: Schlüssel-Mischung im Repository durch falsche Passphrase bei Folge-Lauf | **behoben** |
| S2 | mittel | Restore vertraute dem Manifest: Pfade mit `..`, absolute/Laufwerks-Pfade, Backslashes, ungültige Hashes. (Die FS-Access-API lehnt `..` als Namen selbst ab — praktisch also kein Ausbruch, aber undefiniertes Verhalten.) | **behoben**: `validateManifest` + `safeRelativePath` vor jedem Schreibzugriff — R5 |
| S3 | mittel | Unverschlüsseltes Repository: getauschter/manipulierter Block wurde beim Restore ungeprüft geschrieben | **behoben**: SHA-256 je Block gegen Blocknamen, Größenprüfung je Datei — R6 |
| S4 | mittel | Verschlüsseltes Repository: eingeschleustes **Klartext-Manifest** wurde akzeptiert (Dateiliste fälschbar ohne Passphrase) | **behoben**: im verschlüsselten Repo nur `.enc`-Manifeste — R7 |
| S5 | mittel | `ab-repo.json` (Klartext) ungeprüft: absurde KDF-Iterationen → Hänger; kaputtes JSON → Absturz | **behoben**: `parseRepoConfig` (Format, Typen, 1 ≤ Iterationen ≤ 10 Mio., Salt-Format) — R7. Eine *Absenkung* der Iterationen durch einen Angreifer mit Schreibzugriff führt zu einem anderen Schlüssel und wird durch S1 erkannt |
| S6 | mittel | Archiv-Modus: entschlüsselte Restore-Daten blieben unbegrenzt in OPFS (Browser-Speicher) liegen | **behoben**: Löschen beim nächsten App-Start, Web-Lock gegen Löschen während eines Restores in einem zweiten Tab |
| S7 | niedrig | PBKDF2 mit 310 000 Iterationen (unter aktueller OWASP-Empfehlung 600 000) | **behoben** für neue Repositories (600 000); bestehende behalten ihren gespeicherten Wert (Format-kompatibel) |
| S8 | niedrig | Tar-Import: Zip-Slip | war bereits gefiltert; zusätzlich `\` als Trenner und Laufwerksbuchstaben — R8 |
| S9 | info | CSP: Standard-MV3-CSP (`script-src 'self'`), Build ohne Inline-Skripte, kein `eval`, kein `dangerouslySetInnerHTML`, alle Texte über React escaped | OK |
| S10 | info | Permissions minimal (`storage`, `unlimitedStorage`), keine Host-Permissions, keine Netzwerkzugriffe; Firefox-Manifest deklariert `data_collection_permissions: none` (AMO-Pflicht seit 2025) | OK |
| S11 | info | Passphrase nur im React-State, nie in IndexedDB/localStorage, nie geloggt; localStorage enthält nur Sprache, Theme, Tutorial-Flag | OK |
| S12 | info | AES-GCM mit zufälligem 96-Bit-IV je Block/Manifest (keine Nonce-Wiederverwendung), Schlüssel nicht extrahierbar | OK |
| S13 | offen (dokumentiert) | Blocknamen = SHA-256 des Klartext-Chunks → Wer das Ziel-Laufwerk sieht, kann prüfen, ob eine *bekannte* Datei (≤ 4 MiB-Chunks) im Backup liegt. Fix (keyed hashes) ändert das Repository-Format → bewusst nach 1.0 (Plan-Doc) |
| S14 | offen (dokumentiert) | `ab-repo.json` und Manifest-Zeitstempel/Anzahl liegen im Klartext (Metadaten) | Format-Thema, wie S13 |
| S15 | offen (dev-only) | `pnpm audit`: vite ≤ 6.4.2 (2× hoch: `server.fs.deny`-Bypass unter Windows, 2× mittel), esbuild ≤ 0.24.2, braces, postcss-selector-parser — **nur Dev-Server/Build**, nichts davon landet in der Extension. Fix erfordert Vite 6/7 (Major) → nicht im Rahmen „nur Patch/Minor". `source-map-js` auf 1.2.2 gehoben. Empfehlung: Dev-Server nie mit `--host` betreiben; Vite-Major-Upgrade nach 1.0 |

Keine neuen Abhängigkeiten. Testinfrastruktur nutzt nur vorhandenes Vite + Node.

## 5. Bekannte Grenzen

- Gesichert werden Dateiinhalte mit relativem Pfad — **keine leeren Ordner,
  Dateirechte, Änderungszeiten, Symlinks** (FS-Access-API bietet sie nicht).
- Restore **überschreibt** gleichnamige Dateien im Zielordner (leeren Ordner
  wählen). Dateinamen, die das Ziel-Dateisystem verbietet (z. B. `a:b.txt`,
  `CON` unter Windows), werden übersprungen und gelistet.
- Zwei Aufgaben mit gleichem Namen und gleichem Ziel teilen sich den
  Repository-Ordner: gleiche Passphrase → gemeinsame Versionsliste; andere
  Passphrase → Lauf wird abgewiesen (kein Datenverlust).
- Linux-Quellen mit Dateien, die sich nur in Groß-/Kleinschreibung
  unterscheiden, erhalten im Backup ein „(2)"-Suffix (sonst Kollision auf
  macOS/Windows).
- Archiv-Modus (Firefox/Safari): Backup-Größe durch Browser-Speicher begrenzt;
  Quellen gelten nur für die Sitzung.
- Nach Browser-Neustart fragt Chrome die Ordnerrechte neu ab; bei mehreren
  Ordnern kann je Ordner eine Rückfrage kommen (ggf. Start erneut klicken).
- Ob Chrome ohne `tabs`-Permission die URL des eigenen App-Tabs liefert, ist
  nicht verifiziert — schlimmstenfalls öffnet der Toolbar-Klick einen zweiten
  App-Tab statt den vorhandenen zu fokussieren (harmlos).
- Kein Zeitplan (Pro).

## 6. Manuelle Testcheckliste (macOS und Windows)

Jeweils in **Chrome** (Direktmodus) und **Firefox** (Archiv-Modus); unter
Windows zusätzlich ein USB-Laufwerk (z. B. `E:\`) als Ziel.

Installation
- [ ] Chrome: `chrome://extensions` → Entwicklermodus → `all-backed-chrome-v1.0.0.zip` entpacken und laden; Version 1.0.0, keine Fehler auf der Erweiterungsseite
- [ ] Firefox: `about:debugging` → Temporäres Add-on → `manifest.json` aus `all-backed-firefox-v1.0.0.zip`; keine Warnungen außer ggf. `data_collection_permissions` bei Firefox < 140
- [ ] Toolbar-Icon öffnet App-Tab; zweiter Klick fokussiert denselben Tab (kein zweiter)
- [ ] Tutorial erscheint beim ersten Start; ←/→/Esc; erscheint danach nicht mehr

Backup (Chrome)
- [ ] F2 → Aufgabe; Name ändern; zwei Ordner per Dialog + einen per Drag & Drop; Dateizahl/Größe erscheinen
- [ ] Gleichen Ordner erneut wählen → Meldung „bereits in der Liste"
- [ ] Ziel auf externem Laufwerk (Windows: Laufwerksbuchstabe, Ordner mit Leerzeichen/Umlauten)
- [ ] Verschlüsselt + Passphrase → Start: Terminal-Log, Banner „Verify OK", Punkt grün
- [ ] Zweiter Lauf: 0 neue Blöcke; Aufgabe umbenennen → dritter Lauf weiter dedupliziert (kein neuer Ordner unter `allbacked/`)
- [ ] Falsche Passphrase im Folge-Lauf → klare Meldung, Punkt rot, Karte „Letzter Lauf" zeigt Grund
- [ ] Verschlüsselung aus bei verschlüsseltem Repo → Meldung „Passphrase erforderlich"
- [ ] Browser neu starten → Quelle zeigt „Zugriff wird beim nächsten Lauf angefragt" → Start → Rechte-Prompts → Lauf OK
- [ ] Laufwerk während des Laufs abziehen → verständliche Meldung, App bleibt bedienbar
- [ ] Datei während des Laufs ändern / in Windows in Office geöffnet (gesperrt) → Meldung „konnte nicht gelesen werden"

Restore (Chrome)
- [ ] F6 → Backup-Ort wählen → Repo gefunden, „verschlüsselt", falsche Passphrase abgelehnt, richtige → Versionen
- [ ] Version in leeren Ordner wiederherstellen → Dateien byte-gleich (macOS: `diff -r`, Windows: `fc /b` oder Explorer-Vergleich), Umlaute korrekt
- [ ] Backup von macOS mit Datei `a:b.txt` unter Windows wiederherstellen → Datei gelistet als übersprungen, Rest vollständig

Archiv-Modus (Firefox, sowie Chrome mit `?fallback`)
- [ ] Ordner wählen (Dialog „Hochladen" — Hinweistext sichtbar) und per Drag & Drop
- [ ] Backup → `allbacked-<name>-<datum>.tar` wird heruntergeladen
- [ ] Restore → `.tar` wählen → Passphrase → Version → `restored-<datum>.tar` → mit System-`tar` bzw. Windows `tar -xf` / 7-Zip entpacken, Inhalt vergleichen
- [ ] Beliebige Nicht-Tar-Datei als Archiv wählen → Meldung statt Absturz
- [ ] App-Tab schließen und neu öffnen → OPFS-Scratch geleert (DevTools → Application/Storage)

Oberfläche
- [ ] EN/DE-Umschaltung übersetzt alles (Banner, Fehler, Hilfe); Wahl bleibt nach Neuladen
- [ ] Hell-/Dunkel-Modus: alle Karten, Banner, Fehlerlisten, Hilfe lesbar; bleibt nach Neuladen
- [ ] F1/F2/F5/F6/F8 (F5 lädt die Seite nicht neu); F8 zweimal zum Löschen; während Lauf gesperrt
- [ ] Wortmarke „all/backed." — Name blau, Punkt weiß (dunkel) bzw. dunkel (hell)
