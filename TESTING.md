# Testprotokoll — Multi-Source, Terminal-UI, E2E mit echten Dateien

Stand: 2026-08-12 · Umgebung: Chrome (macOS), Dev-Server `:3051`, Archiv-Modus
erzwungen via `?fallback` (gleiche Engine wie der Chromium-Direktmodus).

## Testdaten

`testdata/folder-a` (hello.txt, notes.md, „über sicht.txt", sub/data.bin 300 KB)
und `testdata/folder-b` (b1.txt, big.bin 1,2 MB, duplicate.txt — inhaltsgleich
mit folder-a/hello.txt für den Cross-Ordner-Dedup-Nachweis). Ergebnisse landen
in `testdata-out/` (gitignored); die Archive werden dorthin über den Dev-Sink
`POST /__abtest/save` geschrieben (Vite-Plugin, nur im Dev-Server).

Da native Ordner-/Datei-Dialoge nicht automatisierbar sind, gibt es zwei
Dev-only-Events als Testbrücke (`ab:test:add-source`, `ab:test:restore-tar`),
die exakt die gleichen Code-Pfade füttern wie die Dialoge.

## Testfälle & Ergebnisse

| # | Test | Ergebnis |
| --- | --- | --- |
| 1 | Engine-Selbsttest `await window.abSelfTest()` (inkl. Multi-Source-Umbau, Tar-Roundtrip, falsche Passphrase, Blöcke ohne Klartext) | ✅ PASS |
| 2 | F2 legt Aufgabe an; Sidebar-Statusring „noch nie gesichert" | ✅ |
| 3 | Zwei Ordner hinzufügen → beide **untereinander** gelistet (Baum-Zeichen) mit Datei-Anzahl und Größe | ✅ |
| 4 | Backup-Lauf (Start-Button): Terminal-Log mit Ampel-Punkten, `$`-Zeile, blinkendem Cursor, ASCII-Fortschrittsbalken, Scan-Phase | ✅ |
| 5 | Erfolgs-Banner (CCC-Stil): Abgeschlossen am / Dauer / 7 Dateien (1,4 MiB) / 6 neue Blöcke · **1 dedupliziert** (duplicate.txt über Ordnergrenzen) / Verify OK | ✅ |
| 6 | Tar-Export automatisch heruntergeladen (1,4 MiB), auf Platte gesichert | ✅ |
| 7 | Zweiter Lauf: **0 neue Blöcke · 7 dedupliziert** (Dedup über Läufe) | ✅ |
| 8 | Task + letzter Lauf überleben Seiten-Reload (IndexedDB) | ✅ |
| 9 | Restore: Tar-Import → Repo gefunden, als verschlüsselt erkannt | ✅ |
| 10 | Falsche Passphrase → „Entschlüsselung fehlgeschlagen — falsche Passphrase?" | ✅ |
| 11 | Korrekte Passphrase → 2 Versionen gelistet, neueste wiederhergestellt (7 Dateien) | ✅ |
| 12 | Restored-Tar mit macOS `tar` entpackt, `diff -r` gegen beide Original-Ordner: **byte-identisch** (inkl. Umlaut-Datei und Binärdaten) | ✅ |
| 13 | F8-Löschen verlangt zweiten Bestätigungsklick | ✅ (früherer Durchlauf) |
| 14 | EN/DE-Umschaltung übersetzt komplette UI | ✅ (früherer Durchlauf) |

## Gefundene Probleme → Fixes

| Problem | Fix |
| --- | --- |
| B1: Restore zeigte den OPFS-Scratch-Namen „restore-import" statt des Task-Namens | `findRepos` liest jetzt `taskName` aus `ab-repo.json` (`repoLabel`), Anzeige korrekt „Neue Aufgabe" — nachgetestet ✅ |
| B2: Mögliche React-Key-Kollision bei gleichnamigen Repos in der Restore-Liste | Index-basierte Keys + Referenzvergleich für die Auswahl |
| „Nach der Auswahl nicht sichtbar" (Nutzer-Feedback) | Quellen-Panel listet jede gewählte Quelle mit Name, Datei-Anzahl und Größe; mehrere Ordner werden gestapelt angezeigt und sind einzeln entfernbar |

## Bekannte, nicht per Web-App behebbare Punkte

- **„Upload"-Beschriftung** im Ordner-Dialog von Safari/Firefox ist Browser-UI
  und nicht änderbar. Gegenmaßnahme: Hinweistext unter den Karten („es wird
  nichts hochgeladen…"). In Chromium erscheint stattdessen der echte
  Ordner-Picker der File System Access API.
- **F5** wird von manchen Umgebungen als Browser-Reload abgefangen, bevor die
  Seite es sieht (in der Test-Automation der Fall). In der normalen Nutzung
  verhindert `preventDefault` den Reload; zusätzlich löst der Start-Button
  denselben Lauf aus.

## Nachtest 2026-08-13 — Drag & Drop und Auswahl-Sichtbarkeit

Anlass: Nutzer-Feedback „Upload-Dialog, Auswahl danach nicht gelistet, kein
Ziel wählbar" (Safari).

| # | Test | Ergebnis |
| --- | --- | --- |
| 15 | Echter Input-`change`-Pfad (programmatisch via DataTransfer, exakt der Ereignispfad des „Hochladen"-Dialogs): Quelle erscheint sofort in der Liste („datei1.txt — 2 Dateien · 22 B") | ✅ |
| 16 | **Drag & Drop** auf das QUELLEN-Panel (neuer Weg, umgeht den Upload-Dialog): zweite Quelle wird darunter gelistet | ✅ |
| 17 | Backup-Lauf mit gemischten Quellen (Dialog + Drop): Banner, 4 Dateien, Verify OK, Tar-Export | ✅ |
| 18 | Ziel-Karte erklärt im Archiv-Modus explizit, warum kein Ordner wählbar ist (Browser-Limitierung) und verweist auf Chrome | ✅ |

Neu implementiert: Drag & Drop von Ordnern/Dateien auf das QUELLEN-Panel.
In Chromium liefert der Drop echte Directory-Handles (persistent, direkte
Laufwerk-Ziele möglich); in Safari/Firefox wird der Ordner per
`webkitGetAsEntry` rekursiv eingelesen. Gemischte Quellen (Handles +
Sitzungs-Ordner) laufen in einem Backup zusammen.

Einordnung Safari: Der gemeldete Pfad ist in Chrome nachweislich intakt
(Tests 15–17). Safari lässt sich nicht fernsteuern; falls dort die Liste nach
der Dialog-Auswahl weiterhin leer bleibt, bitte mit Cmd+Shift+R neu laden
(zwischenzeitlich war der Dev-Server down) und andernfalls die
Safari-Konsole prüfen (Entwickler-Menü). Drag & Drop steht als vom Dialog
unabhängiger Weg bereit. Direktes Schreiben in Ordner bleibt in Safari
prinzipbedingt unmöglich (keine File System Access API) — dafür Chrome oder
später die Pro-Companion-App.

## Nachtest 2026-08-13 (2) — Speicher: Streaming statt RAM

Anlass: Nutzer meldet Backup-Abbruch „operation failed for an unknown
transient reason (e.g. out of memory)" im Archiv-Modus — Browser-Speicher
reichte nicht.

Fixes:
- Tar-Export komponiert das Archiv jetzt aus **Blob-Referenzen** (Dateiinhalte
  werden nicht mehr in den Arbeitsspeicher geladen); Tar-Import parst per
  `Blob.slice`-Streaming statt `arrayBuffer()` über das ganze Archiv.
- **Quota-Vorabprüfung** (`navigator.storage.estimate`) vor jedem
  Archiv-Modus-Lauf: zu große Backups brechen sofort mit verständlicher
  Meldung ab (benötigt/frei) statt mitten im Lauf mit einem kryptischen
  DOMException-Text; `QuotaExceededError`/`UnknownError` werden auf dieselbe
  Meldung samt Chrome-Hinweis gemappt.

| # | Test | Ergebnis |
| --- | --- | --- |
| 19 | Selbsttest mit Streaming-Tar (Roundtrip byte-identisch) | ✅ PASS |
| 20 | **100-MB-Lasttest** Archiv-Modus: Backup 3,7 s, 25 Blöcke, Verify OK, Tar-Export 101,5 MiB — kein OOM | ✅ |
| 21 | Restore des 100-MB-Archivs: Import, Entsperren, Version wiederhergestellt, restored-Tar 100 MiB | ✅ |

Hinweis zur Automation: Ein `abSelfTest`-FAIL („file not found") während der
Läufe war ein Artefakt zweier parallel gestarteter Selbsttests (teilen sich
OPFS-Testordner), kein Produktfehler — Wiederholung einzeln: PASS.

Einordnung: „Direkt in einen anderen Ordner transferieren" existiert im
Chromium-Direktmodus bereits (Ziel-Ordner wählbar, kein Browser-Speicher
beteiligt). Safari/Firefox können das API-bedingt nicht; dort bleibt der
Archiv-Modus — jetzt mit Streaming und klarer Quota-Meldung.

## Nicht automatisierbar (manuell zu prüfen)

- Chromium-Direktmodus mit echten Ordner-Pickern und Schreiben aufs externe
  Laufwerk (native Dialoge): Quellen hinzufügen/entfernen, Ziel wählen, Lauf.
  Engine-Pfade sind identisch mit den getesteten; Selbsttest deckt sie ab.
- Echte Safari-/Firefox-Läufe (Automation steuert nur Chrome).
