import { useEffect, useState } from 'react';
import { Lang } from '../i18n';

// Self-contained help system: first-run tutorial plus a searchable manual.
// Content deliberately lives here (not in i18n.ts) so UI strings and
// documentation can be maintained separately. Opened via F1, the footer
// F-key bar, the ? button in the sidebar, or the 'ab:help' custom event.

interface Step {
  title: string;
  body: string[];
}

interface Section {
  id: string;
  title: string;
  body: string[];
}

interface Content {
  labels: {
    tutorial: string;
    manual: string;
    search: string;
    next: string;
    back: string;
    skip: string;
    done: string;
    close: string;
    stepOf: (n: number, total: number) => string;
    noResults: string;
  };
  tutorial: Step[];
  sections: Section[];
}

const de: Content = {
  labels: {
    tutorial: 'Tutorial',
    manual: 'Handbuch',
    search: 'Handbuch durchsuchen…',
    next: 'Weiter',
    back: 'Zurück',
    skip: 'Überspringen',
    done: 'Los geht’s',
    close: 'Schließen',
    stepOf: (n, total) => `Schritt ${n} von ${total}`,
    noResults: 'Keine Treffer',
  },
  tutorial: [
    {
      title: 'Willkommen bei all/backed.',
      body: [
        '$ allbacked --free --local --encrypted',
        'all/backed sichert Ihre Ordner direkt aus dem Browser — lokal, auf Wunsch verschlüsselt, ohne Konto und ohne Cloud.',
        'Dieses Tutorial dauert zwei Minuten. Sie finden es jederzeit wieder: F1 oder der ?-Knopf unten links.',
        'Blättern mit den Pfeiltasten ← →, Schließen mit Esc.',
      ],
    },
    {
      title: 'Eine Aufgabe anlegen',
      body: [
        'Ein Backup ist eine Aufgabe: ein Name, eine oder mehrere Quellen, ein Ziel.',
        '• F2 oder „+ Neue Aufgabe“ in der Seitenleiste legt eine Aufgabe an.',
        '• Quellen: „+ Ordner hinzufügen“ öffnet die Ordnerauswahl — oder Sie ziehen Ordner per Drag & Drop auf die Quellen-Karte.',
        'Mehrere Quellen sind erlaubt und werden in einem Lauf zusammen gesichert. Zu jeder Quelle zeigt all/backed Dateizahl und Größe.',
      ],
    },
    {
      title: 'Das Ziel — je nach Browser',
      body: [
        'In Chrome wählen Sie einen echten Zielordner — auch auf einer externen Platte. all/backed schreibt direkt hinein.',
        'Safari und Firefox erlauben kein direktes Schreiben in Ordner. Dort bereitet all/backed das Backup im Browser-Speicher vor und lädt es als .tar-Archiv herunter — bewahren Sie dieses Archiv auf Ihrem Ziel-Laufwerk auf.',
        'Der Unterschied ist nur der Weg: Der Inhalt des Backups ist derselbe.',
      ],
    },
    {
      title: 'Verschlüsselung',
      body: [
        'Ein Haken genügt: Datenblöcke und Versionslisten werden mit AES-256 (GCM) verschlüsselt. Der Schlüssel wird aus Ihrer Passphrase abgeleitet und verlässt dieses Gerät nie.',
        'Wichtig: Ohne Passphrase gibt es keine Wiederherstellung — kein Zurücksetzen, kein Zweitschlüssel. Bewahren Sie sie sicher auf.',
      ],
    },
    {
      title: 'Sichern & prüfen',
      body: [
        'F5 oder der Start-Knopf unten rechts führt die Aufgabe aus. Das Terminal-Protokoll zeigt Phase, Fortschrittsbalken, Dateien und Blöcke live.',
        'Bereits gesicherte Datenblöcke werden dedupliziert — der zweite Lauf ist darum deutlich kleiner und schneller als der erste.',
        'Nach jedem Lauf liest all/backed eine Stichprobe der geschriebenen Blöcke zurück und prüft ihre Prüfsummen. Das Ergebnis steht im Abschluss-Banner: Verify OK.',
      ],
    },
    {
      title: 'Wiederherstellen',
      body: [
        'F6 öffnet die Wiederherstellung. Wählen Sie den Backup-Ort — den Ordner mit dem Verzeichnis „allbacked“ — oder im Archiv-Modus das heruntergeladene .tar-Archiv.',
        'Jeder Backup-Lauf ist eine eigene Version. Version auswählen, Zielordner wählen — fertig.',
        'Verschlüsselte Backups fragen zuerst nach der Passphrase.',
      ],
    },
  ],
  sections: [
    {
      id: 'tasks',
      title: 'Aufgaben & Quellen',
      body: [
        'Jede Aufgabe bündelt Quellen, Ziel und Verschlüsselung. Der Name ist frei wählbar; beim ersten Lauf benennt er den Backup-Ordner im Ziel (allbacked/<name>). Spätere Umbenennungen ändern nur die Anzeige — gesichert wird weiter in denselben Ordner. Nutzt bereits eine andere Aufgabe diesen Ordnernamen, bekommt die neue eine Nummer (allbacked/<name>-2), damit sich zwei Aufgaben nie ein Backup teilen.',
        '• Anlegen: F2 oder „+ Neue Aufgabe“ · Löschen: F8 oder „Aufgabe löschen“ (zur Sicherheit zweimal klicken)',
        '• Quellen hinzufügen: „+ Ordner hinzufügen“ (Ordnerauswahl) oder Ordner per Drag & Drop auf die Quellen-Karte ziehen',
        '• Quelle entfernen: [entfernen] neben dem Eintrag',
        'Zu jeder Quelle zeigt all/backed Dateizahl und Gesamtgröße; mehrere Quellen werden in einem Lauf zusammen gesichert. Derselbe Ordner lässt sich nicht doppelt hinzufügen. Haben zwei Quellen denselben Namen (z. B. zweimal „Dokumente“ von verschiedenen Laufwerken), landet die zweite im Backup als „Dokumente (2)“ — nichts wird überschrieben.',
        'Der Name „allbacked“ gehört dem Backup-Ordner: Eine Quelle mit diesem Namen wird im Backup als „allbacked (2)“ geführt. Liegt das Ziel innerhalb einer Quelle (z. B. Dokumente → Dokumente/Backup), sichert all/backed seinen eigenen Ordner „allbacked“ nicht mit. Eine Quelle innerhalb von „allbacked“ lehnt der Lauf mit einer Meldung ab.',
        'Im Archiv-Modus (Safari/Firefox) gelten hinzugefügte Quellen für die laufende Sitzung — nach einem Neuladen wählen Sie sie neu.',
        'Der Statuspunkt in der Seitenleiste zeigt den letzten Lauf: grün = Verify OK, rot = fehlgeschlagen (der Grund steht in der Karte „Letzter Lauf“), leerer Ring = noch nie gesichert.',
        'Während ein Backup oder eine Wiederherstellung läuft, sind Name, Quellen, Ziel und Löschen gesperrt — ebenso der Wechsel zu einer anderen Aufgabe, eine neue Aufgabe und die Wiederherstellen-Ansicht. Beenden lässt sich ein Lauf jederzeit mit [Abbrechen]. Beim Schließen des Tabs fragt der Browser nach.',
      ],
    },
    {
      id: 'dest',
      title: 'Ziel & Browser-Unterschiede',
      body: [
        'In Chrome nutzt all/backed die File System Access API: Sie wählen den Zielordner einmal, das Backup wird direkt hineingeschrieben — auch auf externe Laufwerke.',
        'Safari und Firefox bieten diese API nicht. Dort läuft der Archiv-Modus: Das Backup wird im Browser-Speicher aufgebaut und anschließend als .tar-Archiv heruntergeladen (allbacked-<aufgabe>-<datum>.tar).',
        'Vor einem Archiv-Backup prüft all/backed den freien Browser-Speicher. Reicht er nicht, stoppt der Lauf mit einer „benötigt / frei“-Angabe, bevor etwas geschrieben wird.',
        'Meldet der Browser mitten im Lauf „QuotaExceeded“, ist der Browser-Speicher voll — Platz schaffen oder in Chrome direkt in einen Ordner sichern.',
        'Läuft in Chrome das Ziel-Laufwerk voll, endet der Lauf mit der Meldung „Das Ziel-Laufwerk ist voll“. Es entsteht keine neue Version, frühere bleiben unverändert; nach dem Platzschaffen werden die schon geschriebenen Blöcke wiederverwendet.',
        'Hinweis: Der Ordner-Dialog des Browsers heißt teils „Hochladen“ — hochgeladen wird nichts, alle Daten bleiben auf diesem Gerät.',
        'Nach einem Browser-Neustart fragt Chrome beim nächsten Lauf erneut, ob all/backed auf die gewählten Ordner zugreifen darf (bis dahin steht bei der Quelle „Zugriff wird beim nächsten Lauf angefragt“). Bei mehreren Ordnern kann eine Rückfrage pro Ordner kommen — erscheint „Zugriff verweigert“, einfach erneut auf Start klicken.',
      ],
    },
    {
      id: 'crypto',
      title: 'Verschlüsselung',
      body: [
        'Mit „Backup verschlüsseln“ werden alle Datenblöcke und Versionslisten mit AES-256-GCM verschlüsselt — per WebCrypto, direkt im Browser.',
        'Der Schlüssel wird per PBKDF2 (SHA-256, 600.000 Iterationen bei neuen Backups; ältere behalten ihre gespeicherten 310.000) aus Ihrer Passphrase abgeleitet. Passphrase und Schlüssel verlassen das Gerät nie und werden nirgends gespeichert.',
        'Daraus folgt: Ohne Passphrase keine Wiederherstellung. Kein Reset, keine Hintertür. Notieren Sie die Passphrase an einem sicheren Ort.',
        'Ob ein Backup-Ordner verschlüsselt ist, wird beim ersten Lauf festgelegt und gilt für alle weiteren Versionen dieser Aufgabe.',
        'Vor jedem weiteren Lauf prüft all/backed die Passphrase gegen die vorhandenen Daten. Eine abweichende Passphrase bricht den Lauf ab, bevor etwas geschrieben wird — so kann kein Backup mit zwei verschiedenen Schlüsseln entstehen.',
      ],
    },
    {
      id: 'run',
      title: 'Backup ausführen',
      body: [
        'Start: F5 oder der Start-Knopf in der Fußleiste.',
        'Phasen: scanne Quellen → sichere → prüfe → schreibe Manifest → fertig. Das Terminal-Protokoll zeigt die aktuelle Datei, den Fortschrittsbalken und die Blockzähler live.',
        'Danach fasst ein Banner den Lauf zusammen: Abschlusszeit, Dauer, Dateien, neue und deduplizierte Blöcke, Verify-Ergebnis. Im Archiv-Modus startet zusätzlich der Download des .tar-Archivs.',
        'Der letzte Lauf bleibt sichtbar — als Karte in der Detailansicht und als Statuspunkt in der Seitenleiste.',
        'Schlägt ein Lauf fehl, bleiben frühere Versionen unverändert und weiterhin wiederherstellbar. Die neue Version erscheint erst, wenn die Prüfung bestanden ist.',
        'Gesichert werden Dateien mit Inhalt und relativem Pfad. Leere Ordner, Dateirechte und Änderungszeiten werden beim Wiederherstellen nicht nachgebildet.',
        'Ist eine Datei während des Laufs gesperrt (z. B. eine geöffnete Outlook-.pst unter Windows), wird sie beim Lesen geändert oder zwischendurch gelöscht, oder ist ein Unterordner nicht lesbar, überspringt all/backed nur diese Einträge. Banner und Karte „Letzter Lauf“ listen sie gelb auf; sie fehlen in dieser Version — Programm schließen und erneut sichern. Fehlende Zugriffsrechte brechen den Lauf dagegen ab.',
        '[Abbrechen] im Kopf des Terminal-Protokolls stoppt den Lauf nach dem aktuellen Block. Es entsteht keine neue Version, frühere Versionen bleiben unverändert, und die Karte „Letzter Lauf“ zeigt weiter den vorigen Lauf. Bereits geschriebene Blöcke sind vollständig und werden beim nächsten Lauf wiederverwendet.',
        'Wird der Tab mitten im Lauf geschlossen, stürzt der Browser ab oder wird das Laufwerk abgezogen, entsteht ebenfalls keine neue Version. Ein dabei nur angelegter, leerer Block wird beim nächsten Lauf neu geschrieben statt als vorhanden zu gelten.',
        'Ist das Ziel-Laufwerk kurz gesperrt (unter Windows etwa durch Virenscanner, Suchindex oder OneDrive), versucht all/backed das Schreiben eines Blocks bis zu dreimal erneut, bevor der Lauf mit einer Meldung endet.',
      ],
    },
    {
      id: 'restore',
      title: 'Wiederherstellen',
      body: [
        '„Wiederherstellen“ in der Seitenleiste oder F6 öffnet die Ansicht.',
        'In Chrome wählen Sie den Backup-Zielordner — den Ordner, der das Verzeichnis „allbacked“ enthält. all/backed durchsucht ihn und listet alle gefundenen Backups auf (eines je Aufgabe).',
        'Im Archiv-Modus wählen Sie stattdessen das heruntergeladene .tar-Archiv; es wird lokal entpackt und genauso durchsucht.',
        'Verschlüsselte Backups sind als „verschlüsselt“ markiert und fragen nach der Passphrase; sie wird sofort gegen die neueste Version geprüft.',
        'Jeder Backup-Lauf erscheint als Version mit Zeitstempel (in Ihrer Ortszeit). „Diese Version wiederherstellen“ fragt nach dem Zielordner und stellt die Dateien dorthin wieder her.',
        'Ist der Zielordner nicht leer, zeigt all/backed zuerst, was darin liegt, und fragt nach: „Überschreiben & wiederherstellen“ ersetzt gleichnamige Dateien, „Anderen Ordner wählen“ öffnet die Auswahl neu, „Abbrechen“ schreibt nichts. Am sichersten ist ein leerer Ordner. Einen Ordner innerhalb des Backups selbst (allbacked/…) und einen Ordner, der das Backup enthält (z. B. das Backup-Laufwerk selbst oder den Ordner „allbacked“), lehnt all/backed als Ziel ab — wählen Sie dann einen neuen, leeren Ordner.',
        'Dateinamen, die Windows oder macOS nicht zulassen („a:b.txt“, „Notiz?.md“, „CON.txt“, Namen mit Punkt, Leerzeichen oder „~“ am Anfang oder Ende wie „~$Angebot.docx“, unsichtbare Steuer- und Formatzeichen wie in manchen Emoji-Folgen) werden mit „_“ statt des Zeichens wiederhergestellt („a_b.txt“, „_CON.txt“). Verknüpfungen („.lnk“, „.url“) und „desktop.ini“ lässt der Browser nicht anlegen; sie kommen als „Kunde.lnk_“ bzw. „_desktop.ini“ zurück — nach dem Umbenennen funktionieren sie wieder. Dateien, die sich nur in Groß-/Kleinschreibung unterscheiden (z. B. von Linux), bekommen eine Nummer („readme (2).txt“) statt sich gegenseitig zu überschreiben. Alle umbenannten Dateien listet all/backed nach dem Lauf mit altem und neuem Namen.',
        'Jeder Block wird beim Wiederherstellen gegen seine Prüfsumme geprüft. Lässt sich eine Datei nicht herstellen (beschädigter Block, dauerhaft gesperrte Zieldatei), wird sie übersprungen und unten aufgelistet; alle anderen Dateien werden trotzdem wiederhergestellt. Halbe Dateien entstehen nie — auch nicht bei [Abbrechen]: Die gerade geschriebene Datei wird verworfen, bereits fertige bleiben im Zielordner. Ist eine Zieldatei nur kurz gesperrt (unter Windows etwa durch Virenscanner oder OneDrive), schreibt all/backed sie bis zu dreimal komplett neu, bevor sie als fehlgeschlagen gilt; eine bestehende Datei behält dabei ihren alten Inhalt, bis der neue vollständig ist.',
        'Im Archiv-Modus wird das Ergebnis als restored-<datum>.tar heruntergeladen — entpacken Sie es, um Ihre Dateien zu erhalten. Die entpackten Zwischendaten im Browser-Speicher löscht all/backed beim nächsten Start.',
      ],
    },
    {
      id: 'dedup',
      title: 'Deduplizierung & Verify',
      body: [
        'all/backed zerlegt jede Datei in Blöcke von bis zu 4 MiB. Jeder Block wird über seine SHA-256-Prüfsumme identifiziert, komprimiert und — bei aktiver Verschlüsselung — verschlüsselt abgelegt.',
        'Ein Block, der schon im Backup liegt, wird nicht erneut gespeichert. Deshalb sind Folge-Backups klein und schnell: Nur Neues und Geändertes erzeugt neue Blöcke.',
        'Jeder Lauf schreibt ein Manifest — die Versionsliste: welche Dateien, aus welchen Blöcken, mit welchen Zeitstempeln. Ältere Versionen bleiben dadurch vollständig wiederherstellbar.',
        'Zum Abschluss jedes Laufs liest all/backed eine zufällige Stichprobe der Blöcke zurück, entpackt bzw. entschlüsselt sie und vergleicht die Prüfsumme. Erst wenn alles passt, meldet der Lauf „Verify OK“.',
        'Im Ziel entsteht dafür die Struktur allbacked/<aufgabe>/ mit blocks/ und manifests/ — bitte nicht von Hand umsortieren.',
      ],
    },
    {
      id: 'keys',
      title: 'Tastatur & F-Tasten',
      body: [
        '• F1 — Hilfe öffnen und schließen',
        '• F2 — neue Aufgabe anlegen',
        '• F5 — Backup der aktuellen Aufgabe starten',
        '• F6 — Wiederherstellen öffnen',
        '• F8 — Aufgabe löschen (zweimal drücken, zur Sicherheit)',
        'Im Tutorial blättern die Pfeiltasten ← →; Esc schließt die Hilfe.',
        'Mac-Tastaturen: Steuern F1–F12 Helligkeit oder Lautstärke, halten Sie zusätzlich die fn-Taste gedrückt (oder stellen Sie in den Systemeinstellungen → Tastatur „F1, F2 usw. als Standard-Funktionstasten verwenden“ ein). Alle Funktionen sind auch per Klick auf die Fußleiste erreichbar.',
      ],
    },
    {
      id: 'lang',
      title: 'Sprache & Darstellung',
      body: [
        'Unten links in der Seitenleiste wechseln Sie zwischen EN und DE.',
        'Beim ersten Start folgt all/backed der Browser-Sprache; Ihre Wahl wird auf diesem Gerät gespeichert und bleibt erhalten.',
        'Daneben schalten Sie mit dem Sonnen-/Mond-Symbol zwischen Dunkel- und Hell-Modus um. Standard ist der dunkle Terminal-Look; auch diese Wahl bleibt auf diesem Gerät gespeichert.',
      ],
    },
    {
      id: 'roadmap',
      title: 'Was noch kommt',
      body: [
        'Die Karte „Automation“ in der Aufgaben-Ansicht ist ein Ausblick: Zeitpläne — Backups, die automatisch laufen — kommen mit Pro.',
        'Im Free-Tier bleibt alles hier Beschriebene enthalten: manuelle Backups, Verschlüsselung, Deduplizierung, Wiederherstellung.',
      ],
    },
    {
      id: 'privacy',
      title: 'Privatsphäre',
      body: [
        'all/backed arbeitet vollständig lokal: kein Konto, keine Cloud, keine Telemetrie. Die App sendet nichts ins Netz.',
        'Gesichert wird nur, was Sie ausdrücklich auswählen. Backups liegen dort, wo Sie sie ablegen — in Ihrem Zielordner oder im heruntergeladenen Archiv.',
        'Auch wenn ein Browser-Dialog „Hochladen“ sagt: Es wird nichts hochgeladen. Der Dialog stammt vom Browser, die Daten bleiben auf dem Gerät.',
        'Verschlüsselung passiert vor dem Schreiben, direkt im Browser — Details im Abschnitt „Verschlüsselung“.',
      ],
    },
  ],
};

