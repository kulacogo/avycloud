# AvyCloud Druck-Agent

Holt Druckaufträge aus AvyCloud und schickt sie an den richtigen
Etikettendrucker. Damit sieht der Bediener am Handscanner **nie wieder Androids
Teilen-/Druckauswahl** und muss **nie wieder den Drucker raten**.

## Warum ein eigenes Programm

Das Backend läuft auf Cloud Run in `europe-west3` und kann eine private
LAN-Adresse (`192.168.x.x`) **prinzipiell nicht** erreichen. Und der Browser des
Handscanners darf von einer HTTPS-Seite aus kein `http://` im lokalen Netz
aufrufen (gemischte Inhalte werden blockiert). Beide Wege sind zu.

Also andersherum: AvyCloud legt den Auftrag ab, der Agent im Büro holt ihn.
Gleiches Muster wie `tools/foto-agent/`.

## Die zwei Rollen

| Rolle    | Maß          | Transporteur          | ENV               |
|----------|--------------|-----------------------|-------------------|
| `parcel` | 103 × 164 mm | DHL, DPD              | `PRINTER_PARCEL`  |
| `letter` |  62 × 100 mm | Deutsche Post         | `PRINTER_LETTER`  |

Welches Etikett welche Rolle hat, entscheidet **das Backend**
(`backend/lib/label-format.js`) — nie der Agent. Zwei Wahrheiten würden
auseinanderdriften.

**Fehlt ein Druckername, wird NICHT gedruckt.** Der Agent weicht bewusst nicht
auf den Standarddrucker aus: ein 103-mm-Paketetikett auf der 62-mm-Briefrolle
hat einen abgeschnittenen Barcode, und das Paket bleibt im Verteilzentrum
liegen.

## Windows — Zielrechner 192.168.178.61

Betreiberentscheidung 08.10.2026: Die dauerhafte Station läuft auf dem Windows-Rechner `192.168.178.61`. Die früher am Mac gemessenen Druckernamen sind **keine** Bestätigung der Windows-Konfiguration. Seit 09.10. ist der Rechner als `09410-DRIVE` über Tailscale `100.83.3.111` erreichbar. Tailscale dient dem Zugang bzw. der Dateiübertragung; der Agent holt Aufträge weiterhin ausgehend per HTTPS. Eine VPN-Verbindung allein ermöglicht keine Ferninstallation.

