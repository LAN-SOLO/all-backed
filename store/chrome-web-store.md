# Chrome Web Store — Listing (Beta v0.1.0)

Paket bauen: `pnpm build && pnpm pack:chrome` → `all-backed-chrome-v0.1.0.zip`
Upload: https://chrome.google.com/webstore/devconsole (einmalig 5 USD Registrierung)

**Beta-Empfehlung:** Sichtbarkeit **„Nicht gelistet"** (unlisted) — installierbar
über Direktlink, taucht nicht in der Suche auf. Für den Public Launch später auf
„Öffentlich" stellen.

## Store-Eintrag

| Feld | Wert |
| --- | --- |
| Name | all backed |
| Kategorie | Productivity → Tools |
| Sprachen | Englisch (Standard) + Deutsch |

**Kurzbeschreibung / Summary (max. 132 Zeichen):**

- EN: `Simple, encrypted local backups to external drives — straight from your browser. No system files, no cloud, no account.`
- DE: `Einfache, verschlüsselte lokale Backups auf externe Laufwerke — direkt aus dem Browser. Ohne Cloud, ohne Konto.`

**Ausführliche Beschreibung EN:**

```
all backed is a free backup tool that runs entirely in your browser.

$ allbacked --free --local --encrypted

WHAT IT DOES
• Back up any folder to an external drive — pick source, pick destination, done
• AES-256 encryption in the browser; the key is derived from your passphrase
  and never leaves your device
• Block-level deduplication and gzip compression: repeated runs only store
  what changed
• Every backup is verified after it runs; every version stays restorable
• Restore single versions to any folder — no account, no cloud, no tracking

FREE TIER LIMITS
Browsers cannot read system files (by design), so all backed Free backs up
your documents, projects and media — not your operating system. Complete
system backups, schedules and cloud targets are coming in all backed Pro
(companion app for macOS, Windows and Linux).

PRIVACY
Everything happens locally. The extension makes no network requests, collects
no data and needs no account. Details: https://lan-solo.com/en/privacy/

Made by LAN-SOLO — https://lan-solo.com/en/tools/all-backed/
```

**Ausführliche Beschreibung DE:**

```
all backed ist ein kostenloses Backup-Tool, das vollständig im Browser läuft.

$ allbacked --free --local --encrypted

WAS ES KANN
• Beliebige Ordner auf ein externes Laufwerk sichern — Quelle wählen,
  Ziel wählen, fertig
• AES-256-Verschlüsselung im Browser; der Schlüssel entsteht aus Ihrer
  Passphrase und verlässt Ihr Gerät nie
• Blockbasierte Deduplizierung und gzip-Kompression: Folgeläufe speichern
  nur, was sich geändert hat
• Jedes Backup wird nach dem Lauf geprüft; jede Version bleibt wiederherstellbar
• Einzelne Versionen in beliebige Ordner zurückspielen — ohne Konto,
  ohne Cloud, ohne Tracking

GRENZEN DES FREE-TIERS
Browser dürfen aus guten Gründen keine Systemdateien lesen. all backed Free
sichert daher Dokumente, Projekte und Medien — nicht das Betriebssystem.
Komplette Systemsicherungen, Zeitpläne und Cloud-Ziele kommen mit
all backed Pro (Companion-App für macOS, Windows und Linux).

DATENSCHUTZ
Alles passiert lokal. Die Extension stellt keine Netzwerkverbindungen her,
sammelt keine Daten und braucht kein Konto.
Details: https://lan-solo.com/de/privacy/

Von LAN-SOLO — https://lan-solo.com/de/tools/all-backed/
```

## Grafiken

| Asset | Anforderung | Quelle |
| --- | --- | --- |
| Icon | 128×128 PNG | `public/icons/icon128.png` (im Paket enthalten) |
| Screenshots | 1–5 × 1280×800 (JPEG/PNG, keine Transparenz) | `store/screenshots/` |
| Small promo tile | 440×280 (optional) | TODO bei Public Launch |

## Datenschutz-Angaben (Privacy-Tab der Dev-Konsole)

- **Single purpose:** "Create encrypted local backups of user-selected folders
  and restore them. All processing happens locally in the browser."
- **Berechtigungen begründen:**
  - `storage` — "Persists the user's backup task definitions locally."
  - `unlimitedStorage` — "Backup data is staged/deduplicated locally; backups
    can exceed the default storage quota."
- **Remote code:** No
- **Datenerhebung:** "Does not collect or transmit any user data" — alle
  Checkboxen leer, Zertifizierung bestätigen
- **Privacy Policy URL:** https://lan-solo.com/en/privacy/

## Review-Hinweise (Feld „Notes for reviewers")

```
The extension performs local file backups using the File System Access API.
No network requests are made at any time (verifiable: no host permissions,
no fetch/XHR in the code). Test: open the toolbar action, create a task,
pick any folder as source and an empty folder as destination, run the backup,
then use "Restore" to restore it.
```

# Firefox (AMO) — Listing-Notizen (Beta)

Paket: `pnpm build:firefox && pnpm pack:firefox` → `all-backed-firefox-v0.1.0.zip`
Upload: https://addons.mozilla.org/developers/ (Beta: als „Unlisted" signieren
lassen und die .xpi direkt verteilen, oder Listed mit Beta-Hinweis).

- Add-on-ID: `allbacked@lan-solo.com` (in `manifest.firefox.json`)
- Minimum: Firefox 115 (OPFS + MV3 event pages)
- Firefox-Besonderheit in der Beschreibung erwähnen: Da Firefox die File System
  Access API nicht anbietet, arbeitet all backed dort im **Archiv-Modus**:
  Quelle per Ordner-Auswahl, Backup wird lokal vorbereitet und als .tar-Archiv
  heruntergeladen; Restore liest dieses Archiv wieder ein.
- Datenschutz identisch: keine Netzwerkzugriffe, keine Datenerhebung.