const en: Content = {
  labels: {
    tutorial: 'Tutorial',
    manual: 'Manual',
    search: 'Search the manual…',
    next: 'Next',
    back: 'Back',
    skip: 'Skip',
    done: 'Let’s go',
    close: 'Close',
    stepOf: (n, total) => `Step ${n} of ${total}`,
    noResults: 'No matches',
  },
  tutorial: [
    {
      title: 'Welcome to all/backed.',
      body: [
        '$ allbacked --free --local --encrypted',
        'all/backed backs up your folders straight from the browser — locally, encrypted if you like, with no account and no cloud.',
        'This tutorial takes two minutes. You can reopen it anytime: F1 or the ? button in the bottom left.',
        'Page with the arrow keys ← →, close with Esc.',
      ],
    },
    {
      title: 'Create a task',
      body: [
        'A backup is a task: a name, one or more sources, a destination.',
        '• F2 or “+ New task” in the sidebar creates a task.',
        '• Sources: “+ add folder” opens the folder picker — or drag folders onto the sources card.',
        'Multiple sources are fine and are backed up together in one run. For each source, all/backed shows file count and size.',
      ],
    },
    {
      title: 'The destination — depends on your browser',
      body: [
        'In Chrome you pick a real destination folder — an external drive works too. all/backed writes straight into it.',
        'Safari and Firefox don’t allow direct folder writes. There, all/backed stages the backup in browser storage and downloads it as a .tar archive — keep that archive on your target drive.',
        'Only the route differs: the backup content is the same.',
      ],
    },
    {
      title: 'Encryption',
      body: [
        'One checkbox is all it takes: data blocks and version lists are encrypted with AES-256 (GCM). The key is derived from your passphrase and never leaves this device.',
        'Important: without the passphrase there is no recovery — no reset, no second key. Store it safely.',
      ],
    },
    {
      title: 'Run & verify',
      body: [
        'F5 or the Start button in the bottom right runs the task. The terminal log shows phase, progress bar, files and blocks live.',
        'Data blocks that are already backed up are deduplicated — which is why the second run is much smaller and faster than the first.',
        'After every run, all/backed reads back a sample of the written blocks and checks their checksums. The result appears in the completion banner: verify OK.',
      ],
    },
    {
      title: 'Restore',
      body: [
        'F6 opens the restore view. Pick the backup location — the folder containing the “allbacked” directory — or, in archive mode, the downloaded .tar archive.',
        'Every backup run is its own version. Pick a version, pick a target folder — done.',
        'Encrypted backups ask for the passphrase first.',
      ],
    },
  ],
  sections: [
    {
      id: 'tasks',
      title: 'Tasks & sources',
      body: [
        'Each task bundles sources, destination and encryption. The name is yours to choose; on the first run it names the backup folder at the destination (allbacked/<name>). Renaming later only changes the label — backups keep going into the same folder. If another task already uses that folder name, the new one gets a number (allbacked/<name>-2), so two tasks never share a backup.',
        '• Create: F2 or “+ New task” · Delete: F8 or “Delete task” (click twice, as a safeguard)',
        '• Add sources: “+ add folder” (folder picker) or drag & drop folders onto the sources card',
        '• Remove a source: [remove] next to the entry',
        'For each source, all/backed shows file count and total size; multiple sources are backed up together in one run. The same folder cannot be added twice. If two sources share a name (e.g. two “Documents” folders from different drives), the second is stored as “Documents (2)” — nothing gets overwritten.',
        'The name “allbacked” belongs to the backup folder: a source with that name is stored as “allbacked (2)”. If the destination lies inside a source (e.g. Documents → Documents/Backup), all/backed does not back up its own “allbacked” folder. A source inside “allbacked” is refused with a message.',
        'In archive mode (Safari/Firefox), added sources apply to the current session — after a reload, pick them again.',
        'The status dot in the sidebar reflects the last run: green = verify OK, red = failed (the reason is shown in the “Last run” card), empty ring = never backed up.',
        'While a backup or restore is running, name, sources, destination and delete are locked — and so are switching to another task, creating a task and the restore view. [Cancel] stops a run at any time. Closing the tab asks for confirmation.',
      ],
    },
    {
      id: 'dest',
      title: 'Destination & browser differences',
      body: [
        'In Chrome, all/backed uses the File System Access API: you pick the destination folder once and the backup is written straight into it — external drives included.',
        'Safari and Firefox don’t offer this API. There, archive mode kicks in: the backup is staged in browser storage and then downloaded as a .tar archive (allbacked-<task>-<date>.tar).',
        'Before an archive-mode backup, all/backed checks the free browser storage. If it won’t fit, the run stops with a “needed / free” message before anything is written.',
        'If the browser reports “QuotaExceeded” mid-run, browser storage is full — free up space, or back up straight into a folder in Chrome.',
        'If the destination drive fills up in Chrome, the run ends with “The target drive is full”. No new version is created, earlier ones stay unchanged; once space is freed, blocks already written are reused.',
        'Note: your browser’s folder dialog may say “Upload” — nothing is uploaded, all data stays on this device.',
        'After a browser restart, Chrome asks again on the next run whether all/backed may access the chosen folders (until then the source shows “access is requested on the next run”). With several folders there may be one prompt per folder — if “access was denied” appears, simply click Start again.',
      ],
    },
    {
      id: 'crypto',
      title: 'Encryption',
      body: [
        'With “Encrypt backup” enabled, all data blocks and version lists are encrypted with AES-256-GCM — via WebCrypto, right in the browser.',
        'The key is derived from your passphrase via PBKDF2 (SHA-256, 600,000 iterations for new backups; older ones keep their stored 310,000). Passphrase and key never leave the device and are stored nowhere.',
        'Which means: no passphrase, no recovery. No reset, no backdoor. Write the passphrase down somewhere safe.',
        'Whether a backup folder is encrypted is fixed on the first run and applies to all further versions of that task.',
        'Before every further run, all/backed checks the passphrase against the existing data. A different passphrase stops the run before anything is written — so a backup can never end up with two different keys.',
      ],
    },
    {
      id: 'run',
      title: 'Running a backup',
      body: [
        'Start: F5 or the Start button in the footer bar.',
        'Phases: scanning sources → backing up → verifying → writing manifest → done. The terminal log shows the current file, the progress bar and the block counters live.',
        'Afterwards a banner sums up the run: completion time, duration, files, new and deduplicated blocks, verify result. In archive mode, the .tar archive download starts as well.',
        'The last run stays visible — as a card in the detail view and as the status dot in the sidebar.',
        'If a run fails, earlier versions remain unchanged and restorable. The new version only appears once verification has passed.',
        'Backed up are files with their content and relative path. Empty folders, permissions and modification times are not recreated on restore.',
        'If a file is locked during the run (e.g. an open Outlook .pst on Windows), changes while it is being read or is deleted meanwhile, or a subfolder cannot be read, all/backed skips just those entries. The banner and the “Last run” card list them in yellow; they are missing from this version — close the program and back up again. Missing access rights, on the other hand, stop the run.',
        '[Cancel] in the header of the terminal log stops the run after the current block. No new version is created, earlier versions stay unchanged, and the “Last run” card keeps showing the previous run. Blocks already written are complete and are reused by the next run.',
        'If the tab is closed mid-run, the browser crashes or the drive is unplugged, no new version is created either. A block that was only created but left empty is written again by the next run instead of counting as stored.',
        'If the destination drive is briefly locked (on Windows e.g. by a virus scanner, the search indexer or OneDrive), all/backed retries writing a block up to three times before the run ends with a message.',
      ],
    },
    {
      id: 'restore',
      title: 'Restoring',
      body: [
        '“Restore” in the sidebar or F6 opens the view.',
        'In Chrome, pick your backup destination folder — the one containing the “allbacked” directory. all/backed scans it and lists every backup it finds (one per task).',
        'In archive mode, pick the downloaded .tar archive instead; it is unpacked locally and scanned the same way.',
        'Encrypted backups are marked “encrypted” and ask for the passphrase; it is validated immediately against the newest version.',
        'Every backup run appears as a version with a timestamp (in your local time). “Restore this version” asks for a target folder and restores the files into it.',
        'If the target folder is not empty, all/backed first shows what is in it and asks: “Overwrite & restore” replaces files with the same name, “Choose another folder” opens the picker again, “Cancel” writes nothing. An empty folder is the safest choice. A folder inside the backup itself (allbacked/…) and a folder that contains the backup (e.g. the backup drive itself or the “allbacked” folder) are refused as a target — choose a new, empty folder instead.',
        'File names Windows or macOS do not allow (“a:b.txt”, “note?.md”, “CON.txt”, names starting or ending with a dot, space or “~” such as “~$offer.docx”, invisible control and format characters as in some emoji sequences) are restored with “_” in place of the character (“a_b.txt”, “_CON.txt”). The browser does not let any page create shortcuts (“.lnk”, “.url”) or “desktop.ini”; they come back as “Customer.lnk_” or “_desktop.ini” and work again once renamed. Files that differ only in upper/lower case (e.g. from Linux) get a number (“readme (2).txt”) instead of overwriting each other. all/backed lists every renamed file with its old and new name after the run.',
        'Every block is checked against its checksum during restore. If a file cannot be restored (damaged block, target file locked for good), it is skipped and listed below; all other files are still restored. Half-written files never remain — not even with [Cancel]: the file being written is discarded, finished ones stay in the target folder. If a target file is only briefly locked (on Windows e.g. by a virus scanner or OneDrive), all/backed writes it again completely up to three times before it counts as failed; an existing file keeps its old content until the new one is complete.',
        'In archive mode, the result is downloaded as restored-<date>.tar — unpack it to get your files. all/backed deletes the unpacked staging data in browser storage on its next start.',
      ],
    },
    {
      id: 'dedup',
      title: 'Deduplication & verify',
      body: [
        'all/backed splits every file into blocks of up to 4 MiB. Each block is identified by its SHA-256 checksum, compressed and — with encryption enabled — stored encrypted.',
        'A block that already exists in the backup is not stored again. That’s why follow-up backups are small and fast: only new and changed data creates new blocks.',
        'Every run writes a manifest — the version list: which files, made of which blocks, with which timestamps. Older versions therefore remain fully restorable.',
        'At the end of every run, all/backed reads back a random sample of blocks, decompresses or decrypts them and compares the checksum. Only if everything matches does the run report “verify OK”.',
        'At the destination this creates the structure allbacked/<task>/ with blocks/ and manifests/ — please don’t reorganize it by hand.',
      ],
    },
    {
      id: 'keys',
      title: 'Keyboard & F-keys',
      body: [
        '• F1 — open and close the help',
        '• F2 — create a new task',
        '• F5 — back up the current task',
        '• F6 — open restore',
        '• F8 — delete the task (press twice, as a safeguard)',
        'In the tutorial, the arrow keys ← → page through the steps; Esc closes the help.',
        'Mac keyboards: if F1–F12 control brightness or volume, also hold the fn key (or turn on “Use F1, F2, etc. keys as standard function keys” in System Settings → Keyboard). Every function can also be clicked in the footer bar.',
      ],
    },
    {
      id: 'lang',
      title: 'Language & appearance',
      body: [
        'Switch between EN and DE at the bottom left of the sidebar.',
        'On first start, all/backed follows your browser language; your choice is saved on this device and sticks.',
        'Right next to it, the sun/moon icon toggles between dark and light mode. Dark terminal look is the default; this choice is saved on this device as well.',
      ],
    },
    {
      id: 'roadmap',
      title: 'What’s coming',
      body: [
        'The “Automation” card in the task view is a preview: schedules — backups that run on their own — come with Pro.',
        'The free tier keeps everything described here: manual backups, encryption, deduplication, restore.',
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy',
      body: [
        'all/backed works entirely locally: no account, no cloud, no telemetry. The app sends nothing over the network.',
        'Only what you explicitly select gets backed up. Backups live where you put them — in your destination folder or in the downloaded archive.',
        'Even if a browser dialog says “Upload”: nothing is uploaded. The dialog wording comes from the browser; the data stays on the device.',
        'Encryption happens before anything is written, right in the browser — details in the “Encryption” section.',
      ],
    },
  ],
};

const SEEN_KEY = 'ab.tutorialSeen';

function tutorialSeen(): boolean {
  try {
    return Boolean(localStorage.getItem(SEEN_KEY));
  } catch {
    return false;
  }
}

function markTutorialSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* storage blocked */
  }
}

