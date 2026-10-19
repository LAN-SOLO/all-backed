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
| F3 | mittel | Umbenennen einer Aufgabe legte ein **neues Repository** an (Dedup weg, Versionen verteilt) | `repoSlug` wird festgeschrieben (seit V3 bereits beim ersten Lauf, kollisionsfrei) — R3 |
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
- Restore **überschreibt** gleichnamige Dateien im Zielordner — seit Runde 2
  erst nach ausdrücklicher Rückfrage (Inhaltsvorschau). Dateinamen, die
  Windows/macOS verbieten (z. B. `a:b.txt`, `CON`), werden seit Runde 2
  umbenannt (`a_b.txt`, `_CON`) und gelistet statt übersprungen.
- ~~Zwei Aufgaben mit gleichem Namen teilen sich den Repository-Ordner~~ —
  seit der Verifikation (V3) bekommt eine Aufgabe beim ersten Lauf einen
  Ordnernamen, den keine andere Aufgabe festgeschrieben hat (`<name>-2`).
  Ausnahme: Zwei Aufgaben aus Vor-1.0-Zeiten, die sich bereits einen Ordner
  teilen — die zuerst laufende behält ihn, die andere startet in `<name>-2`.
- Linux-Quellen mit Dateien, die sich nur in Groß-/Kleinschreibung
  unterscheiden, erhalten im Backup ein „(2)"-Suffix (sonst Kollision auf
  macOS/Windows).
- Archiv-Modus (Firefox/Safari): Backup-Größe durch Browser-Speicher begrenzt;
  Quellen gelten nur für die Sitzung.
- Nach Browser-Neustart fragt Chrome die Ordnerrechte neu ab; bei mehreren
  Ordnern kann je Ordner eine Rückfrage kommen (ggf. Start erneut klicken).