**Fehlender Paketdrucker:** Eine macOS-/AirPrint-Einrichtung ist keine Windows-Einrichtung. Der QL-1110NWB muss auf dieser Windows-Station mit dem Brother-Treiber als Netzwerkdrucker vorhanden sein. [Offizieller Brother-Installer](https://support.brother.com/g/b/downloadend.aspx?c=de&dlid=dlfp100033_000&flang=191&lang=de&os=10069&prod=lpql1110nwbeuk&type3=10164). Das Setup prüft die Druckerliste vor Downloads oder Änderungen an einer vorhandenen Station.

1. Beide Brother-Drucker mit Windows-Treiber und den Rollen **103×164 mm** bzw. **62×100 mm** einrichten. Drucker müssen rechnerweit verfügbar sein, nicht ausschließlich als Verbindung im Benutzerprofil.
2. Setup-Paket vollständig entpacken. Rechtsklick auf `Einrichten.cmd` → **Als Administrator ausführen**. Alternativ `install-windows.ps1` in einer administrativen PowerShell ausführen. Es werden keine Firewall- oder Fernzugriffsregeln geöffnet.
3. Paket- und Briefdrucker aus den tatsächlich passenden Treiberformaten auswählen. Zwei **TEST – KEIN PORTO**-Etiketten werden bereits unter dem späteren Dienstkonto ausgegeben. Rollen, Rahmen und QR-Codes physisch prüfen. Erst nach `JA` geht die Einrichtung weiter.
4. AvyCloud-Konto mit `orders:read` und `orders:ship` lokal anmelden. Passwort wird verdeckt eingegeben und nicht gespeichert; nur die erneuerbare Sitzung bleibt geschützt auf diesem Rechner.
5. Setup startet die Aufgabe **AvyCloud Print Agent** und wartet auf einen frischen Heartbeat dieser Station. Beim alten Backend lautet der Zustand „wartet auf Protokoll 2“. Nach Backend-Release erneut den Onlinezustand prüfen.

Die Aufgabe startet beim Booten als **LocalService**, ohne angemeldeten Windows-Benutzer und ohne Administratorrechte zur Laufzeit. Wiederanlauf nach Prozessabbruch über Task Scheduler. Der Rechner muss wach und online bleiben. Benötigt ausgehend HTTPS; keine eingehenden Ports für AvyCloud.

Laufzeit, `config.json`, `session.json`, `agent.log`, `verification.json` und das bleibende `journal/` liegen in `%ProgramData%\AvyCloud Print Agent`. Verzeichnisrechte ausschließlich für LocalService, SYSTEM und Administratoren. `journal/` bei Updates **erhalten**. Das Setup hält einen vorhandenen Dienst während der Aktualisierung an. Bei abgebrochener Einrichtung bleibt er angehalten; Protokoll prüfen und Setup fertig ausführen. Zum Anhalten in einer administrativen PowerShell: `Stop-ScheduledTask -TaskName 'AvyCloud Print Agent'`; für dauerhaftes Anhalten zusätzlich `Disable-ScheduledTask`.

`windows-runtime.json` fixiert Node **22.23.3** und SumatraPDF **3.6.1**, Hersteller-URLs und SHA-256-Prüfsummen. Kein npm-Install auf dem Windows-Rechner nötig. PowerShell-ExecutionPolicy wird nur für die jeweiligen gebündelten Skriptprozesse gesetzt, nicht systemweit geändert. `make-test-labels.js` erzeugt die beiden mitgelieferten Test-PDFs aus Backend-Entwicklungsdependencies; zur Laufzeit werden sie nur gelesen.

Vor jeder Ausgabe liest der Adapter die aktuellen Treiberformate. Bei identischen Maßen mehrerer Formen hat das ausdrücklich benannte feste Format (z. B. `62mm x 100mm`) Vorrang vor Endlos-/Custom-/Namensschild-Aliasen; die tatsächlich gemeldeten Maße müssen trotzdem passen. Für exakt benannte feste Formate gilt höchstens 1 mm Abweichung pro Achse, für sonstige Formen weiterhin 0,6 mm. Grund: Der am 09.10.2026 ausgelesene QL-1110NWB-Treiber nennt sein Format `103mm x 164mm` (RawKind385), meldet dafür aber **103,63 × 164,34 mm**; die Drucker-Webverwaltung bestätigt die echte 103×164-mm-Rolle. Setup und laufender Agent berücksichtigen dieselbe begrenzte Abweichung. Mehrere widersprüchliche feste Formate bleiben blockiert. Passendes `PaperSize.RawKind` wird als `paperkind` ausdrücklich an SumatraPDF übergeben; kein Standarddrucker und keine geratene A4-Seite. Temporäres PDF liegt im geschützten Stationsverzeichnis und wird nach dem Aufruf entfernt. SumatraPDFs erfolgreicher Exit nach Druckübergabe erzeugt eine als `sumatra:…` gekennzeichnete Anwendungsquittung – **keine erfundene Windows-Spool-ID und kein Beweis für Papierauswurf**. Dieselbe Journal-/Unsicherheitslogik wie unter macOS verhindert automatischen Wiederholungsdruck nach unklarer Übergabe.

Herstellerquellen: [SumatraPDF-Druckparameter](https://www.sumatrapdfreader.org/docs/Command-line-arguments), [verwendete Implementierung 3.6.1](https://github.com/sumatrapdfreader/sumatrapdf/blob/3.6.1rel/src/Print.cpp), [Windows-Dienstkonto in geplanten Aufgaben](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal), [Treiber-Papierkennung](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.printing.papersize.rawkind).

## macOS — Einrichtung

```bash
bash tools/print-agent/einrichten.sh
```

Fragt E-Mail und Passwort **lokal im Terminal**, Passwort verdeckt. Voraussetzungen: macOS mit CUPS und Node.js ≥20, Rechner im Drucker-LAN, beide Drucker eingerichtet, Konto mit `orders:read` und `orders:ship`.

1. Drucker und Rollenformate prüfen.
2. Bei Firebase anmelden und bestehende Berechtigungen prüfen; keine Rollen ändern.
3. Laufzeit unabhängig vom Git-Checkout nach `~/Library/Application Support/AvyCloud Print Agent/current` kopieren.
4. Nur eine erneuerbare Sitzung in `session.json` speichern (600, Verzeichnis 700). Kein Kontopasswort in plist oder Logs.
5. LaunchAgent installieren/starten und den Heartbeat **dieser Station** abwarten.

Bei Fehlern nach Installation Logs prüfen; ein erfolgreicher Login allein bedeutet keinen erfolgreichen Druck. Erneutes Ausführen aktualisiert dieselbe Station. Mac muss angemeldet, wach und im Drucker-LAN bleiben. Nach Ende dieser Bedingung wird die Station offline.

### Am Gerät gemessen (2026-08-24)

| CUPS-Name       | Beschreibung   | Gerät              | Rolle    |
|-----------------|----------------|--------------------|----------|
| `DHL_DPD_Label` | DHL/DPD Label  | Brother QL-1110NWB | `parcel` |
| `DP_Label`      | DP Label       | Brother QL-820NWB  | `letter` |

Beide führen die Rollenformate **benannt**: `103x164mm` bzw. `62x100mm`.

**Die Namen stehen nirgends fest verdrahtet.** Setup und Agent erkennen den
Drucker am eingelegten **Rollenformat**: nur ein Gerät führt `103x164mm`. Für die
Briefrolle reicht das Maß allein nicht (`DP_Label` und `SKU_Label` führen beide
`62x100mm`), deshalb scheidet der Paketdrucker dort aus (er führt beide Maße) und
`SKU` wird abgewertet. Bei Gleichstand wird **nicht geraten** — dann
`PRINTER_PARCEL` / `PRINTER_LETTER` setzen, die gewinnen immer.

Hintergrund: Am 2026-08-24 wurde `Versandlabel` in `DHL_DPD_Label` umbenannt und
die Einrichtung brach ab, weil der Name fest eingetragen war.

### Prüfung ohne Produktionsaufträge

```bash
node tools/print-agent/index.js --list-printers
node tools/print-agent/index.js --dry-run
```

`--dry-run` prüft die Druckerkonfiguration, holt **keine** Aufträge ab und druckt nichts. Für manuellen Dauerbetrieb die vom Installer erzeugte `AGENT_SESSION_FILE` sowie Backend-URL und öffentlichen Firebase-Key setzen; keine Passwörter in Shell-Historien ablegen.

## Warum `103x164mm` und nicht `Custom.103x164mm`

Das ist **nicht dasselbe**. Der benannte Eintrag ist die vom Treiber kalibrierte
Rollenvorlage samt der echten nicht bedruckbaren Ränder; bei `Custom.` schätzt
CUPS die Ränder selbst. Der Unterschied fällt als *versetzter Druck* auf — und
niemand findet die Ursache.

Der Agent liest deshalb beim Start `lpoptions -p <Drucker> -l` und nimmt den
benannten Eintrag, wenn der Drucker ihn führt. Beim Start meldet er, welcher Weg
gilt:

```
103x164 mm -> "DHL_DPD_Label" (media=103x164mm, kalibriert)
62x100 mm -> "DP_Label" (media=62x100mm, kalibriert)
```

Steht dort `geschätzt`, führt der Drucker das Maß nicht benannt — dann lohnt es,
das Rollenformat im Treiber anzulegen.

## Weitere Schalter

| Variable              | Vorgabe | Bedeutung |
|-----------------------|---------|-----------|
| `PRINT_AGENT_ID`      | Rechnername | Kennung in der Agentenliste |
| `PRINT_POLL_MS`       | `2000`  | Abfragetakt |
| `PRINT_FIT_TO_PAGE`   | `on`    | `off` = ohne Einpassen drucken |

`PRINT_FIT_TO_PAGE` steht bewusst auf `on`: Das PDF hat bereits exakt das
Rollenmaß, aber jeder Drucker hat einen nicht bedruckbaren Rand. Ohne Einpassen
schneidet genau dieser Rand den Barcode an. Das Einpassen behält das
Seitenverhältnis bei, es verzerrt nichts.

## Dauerbetrieb und Wiederanlauf

Der Installer verwaltet `~/Library/LaunchAgents/de.trendocean.print-agent.plist`. Laufzeit, private Sitzung und Logs liegen unter `~/Library/Application Support/AvyCloud Print Agent/`. Das Verzeichnis `journal/` enthält die dauerhaften Druckquittungen und darf bei Updates nicht entfernt werden.

Gegen ein altes Backend wartet der Agent vor dem Claim auf dessen Protokoll-2-Update. Nach dem Rollout müssen neue Heartbeats und Druckquittungen geprüft werden.

Protokoll 2 setzt vor CUPS `dispatching`. Nach Annahme durch `lp` wird die Quittung vor der HTTP-Erfolgsmeldung gespeichert. Nach einer verlorenen Antwort sendet der Agent nur die Quittung erneut. Ein Absturz ohne sichere Quittung führt zu `uncertain`: Drucker prüfen und bei Bedarf ausdrücklich dasselbe Label erneut ausgeben. Keine automatische Doppelkopie.

`done` belegt CUPS-Annahme, keinen Papierauswurf. Daher bestätigt der Mitarbeiter in AvyCloud abschließend „Label angebracht · fertig“.

## Offline und Inbetriebnahme

Die neue Handheld-Packansicht zeigt eine fehlende Station offen an und bleibt bei der Labelaufgabe. Sie wechselt nicht still in Androids Druckdialog. Deshalb diese Oberfläche erst produktiv schalten, wenn die Station eingerichtet und geprüft ist.

Abnahme: frische Protokoll-2-Heartbeats, korrekte Zuordnung beider Rollen, je ein als TEST gekennzeichneter Ausdruck auf 103×164 und 62×100 mm, Maße/Ränder/Barcode am Gerät prüfen. Keine echten Versandlabels allein zu Testzwecken kaufen. Ein lokaler Mock ersetzt diese Prüfung nicht.

## Tests

```bash
cd tools/print-agent
npm test
```

Die Agent-Tests laufen zusätzlich im Wurzel-`npm test` mit. Sie prüfen Medienwahl, Quittungswiederholung, unklare Übergabe und die passwortfreie Installation.
