# Kritik zu `avycloud-master-plan.md`

> Stand: 2026-06-17  
> Ziel: Ergänzende Kritikpunkte als separates Dokument.  
> Wichtig: Dieses Dokument ändert **nichts** am Master-Plan, sondern ergänzt ihn.

---

## Kurzfazit

`avycloud-master-plan.md` ist inhaltlich stark und deutlich besser als ein typischer Feature-Plan.  
Für echten Public-SaaS-Betrieb fehlen aber noch einige operative und governance-kritische Bausteine.

---

## Kritische Lücken (Priorität hoch)

## 1) Ownership je Fundament ist nicht hart genug definiert
- Es ist klar, **was** gebaut werden soll, aber nicht eindeutig genug, **wer** pro Fundament die finale Verantwortung trägt.
- Ohne klare Verantwortliche entstehen Verzögerung, Unklarheit bei Entscheidungen und Risiko im Incident-Fall.

**Was fehlt konkret**
- Ein Owner pro Fundament (F0–F5)
- Ein technischer Stellvertreter
- Eine finale Go/No-Go-Instanz

## 2) Rollback-Runbooks pro Cutover fehlen auf Ausführungsniveau
- Der Plan beschreibt saubere Migrationen, aber nicht präzise genug den Rückweg je Phase.
- Im Ernstfall muss innerhalb weniger Minuten klar sein: welcher Schalter, welche Reihenfolge, welches erwartete Verhalten.

**Was fehlt konkret**
- Pro Cutover ein 15-/30-Minuten-Rollback-Ablauf
- Klare Stop-Kriterien („ab hier sofort zurück“)
- Nach-Rollback-Validierung (welche 3 Checks müssen grün sein)

## 3) Datenmigrations-Abnahme ist zu wenig formalisiert
- Shadow/Strangler ist richtig, aber es fehlt eine verpflichtende Nachweisstruktur je Migration.
- Für Public-SaaS reicht „sieht gut aus“ nicht; es braucht überprüfbare Freigabeprotokolle.

**Was fehlt konkret**
- Vorher/Nachher-Protokoll je Migration
- Pflicht-Stichprobe über kritische Fälle (Bestand, Aufträge, Retoure, Identify)
- Formale Abnahme mit Sign-off

---

## Wichtige Lücken (Priorität mittel)

## 4) Last- und Skalierungsziele sind nicht ausreichend konkret
- Launch-Gates sind gut, aber reale Lastprofile fehlen noch: ab welcher Tenant-/Order-/SKU-Last gilt „stabil“.

**Was fehlt konkret**
- Zielwerte für gleichzeitige Mandanten
- Zielwerte für Spitzenlast (Order-/Sync-/Identify-Volumen)
- Klare Performance-Grenzen als Launch-Bedingung

## 5) Security/Compliance-Gates vor Public fehlen als explizite Pflichtliste
- Tenant-Isolation ist enthalten, aber Public-SaaS braucht zusätzlich eine explizite Sicherheits- und Compliance-Freigabe.

**Was fehlt konkret**
- DSGVO-Checkliste (Export, Löschung, Datenhaltung)
- Secret-/Credential-Härtung
- Rechte-/Rollen-Prüfung über alle kritischen Endpunkte

## 6) Day-2-Operations ist noch nicht als Betriebsmodell ausdefiniert
- Der Plan ist stark beim „Bauen“, aber schwächer beim „dauerhaft Betreiben“ nach Launch.

**Was fehlt konkret**
- On-Call/Eskalationsmodell
- Incident-Kommunikation intern + kundenseitig
- Regelbetrieb der ersten 30/60/240 Minuten bei P1/P0

---

## Empfehlungs-Reihenfolge (ergänzend zum Master-Plan)

1. Ownership + Entscheidungsrechte pro Fundament fixieren  
2. Rollback-Runbooks pro Phase verbindlich schreiben  
3. Migrations-Abnahme mit formalen Sign-offs einziehen  
4. Last-/Skalierungs-Grenzen als Launch-Gates ergänzen  
5. Security/Compliance-Checklist als Pflicht-Gate verankern  
6. Day-2-Operations als verbindliches Betriebsmodell ergänzen

---

## Abschlussbewertung

Der Master-Plan ist eine starke Basis.  
Mit den oben genannten Ergänzungen wird er nicht nur technisch robust, sondern auch **operativ belastbar** für Public-SaaS.
