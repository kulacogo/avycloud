# Kaufland-Bestellungen in Fremdwährung (CZK/PLN) — Design

Datum: 2026-10-05 · Status: in Umsetzung · Branch `fix/kaufland-order-currency`

## Vorfall

Bestellung **M53KUW5** von kaufland.cz (03.10.2026): der Käufer zahlte **534,14 CZK**.
AvyCloud speicherte `totalAmount: 534.14`, `currency: 'EUR'` — Bestellliste, Auftragsdetail,
Dashboard-Umsatz, Finanzbericht, Tracking-Pflicht-Schwelle und Rechnung sehen damit einen
Auftrag über 534,14 **Euro** (richtig wären ≈ 21,83 €, EZB-Kurs 24,470 vom 02.10.2026).
Kaufland.pl (PLN) und kaufland.sk (EUR) kommen demnächst dazu.

## Ursache (live gemessen am 05.10.2026, nicht vermutet)

`backend/services/order-intake-kaufland.js mapKauflandOrder()` setzt `currency: 'EUR'` fest
und nimmt `unit.price / 100` als Euro. Die Kaufland-API liefert aber je Position
`currency: "CZK"` und `storefront: "cz"`; `price`, `revenue_gross`, `revenue_net` und
`shipping_rate` sind **Minor Units der Positionswährung** (swagger: Currency-Enum EUR|CZK|PLN,
Storefront-Enum de|cz|sk|pl|at|fr|it|es|nl). Einen Wechselkurs-Endpunkt gibt es nicht.
Kaufland zahlt in Euro aus (Seller-Portal: Auszahlung in Euro wählbar), den verwendeten Kurs
gibt die API nicht heraus; der Buchungsbericht der Storefront `cz` war am 05.10. noch leer.

Gemessen im Bestand: **genau ein** betroffener Auftrag (M53KUW5), alle anderen Kaufland-Aufträge
sind Storefront `de`.

## Entscheidung: `totalAmount` bleibt IMMER Euro, das Original kommt additiv dazu

Rund 25 Lesepfade summieren `order.totalAmount` blind als Euro (Dashboard-Metriken,
Finanzbericht, Erstattungs-Netto, Rechnung, Tracking-Pflicht ab 10 €, Retouren). Sie alle auf
Währungsbewusstsein umzubauen wäre ein Breitband-Eingriff in Yellow-Zone-Dateien. Deshalb:

- `totalAmount`, `items[].priceBrutto`, `currency` sind **immer Euro** (umgerechnet).
- Additiv am Auftrag: `storefront`, `originalCurrency`, `originalTotalAmount`, `exchangeRate`
  (Fremdwährung je 1 EUR, wie die EZB quotiert), `exchangeRateDate`, `exchangeRateSource`
  (`ecb` | `static_fallback`), `exchangeRatePending` (true = mit Notkurs gerechnet, wird beim
  nächsten Abgleich mit echtem Kurs ersetzt), `currencyConvertedAt`.
- Additiv je Position: `originalPrice`, `originalCurrency`.
- Euro-Aufträge bekommen nur `storefront` dazu — sonst Byte für Byte wie heute.

### Kurs: EZB-Referenzkurs des Bestelltages

`backend/lib/fx-rates.js` lädt die 90-Tage-Historie der EZB (`eurofxref-hist-90d.xml`, ohne
Anmeldung, ~92 Tage, CZK und PLN enthalten), hält sie im Prozess und in Firestore
(`system/fx-rates-ecb`, gleiche Stelle wie `system/kaufland-sync-state`; Referenzdaten, kein
Mandantendatum). Für ein Datum gilt der **letzte veröffentlichte Kurs ≤ Bestelldatum**
(Wochenende → Freitag). Fehlt das Datum (älter als 90 Tage, nur Reparaturlauf), wird die volle
Historie geladen. Fällt die EZB aus: **Notkurs** aus einer datierten Tabelle (CZK 24,5 / PLN 4,35,
Stand 05.10.2026) mit `exchangeRatePending: true` — die Größenordnung stimmt (21 € statt 534 €),
der exakte Kurs kommt beim nächsten Abgleich. Der Intake wird NIE blockiert (eine fehlende
Bestellung = keine Reservierung = Oversell-Risiko).

### Selbstheilung über den bestehenden 30-Tage-Abgleich

