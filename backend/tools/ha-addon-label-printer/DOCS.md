# Label Print Proxy

Empfängt PDF-Versandlabels von AvyCloud und druckt sie automatisch auf dem Brother QL-1110NWB Labeldrucker via IPP.

## Konfiguration

| Option | Standard | Beschreibung |
|---|---|---|
| `printer_ip` | `192.168.178.24` | IP-Adresse des Brother QL-1110NWB |
| `printer_port` | `631` | IPP-Port des Druckers |
| `proxy_port` | `3001` | Port auf dem der Proxy lauscht |

## AvyCloud Einrichtung

1. Add-on installieren und starten
2. In AvyCloud: **Einstellungen > Profil > Label-Drucker Proxy URL**
3. URL eingeben: `http://homeassistant.local:3001`
4. Speichern

Ab jetzt werden Versandlabels nach dem Verpacken automatisch gedruckt.