function Body({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-2.5 text-sm leading-relaxed text-slate-300 light:text-slate-700">
      {lines.map((line, i) =>
        line.startsWith('• ') ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="shrink-0 text-primary-400 light:text-primary-700">›</span>
            <span>{line.slice(2)}</span>
          </div>
        ) : line.startsWith('$ ') ? (
          <div key={i} className="rounded-lg border border-slate-700/60 light:border-slate-300 bg-slate-950/70 px-3 py-1.5 light:bg-slate-100">
            <span className="text-primary-400 light:text-primary-700">$ </span>
            {line.slice(2)}
          </div>
        ) : (
          <p key={i}>{line}</p>
        )
      )}
    </div>
  );
}

export default function Help({
  lang,
  onOpenChange,
}: {
  lang: Lang;
  onOpenChange?: (open: boolean) => void;
}) {
  // Help language follows the app language but can be switched in the
  // header at any time (DE/EN) without changing the app setting.
  const [helpLang, setHelpLang] = useState<Lang>(lang);
  useEffect(() => {
    setHelpLang(lang);
  }, [lang]);
  const c = helpLang === 'de' ? de : en;
  const [mode, setMode] = useState<'closed' | 'tutorial' | 'manual'>(() =>
    tutorialSeen() ? 'closed' : 'tutorial'
  );
  const [step, setStep] = useState(0);
  const [sel, setSel] = useState(c.sections[0].id);
  const [q, setQ] = useState('');

  useEffect(() => {
    onOpenChange?.(mode !== 'closed');
  }, [mode, onOpenChange]);

  // F1 / footer button / sidebar ? dispatch this event to open the manual
  useEffect(() => {
    const open = () => setMode((current) => (current === 'closed' ? 'manual' : current));
    window.addEventListener('ab:help', open);
    return () => window.removeEventListener('ab:help', open);
  }, []);

  const close = () => {
    markTutorialSeen();
    setMode('closed');
    setStep(0);
  };

  // keyboard handling only while open — App guards its own F-key listener
  useEffect(() => {
    if (mode === 'closed') return;
    const total = c.tutorial.length;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'F1') {
        event.preventDefault();
        markTutorialSeen();
        setMode('closed');
        setStep(0);
      } else if (mode === 'tutorial') {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          setStep((s) => Math.min(s + 1, total - 1));
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setStep((s) => Math.max(s - 1, 0));
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, c.tutorial.length]);

  if (mode === 'closed') return null;

  const query = q.trim().toLowerCase();
  const filtered = query
    ? c.sections.filter(
        (s) =>
          s.title.toLowerCase().includes(query) ||
          s.body.some((p) => p.toLowerCase().includes(query))
      )
    : c.sections;
  const current = filtered.find((s) => s.id === sel) ?? filtered[0] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm light:bg-slate-900/40"
      onClick={close}
    >
      <div
        className="ab-rise flex h-[85vh] max-h-[44rem] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700/60 light:border-slate-300 bg-slate-900 light:bg-white font-mono shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header: brand, tabs, close */}
        <div className="flex items-center gap-2 border-b border-slate-700/60 light:border-slate-300 px-4 py-3">
          <span className="mr-2 text-sm font-bold tracking-tight">
            <span className="text-primary-400 light:text-primary-700">all/backed</span>
            <span className="text-slate-100 light:text-slate-900">.</span>
          </span>
          {(['tutorial', 'manual'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setMode(tab);
                if (tab === 'tutorial') setStep(0);
              }}
              className={`rounded px-2.5 py-1 text-xs transition-colors ${
                mode === tab
                  ? 'bg-primary-600 text-white'
                  : 'text-slate-400 light:text-slate-600 hover:bg-slate-800 light:hover:bg-slate-200 hover:text-slate-200 light:hover:text-slate-900'
              }`}
            >
              {c.labels[tab]}
            </button>
          ))}
          <div className="flex-1" />
          <div
            className="mr-1 inline-flex overflow-hidden rounded border border-slate-700/60 light:border-slate-300"
            role="group"
            aria-label="Sprache / Language"
          >
            {(['de', 'en'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setHelpLang(l)}
                className={`px-2 py-0.5 text-[11px] tracking-wider transition-colors ${
                  helpLang === l
                    ? 'bg-slate-800 light:bg-slate-200 text-primary-400 light:text-primary-700'
                    : 'text-slate-500 light:text-slate-600 hover:text-slate-200 light:hover:text-slate-900'
                } ${l === 'en' ? 'border-l border-slate-700/60 light:border-slate-300' : ''}`}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={close}
            aria-label={c.labels.close}
            className="rounded px-2 py-1 text-slate-500 light:text-slate-600 transition-colors hover:bg-slate-800 light:hover:bg-slate-200 hover:text-slate-200 light:hover:text-slate-900"
          >
            ✕
          </button>
        </div>

        {mode === 'tutorial' && (
          <>
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mb-2 text-xs text-slate-500 light:text-slate-600">
                {'// '}
                {c.labels.stepOf(step + 1, c.tutorial.length)}
              </div>
              <h2 className="mb-4 text-lg font-bold text-slate-100 light:text-slate-900">{c.tutorial[step].title}</h2>
              <Body lines={c.tutorial[step].body} />
            </div>
            <div className="flex items-center gap-3 border-t border-slate-700/60 light:border-slate-300 px-6 py-4">
              <button onClick={close} className="btn-ghost px-3 py-1.5 text-xs">
                {c.labels.skip}
              </button>
              <div className="flex flex-1 justify-center gap-1.5">
                {c.tutorial.map((_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-1.5 rounded-full ${
                      i === step ? 'bg-primary-400 light:bg-primary-600' : 'bg-slate-700 light:bg-slate-300'
                    }`}
                  />
                ))}
              </div>
              {step > 0 && (
                <button onClick={() => setStep(step - 1)} className="btn-ghost px-4 py-1.5 text-xs">
                  {c.labels.back}
                </button>
              )}
              {step < c.tutorial.length - 1 ? (
                <button onClick={() => setStep(step + 1)} className="btn-primary px-5 py-1.5 text-xs">
                  {c.labels.next}
                </button>
              ) : (
                <button onClick={close} className="btn-primary px-5 py-1.5 text-xs">
                  {c.labels.done}
                </button>
              )}
            </div>
          </>
        )}

        {mode === 'manual' && (
          <div className="flex min-h-0 flex-1">
            <div className="flex w-40 shrink-0 flex-col border-r sm:w-56 border-slate-700/60 light:border-slate-300">
              <div className="p-3">
                <input
                  type="text"
                  className="input px-2 py-1.5 text-xs"
                  placeholder={c.labels.search}
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                />
              </div>
              <div className="flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
                {filtered.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-slate-500 light:text-slate-600">{c.labels.noResults}</div>
                )}
                {filtered.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => setSel(section.id)}
                    className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
                      current?.id === section.id
                        ? 'bg-primary-600 text-white'
                        : 'text-slate-400 light:text-slate-600 hover:bg-slate-800 light:hover:bg-slate-200 hover:text-slate-200 light:hover:text-slate-900'
                    }`}
                  >
                    {section.title}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {current && (
                <>
                  <h2 className="mb-4 text-lg font-bold text-slate-100 light:text-slate-900">{current.title}</h2>
                  <Body lines={current.body} />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