`saveOrderIfNew` bekommt bei vorhandenem Auftrag einen Heil-Pfad: trägt die frische Zuordnung
eine Fremdwährung und der Bestand ist nie umgerechnet worden (kein `originalCurrency`) oder
`exchangeRatePending`, werden Beträge, Positionspreise (Zuordnung über `unitId`, übrige
Positionsfelder bleiben) und die Zusatzfelder nachgezogen; `grossAmount`/`netAmount` werden bei
vorhandenen `marketplaceRefunds` neu gerechnet; `ops.currencyHeal` hält den Vorgang fest.
Reine Fremdwährung ohne jeden Kurs (`exchangeRateSource: 'none'`) heilt NICHT — nie CZK als Euro
schreiben.

### Retouren

`services/returns-engine.js` (Kaufland): `refundAmount` kommt aus `order_unit.price` (Positions-
währung). Bei `currency !== 'EUR'` wird in Euro umgerechnet — **mit dem Kurs des verknüpften,
bereits umgerechneten Auftrags** (`exchangeRateBasis: 'order'`): eine CZK-Summe, ein Kurs, eine
Vollretoure ist cent-genau der Auftragsbetrag und flippt nie, auch wenn die EZB den Kurs des
Retouren-Tages nachreicht. Nur ohne verknüpften umgerechneten Auftrag gilt der EZB-Kurs des
Retouren-Datums (`'return_date'`). Alle Betragsfelder (`refundAmount`, `revenueGross`,
`revenueNet`, `positions[]`, `product.price`) hängen am selben Kurs; Original additiv
(`originalRefundAmount`, `originalCurrency`, `exchangeRate…`); `orderAmount` folgt einer späteren
Heilung des Auftrags. Buchungsbasierte Beträge gelten als Euro — für `cz`/`pl` **unverifiziert**
(der Buchungsbericht wird nur für `de` gelesen; dort kann keine cz-Position auftauchen).

### Oberfläche

Bestellliste: Euro als Hauptbetrag, darunter klein das Original (`534.14 CZK`). Auftragsdetail:
Betrag mit Original und Kurs („21.83 € · 534.14 CZK · EZB-Kurs 24,470 vom 02.10.2026“),
Positionen und Gesamt mit Original. CSV-Export: Spalten „Originalbetrag“ und „Originalwährung“
hinten angehängt. Reine Darstellung über `utils/orderAmount.ts` (getestet mit `node --test`).

### Reparatur

`backend/scripts/repair-order-currency.js` (Dry-Run-Default, `--apply --confirm CURRENCY_REPAIR_V1`):
holt die Kaufland-Aufträge ohne `originalCurrency` erneut aus der API (Storefront/Währung stehen
nur dort — `raw` wird nicht gespeichert), rechnet um, schreibt denselben Heil-Patch wie der
Abgleich. Druckt Projekt und Vorher/Nachher je Auftrag.

### Schalter

`ORDER_CURRENCY_CONVERSION` (Default an; **nur exakt `'off'`** schaltet ab — dann altes Verhalten,
also der Fehler; Notbremse im Stil von `AUTO_INVOICE`).

## Bewusst NICHT gebaut

- Kein eigener Kurs-Dienst (Frankfurter & Co.) — die EZB-Datei genügt, keine neue Abhängigkeit.
- Kein Umbau der ~25 Lesepfade auf Mehrwährung.
- Kein OSS-/Umsatzsteuer-Umbau (CZ 21 %): die Rechnung bleibt manuell und nutzt `vatRate` des
  Auftrags; eine Rechnung an einen tschechischen Verbraucher ist eine Steuerfrage, keine
  Währungsfrage — notiert, nicht gelöst.
- Buchungsbericht je Storefront (Erstattungen/Gebührensatz lesen heute nur `de`) — Folgearbeit,
  sobald `cz` Buchungen führt (am 05.10. leer).
- eBay: `Total.@_currencyID` wird bereits gelesen; nicht-EUR-Seiten sind heute nicht aktiv.

## Tests

`__tests__/fx-rates.test.js`, `__tests__/order-currency.test.js`,
`__tests__/order-intake-kaufland-currency.test.js` (echtes, anonymisiertes M53KUW5-Payload),
`__tests__/returns-kaufland-currency.test.js`, Frontend `utils/orderAmount.test.ts`.