- Toolbar-Klick: Chrome ≥ 116 findet den eigenen App-Tab über
  `runtime.getContexts` (ohne `tabs`-Permission, V6). Firefox und ältere
  Chrome-Versionen nutzen `tabs.query` — liefert der Browser dort keine URL,
  öffnet der Klick schlimmstenfalls einen zweiten App-Tab (harmlos).
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
- [ ] Datei während des Laufs ändern / unter Windows eine in Outlook geöffnete `.pst` oder eine gesperrte Datei sichern → Lauf endet erfolgreich, Banner listet die Datei gelb als „übersprungen“, Karte „Letzter Lauf“ ebenso
- [ ] Windows: Laufwerkswurzel (z. B. `D:\`) als Quelle → nicht lesbare Systemordner werden übersprungen statt den Lauf abzubrechen (falls Chrome die Wurzel überhaupt zulässt)
- [ ] Während eines Laufs: andere Aufgabe, „+ Neue Aufgabe“, „Wiederherstellen“, F2, F6 gesperrt; Tab schließen → Browser fragt nach

Restore (Chrome)
- [ ] F6 → Backup-Ort wählen → Repo gefunden, „verschlüsselt", falsche Passphrase abgelehnt, richtige → Versionen
- [ ] Version in leeren Ordner wiederherstellen → Dateien byte-gleich (macOS: `diff -r`, Windows: `fc /b` oder Explorer-Vergleich), Umlaute korrekt
- [ ] Backup von macOS mit Datei `a:b.txt` unter Windows wiederherstellen → Datei als `a_b.txt` wiederhergestellt und in der gelben Liste „unter anderem Namen“ geführt, Rest vollständig
- [ ] Restore in einen nicht leeren Ordner → Rückfrage mit Inhaltsvorschau; „Abbrechen“ schreibt nichts, „Überschreiben & wiederherstellen“ stellt her
- [ ] Großes Backup / großer Restore → [Abbrechen] im Protokoll: Banner „abgebrochen“ (gelb), keine neue Version, keine halbe Datei im Ziel; nächster Lauf dedupliziert

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

## 7. Verifikation (unabhängige Zweitprüfung, 2026-10-19)

Zweiter Prüfer, Basis `30a26a4`. Ziel: die Aussagen oben widerlegen und
Übersehenes finden.

### 7.1 Was tatsächlich ausgeführt wurde

| Weg | Ergebnis |
| --- | --- |
| `pnpm typecheck` | fehlerfrei |
| `pnpm test` (Node + memfs) | PASS — 9 Basis-Schritte + R1–R8, R10, R11 |
| **Echter Browser:** `await window.abSelfTest()` im Dev-Server, gesteuert per CDP in Playwrights `chrome-headless-shell` (Chromium, echtes OPFS) | PASS — alle Schritte inkl. R10/R11. Damit ist die Behauptung „kein Browser ausführbar“ überholt: Engine und OPFS laufen in echtem Chromium |
| **Echter Browser, UI:** App im Archiv-Modus (`?fallback`): Tutorial schließen, F2, Quelle über `ab:test:add-source` (inkl. einer Datei, deren Snapshot vor dem Lauf veraltet ist), Verschlüsselung aus, F5 | Banner „erfolgreich“, 2 Dateien, gelbe Liste „1 übersprungen — Docs/stale.txt — gesperrt oder beim Lesen geändert“; „Wiederherstellen“ während des Laufs gesperrt, danach wieder frei |
| Chromium-Verhalten nachgemessen | Ein `File` aus `getFile()`, dessen Datei danach gespeichert wird, wirft beim Lesen `NotReadableError`; unzulässige Namen werfen `TypeError: … Name is not allowed.` |
| Negativkontrolle | R10 mit dem alten Lesepfad (Scan-Snapshot) in Chromium: **FAIL** (die geänderte Datei fehlt) — der Test erkennt den Fehler wirklich |
| `sw.js` mit Mock-API (Scratch) | 7/7: eigener Tab über `getContexts`, leere/werfende `getContexts` → Rückfall, fremder Tab nie fokussiert, Tab weg → neuer Tab, `tabId -1` ignoriert |
| SSR-Render (Scratch) | TaskView mit übersprungenen Dateien (EN + DE), RestoreView, Help fehlerfrei; i18n-Schlüssel EN/DE identisch (je 113) |
| `pnpm build` / `pnpm build:firefox` | fehlerfrei; Zips in `.Deploy/main-1.0.0-<sha>-extension/` |

### 7.2 Neu gefundene und behobene Fehler

| # | Schwere | Fehler | Fix |
| --- | --- | --- | --- |
| V1 | hoch | **Eine einzige gesperrte, geänderte oder gelöschte Datei ließ den ganzen Backup-Lauf scheitern.** Der Scan sammelte alle `File`-Snapshots vorab; Chromium wirft `NotReadableError`, sobald eine Datei zwischen Scan und Lesen gespeichert wird (in echtem Chromium nachgemessen). Bei großen Backups ist das fast sicher (Logs, offene Office-/Outlook-Dateien unter Windows); ein nicht lesbarer Unterordner (Laufwerkswurzel unter Windows) brach ebenfalls alles ab | Handle-Quellen öffnen die Datei direkt vor dem Lesen neu (geänderte Datei wird im neuen Stand gesichert). Gesperrte/verschwundene Dateien und nicht lesbare Unterordner werden übersprungen und mit Grund in Banner und „Letzter Lauf“ gelistet (max. 100 gespeichert). Rechte- und Quota-Fehler bleiben fatal — R10, UI-Lauf in Chromium |
| V2 | mittel | **Navigation während eines Laufs** entlud die TaskView: Lauf lief unsichtbar weiter, die Aufgabe ließ sich danach erneut starten oder **löschen** — und wurde vom weiterlaufenden Backup beim Abschluss wieder in IndexedDB geschrieben. Gleiches für einen Restore. Die Hilfe-Aussage „während des Laufs gesperrt“ war damit falsch | App sperrt Aufgabenwechsel, „+ Neue Aufgabe“, „Wiederherstellen“, F2 und F6, solange ein Backup oder Restore läuft; Tab-Schließen fragt nach (`beforeunload`) |
| V3 | mittel | Durch F3 (festgeschriebener `repoSlug`) entstand ein neuer Kollisionsfall: Aufgabe „Neue Aufgabe“ läuft, wird in „Fotos“ umbenannt; eine neue „Neue Aufgabe“ schreibt dann **in dasselbe Repository** — mit anderer Passphrase dauerhaft „falsche Passphrase“ | `pickRepoSlug`: beim ersten Lauf wird ein Ordnername gewählt, den keine andere Aufgabe festgeschrieben hat (`neue-aufgabe-2`), und sofort gespeichert (auch bei Fehllauf) — R11 |
| V4 | niedrig | Restore-Fehlerliste zeigte englischen Rohtext (`Name is not allowed.` usw.) | Liste übersetzt über `errorMessage`; neue Texte für unzulässige Namen (Windows `a:b.txt`, `CON`) und gesperrte Zieldateien (`NoModificationAllowedError`) |
| V5 | niedrig | Tar-Reader lehnte Archive mit vorzeichenbehafteter Header-Prüfsumme (ältere Packer, Nicht-ASCII-Namen) ab | beide Prüfsummenvarianten wie GNU/bsdtar — R8 erweitert |
| V6 | niedrig | Toolbar: ohne `tabs`-Permission war das Finden des eigenen Tabs unsicher | Chrome ≥ 116: `runtime.getContexts` (keine Permission nötig), sonst Rückfall wie bisher |

Hilfe (DE + EN) angepasst: Ordnername beim ersten Lauf inkl. Nummerierung,
Sperre während Backup/Restore, übersprungene Dateien.

### 7.3 Bestätigt (nicht widerlegt)

F1–F14 und S1–S12 nachvollzogen (Diff gelesen, Tests im Node-Harness **und**
in echtem Chromium grün). Version 1.0.0 in `package.json`, `public/manifest.json`,
`manifest.firefox.json`, Pack-Skripten und den gebauten Manifesten.

### 7.4 Weiterhin offen / nur statisch geprüft

- Native Dialoge (`showDirectoryPicker`, Rechte-Prompts), Drag & Drop, echte
  Downloads, Toolbar-Icon, Firefox-Laufzeit und alles Windows-Spezifische
  (Laufwerksbuchstaben, Office-Sperren, `a:b.txt`) → Checkliste Abschnitt 6.
- Ein im Ziel beschädigter Block wird durch Dedup nie neu geschrieben: Läufe,
  deren Verify-Stichprobe ihn trifft, scheitern weiter („Verify fehlgeschlagen“),
  bis der Repository-Ordner ersetzt wird. Fail-loud ist gewollt; eine
  Selbstheilung ist für nach 1.0 vorgemerkt.
- S13–S15 unverändert (Format v1, Dev-Abhängigkeiten).

## 8. Runde 2 (2026-10-20)

Basis `39a79bc`. Ziel: jede Funktion fehlerfrei auf Windows und macOS,
sicher. all/backed ist eine Browser-Extension — Tauri-spezifische Punkte
(Dialog-Plugin, Rust-Backend, Updater, `cargo audit`, Windows-`cargo check`)
entfallen; die übertragbaren Muster L1–L13 wurden auf Browser-Ebene geprüft.

### 8.1 Was tatsächlich ausgeführt wurde

| Weg | Ergebnis |
| --- | --- |
| `pnpm test` (Node + memfs, jetzt mit Windows-Namensregeln und APFS/NTFS-artiger Groß-/Kleinschreibung + NFC/NFD-Gleichsetzung) | PASS — Basis + R1–R8, R10–R17 |
| `await window.abSelfTest()` in echtem Chromium (`chrome-headless-shell`, echtes OPFS, per CDP) | PASS — alle Schritte inkl. R12–R17 |
| Negativkontrollen | R12 mit altem Restore-Pfad: FAIL (`a:b.txt`, `CON.txt`, `draft.`, `what?/x.txt` scheitern; `readme.txt` überschreibt `README.txt`, NFD überschreibt NFC). R15 ohne Fix: FAIL („falsche Passphrase“ durch Streudatei) |
| UI-Läufe in Chromium, Direktmodus (Ordner-Picker per Stub auf OPFS-Ordner) | DE dunkel 760×520, EN hell 640×480, EN dunkel 1280×800, DE hell 760×520: Aufgabe anlegen, Quelle (Umlaute/Leerzeichen, 41 Dateien/40 MiB), Ziel, Passphrase, Backup OK; zweiter Lauf mit 120 Dateien → [Abbrechen] → gelbes Banner, Navigation wieder frei, keine Version; falsche Passphrase → rot; Sprachwechsel → Karte „Letzter Lauf“ wechselt mit; Restore: Repo gefunden, entsperrt, Ziel in `allbacked/…/blocks` abgelehnt, nicht leeres Ziel → Rückfrage (`.DS_Store` ignoriert), „Abbrechen“ schreibt nichts, „Überschreiben“ stellt 41 Dateien her (Umlaut-Inhalt geprüft); kein horizontaler Überlauf |
| UI-Läufe in Chromium, Archiv-Modus (`?fallback`) | DE dunkel / EN hell 760×520: Backup → `allbacked-neue-aufgabe-2026-10-20.tar` (lokales Datum; UTC war noch der 19.), Müll-Datei und abgeschnittenes `.tar` → übersetzte Meldungen, Import → Manifest mit `a:b.txt`, `CON.txt`, `README.txt`/`readme.txt`, `frage?.txt`, `ende.` → `restored-2026-10-20.tar` enthält `a_b.txt`, `_CON.txt`, `readme (2).txt`, `frage_.txt`, `ende_`, Liste der 5 Umbenennungen sichtbar |
| Chromium-OPFS nachgemessen | OPFS (macOS) akzeptiert `a:b.txt`, `CON`, `x?.txt`, `end.` und ist case-sensitiv — ohne den Fix landeten solche Namen unverändert im `restored-*.tar` und scheiterten erst beim Entpacken unter Windows |
| `pnpm typecheck` / `pnpm build` / `pnpm build:firefox` | fehlerfrei |
| `pnpm audit --prod` | keine Befunde (Laufzeit nur react/react-dom) |

### 8.2 Behobene Fehler

| # | Muster | Schwere | Fehler | Fix |
| --- | --- | --- | --- | --- |
| W1 | L5 | hoch | Restore schrieb Namen unverändert: `a:b.txt`, `CON.txt`, `x?.md`, `draft.` scheiterten unter Windows (bzw. im Archiv-Modus erst beim Entpacken), `readme.txt` **überschrieb** `README.txt` auf APFS/NTFS, NFD-„ü“ überschrieb NFC-„ü“ | `src/engine/portable.ts`: Zielnamen werden in der Engine vor dem Schreiben festgelegt (verbotene Zeichen → `_`, reservierte Namen → `_CON`, Punkt/Leerzeichen am Ende → `_`, Kollisionen nach Fold/NFC → `name (2).ext`, Ordner/Datei-Kollision nummeriert); `RestoreResult.renamed` + gelbe Liste — R12 |
| W2 | L11 | mittel | Restore in einen nicht leeren Ordner überschrieb gleichnamige Dateien **ohne Rückfrage**; ein Ziel innerhalb des Repositories (z. B. `allbacked/x/blocks`) war erlaubt und hätte Wiederhergestelltes zwischen die Blöcke geschrieben | `inspectRestoreTarget`: Ziel im Repository → abgelehnt; nicht leer → Rückfrage mit Vorschau („Überschreiben & wiederherstellen“ / „Anderen Ordner wählen“ / „Abbrechen“), OS-Streudateien zählen nicht — R16, UI-Lauf |
| W3 | L9 | mittel | Laufende Backups/Restores ließen sich **nicht abbrechen** — nur Tab schließen. Ein 500-GB-Lauf war damit nicht kontrolliert beendbar | `AbortSignal` in `runBackup`, `runRestore`, `untarToDirectory`; [Abbrechen] im Protokoll bzw. in der Restore-Fortschrittszeile. Abgebrochenes Backup: kein Manifest, Blöcke bleiben (Dedup), „Letzter Lauf“ unverändert, gelbes Banner. Abgebrochener Restore: aktuelle Datei verworfen (`abort()`, neu angelegte entfernt) — R13, UI-Lauf |
| W4 | L5 | mittel | Kurze Sperren auf dem Ziel (Virenscanner, Suchindex, OneDrive unter Windows) ließen den ganzen Lauf scheitern | `writeFileRetry`: bis zu 3 Wiederholungen (150/500/1500 ms) bei `NoModificationAllowedError`/`InvalidStateError`, jede Wiederholung schreibt die ganze Datei atomar neu; andere Fehler (Quota, Rechte) sofort — R14 |
| W5 | L5 | mittel | Passphrase-Prüfung vor dem ersten Manifest las „die erste Datei“ in `blocks/` — eine liegengebliebene `<hash>.crswap` (Chrome-Swapdatei nach Absturz) oder `.DS_Store` ergab dauerhaft „falsche Passphrase“ | nur Namen mit 64 Hex-Zeichen zählen als Block — R15 (Negativkontrolle FAIL ohne Fix) |
| W6 | L2 | niedrig | `.tar`-Fehler („not a valid tar archive…“, „tar archive is truncated“) erschienen englisch im deutschen UI; Engine-Details in Klammern waren englische Sätze („Block … is damaged.“) | Tar-Fehler als `EngineError` (`archive-invalid`/`archive-truncated`) mit DE/EN-Text; `EngineError.detail` trägt nur sprachneutrale Angaben (Dateiname, Block-ID); `TypeMismatchError`, `InvalidStateError`, `AbortError` gemappt — R17 |
| W7 | L2/L12 | niedrig | Die Karte „Letzter Lauf“ zeigte den Fehler in der Sprache zum Zeitpunkt des Fehlers (nach EN/DE-Wechsel gemischt) | `RunSummary.errorInfo` (i18n-Schlüssel + Detail) wird gespeichert und bei jeder Anzeige übersetzt; alte Einträge zeigen weiter ihren Text — UI-Lauf |
| W8 | L10 | niedrig | Download-Namen `allbacked-<aufgabe>-<datum>.tar` / `restored-<datum>.tar` nutzten das **UTC-Datum** — zwischen 0 und 1/2 Uhr (MEZ/MESZ) der Vortag | `localDateStamp()` (lokales Kalenderdatum) — im UI-Lauf um 01:18 MESZ nachgewiesen |
| W9 | — (UI) | mittel | Kleine Fenster (≤ 800 px): Seitenleiste fix 320 px, Karten-Raster dreispaltig ab 640 px **Viewport** → Karten 108 px breit, Texte zeichenweise umbrochen, **horizontaler Seiten-Überlauf** (936 px Inhalt bei 760 px Fenster), F-Leiste abgeschnitten (F8 unsichtbar), „Aufgabe löschen“ zweizeilig | Seitenleiste 240/288/320 px (bis md/xl), Raster erst ab `lg` dreispaltig, F-Leiste umbricht, Start-Knopf rechts, Löschen-Knopf ohne Umbruch, Tagline bricht nur zwischen Flags; Banner, Protokoll, Rückfrage und Ergebnis scrollen bei Erscheinen ins Bild. Nachgemessen: kein Überlauf bei 640/760/1280 px |
| W10 | L11 | niedrig | IndexedDB-Fehler beim Speichern/Löschen einer Aufgabe gingen als „unhandled rejection“ verloren (Anzeige zeigte einen nicht gespeicherten Zustand) | App fängt sie und zeigt „Die Änderung konnte nicht gesichert werden: …“ |
| W11 | L3 | niedrig | `localStorage`-Zugriffe ungeschützt (blockierte Website-Daten → weiße Seite); Erstsprache nur aus `navigator.language` | alle Zugriffe in `try/catch`; Erstsprache aus `navigator.languages[0]`; `<html lang>` folgt der Sprache |
| W12 | L12 | niedrig | DE-F-Leiste zeigte „Restore“ | „Wiederherstellen“ |
| W13 | L6 | info | macOS-Tastaturen: F1–F12 steuern standardmäßig Helligkeit/Lautstärke | Hilfe nennt fn bzw. die Systemeinstellung; alle F-Funktionen sind klickbar. Keine Strg/⌘-Kürzel in der App (geprüft) |

Hilfe (DE + EN) angepasst: Abbrechen (Aufgaben, Backup, Restore),
Wiederholungen bei Laufwerkssperren, Rückfrage bei nicht leerem Ziel, Ziel
im Backup abgelehnt, Umbenennung unzulässiger/kollidierender Namen,
Zeitstempel in Ortszeit, fn-Taste am Mac. README ergänzt.

### 8.3 Muster L1–L13 — Ergebnis für all/backed

| Muster | Ergebnis |
| --- | --- |
| L1 Dialog-Plugin-Stubs | entfällt (kein Tauri). Kein `confirm`/`alert`/`prompt` im Code; Bestätigungen sind eigene UI (Löschen: zweiter Klick binnen 3 s; Restore-Ziel: Rückfrage-Karte) |
| L2 Rohe Fehlertexte | behoben (W6, W7); verbleibend nur der Rückfall „Da ist etwas schiefgelaufen: <Rohtext>“ für unbekannte Browser-Fehler |
| L3 Erstsprache | OK (`navigator.languages`), W11 |
| L4 CSV/BOM | entfällt (kein CSV/JSON-Import/Export); `.tar`-Import prüft Header-Prüfsummen |
| L5 Windows-Dateisystem | W1, W4, W5. Laufwerkswurzeln/lange Pfade/gesperrte Quelldateien: Browser-API, nur manuell prüfbar |
| L6 Kürzel-Beschriftung | OK, nur F-Tasten (W13) |
| L7 Fremdinhalte | OK: keine Netzzugriffe, kein HTML-Rendering fremder Inhalte, Standard-MV3-CSP |
| L8 Schwere Arbeit im UI-Thread | OK: SHA-256, AES-GCM, PBKDF2 (600k) über WebCrypto, gzip über CompressionStream — alles asynchron; UI blieb im 40-MiB-Lauf bedienbar ([Abbrechen] reagierte) |
| L9 Lange Aufgaben | W3; Navigation-Sperre und `beforeunload` aus Runde 1 bestehen |
| L10 Zeitstempel | W8; Versionsliste zeigt Ortszeit (Manifestname ist UTC-ISO, wird lokal formatiert); tar-mtime ist Epoch (UTC, korrekt) |
| L11 Destruktive Aktionen | W2, W10 |
| L12 Texte DE/EN, Hilfe | R17 prüft Schlüsselgleichheit; W12; Hilfe aktualisiert |
| L13 Updater | entfällt (Updates über Chrome Web Store/AMO) |

### 8.4 Nur auf echter Hardware prüfbar

- Windows (Chrome): ob Chromium beim Schreiben in echte NTFS-Ordner weitere
  Namen ablehnt als die nun vorab umbenannten; Pfade > 260 Zeichen; Ziel auf
  Laufwerksbuchstaben/Laufwerkswurzel; Virenscanner-/OneDrive-Sperren
  (welchen `DOMException`-Namen Chrome dabei liefert — der Retry deckt
  `NoModificationAllowedError`/`InvalidStateError` ab).
- macOS (Chrome): Restore auf APFS (case-insensitiv) mit `README.txt`/`readme.txt`
  aus einem Linux-Backup → zwei Dateien (`readme (2).txt`).
- Echte native Dialoge, Rechte-Prompts, Drag & Drop, Downloads, Toolbar-Icon,
  Firefox-Laufzeit — wie Abschnitt 6.
