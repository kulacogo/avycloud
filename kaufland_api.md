Hier ist eine strukturierte und vollständige API-Dokumentation für die **Kaufland Marketplace Seller API v2**, die speziell darauf ausgelegt ist, von einem LLM (z. B. in Cursor AI) verstanden und implementiert zu werden. Sie fokussiert sich auf die Authentifizierung, das Bestellmanagement und die Erstellung von Listings.

***

# Kaufland Marketplace Seller API v2 – LLM Integration Guide

## 1. Basis-Informationen
*   **Production Base URL:** `https://sellerapi.kaufland.com/v2`
*   **Playground (Test-Umgebung) Base URL:** `https://sellerapi-playground.kaufland.com/` (Beachte: Für den Playground sind spezielle Sandbox-Keys erforderlich, die Einrichtung kann bis zu 2 Wochen dauern)
*   **Rate Limits:** Maximal 111 Requests pro Sekunde. Bei Überschreitung antwortet die API mit dem HTTP-Statuscode `429 Too Many Requests`. Das LLM muss ein Retry-Handling für 429-Fehler implementieren.
*   **Datenformat:** JSON (UTF-8 encodiert). Pagination erfolgt über die Parameter `limit` und `offset`.

---

## 2. Authentifizierung & Header (Wichtig für das LLM)
Jeder API-Aufruf muss authentifiziert werden. Es gibt keinen anonymen Zugriff. Folgende HTTP-Header sind **zwingend** bei jedem Request mitzusenden:

1.  `Accept`: `application/json`
2.  `Content-Type`: `application/json` (Nur bei POST/PATCH/PUT Requests)
3.  `User-Agent`: Name der Software oder `"Inhouse_development"`
4.  `Shop-Client-Key`: Dein API Client Key (32 Zeichen)
5.  `Shop-Timestamp`: Aktueller Unix-Timestamp in Sekunden (darf maximal 5 Minuten von der Serverzeit abweichen)
6.  `Shop-Signature`: Generierter HMAC-SHA256 Hash (siehe unten)

*(Hinweis für Software-Provider, die mehrere Händler verwalten: Hier müssen zusätzlich `Shop-Partner-Client-Key` und `Shop-Partner-Signature` gesendet werden.)*

### Algorithmus zur Generierung der `Shop-Signature`
Das LLM muss diesen exakten Signatur-Algorithmus implementieren:

1.  **String to Sign erstellen:**
    Konkateniere folgende Werte, getrennt durch einen Zeilenumbruch (`\n`):
    *   `METHOD` (z. B. `GET`, `POST` – zwingend in Großbuchstaben)
    *   `URI` (Die komplette URL inkl. `https://` und Domain)
    *   `BODY` (Der rohe Request-Body als String. Bei `GET` oder leeren Bodys muss ein leerer String verwendet werden)
    *   `TIMESTAMP` (Der gleiche Unix-Timestamp in Sekunden, der im Header gesendet wird)
2.  **Hashing:**
    Erstelle einen SHA-256 HMAC Hash von diesem String. Verwende als Schlüssel den **Secret Key** (64 Zeichen). Der Secret Key ist ein String und darf *nicht* als Hex-Wert interpretiert werden.
3.  Das Ergebnis muss base64-encodiert im Header gesendet werden.

---

## 3. Listings erstellen (Units / Angebote)
Bei Kaufland werden Bestände und Angebote für spezifische Produkte als **"Units"** bezeichnet. Um eine Unit zu erstellen, muss das grundlegende Produkt (Produktdaten wie Titel, Beschreibung) bereits über die EAN im System von Kaufland existieren.

### Unit (Listing) erstellen
*   **Endpoint:** `POST /units`
*   **Beschreibung:** Fügt einem Produkt ein Verkaufsangebot (Unit) hinzu.
*   **Regeln:** Der übermittelte Preis (`listing_price`) muss größer als null sein.
*   **Erfolgs-Response:** HTTP Status `201 Created`. Die Response-Header enthalten die `Location` der neu erstellten Unit.

*(Tipp für das LLM: Falls große Mengen an Listings erstellt werden müssen, empfiehlt sich stattdessen der CSV-Upload via `POST /import-files/inventory-feed`, der asynchron verarbeitet wird.)*

### Weitere Unit-Aktionen
*   **Unit abrufen:** `GET /units/{id_unit}`
*   **Unit aktualisieren:** `PATCH /units/{id_unit}` (Aktualisiert einzelne Felder)
*   **Unit löschen:** `DELETE /units/{id_unit}` (Gibt Status `204 No Content` zurück)

---

## 4. Bestellungen verwalten (Orders)
Informationen über verkaufte Produkte werden über die REST API als "Orders" (Bestellungen) bereitgestellt. Kaufland unterteilt diese in komplette Bestellungen (`orders`) und einzelne Bestellpositionen (`order-units`).

### Bestellungen abrufen
*   **Alle Bestellungen abrufen:** `GET /orders`
*   **Bestellung via ID abrufen:** `GET /orders/{id_order}`

### Bestellpositionen (Order Units) abrufen & bearbeiten
*   **Liste der Bestellpositionen:** `GET /order-units`
*   **Spezifische Bestellposition:** `GET /order-units/{id_order_unit}`

Das LLM muss folgende Aktionen (via `PATCH`) zur Bestellabwicklung implementieren:
*   **Als versendet markieren:** `PATCH /order-units/{id_order_unit}/send`
*   **Stornieren:** `PATCH /order-units/{id_order_unit}/cancel`
*   **Rückerstattung an Kunden senden:** `PATCH /order-units/{id_order_unit}/refund`

### Rechnungen zu Bestellungen hochladen
Es ist wichtig, Rechnungen hochzuladen, um Kundenanfragen zu minimieren.
*   **Rechnung hochladen:** `POST /order-invoices/{id_order}`

---

## 5. Instruktionen für das Cursor AI / LLM System Prompt
*Bitte berücksichtige diese Anweisungen beim Schreiben des API-Clients:*

*   **API-Client-Struktur:** Erstelle eine zentrale Client-Klasse (`KauflandApiClient`), die die Base-URL, den Client-Key und den Secret-Key initialisiert.
*   **Zentrale Request-Methode:** Implementiere eine private Methode für alle Requests, die automatisch den Timestamp generiert, den Payload parst, den Signatur-String exakt nach Vorgabe (`METHOD\nURI\nBODY\nTIMESTAMP`) zusammenbaut und den HMAC-SHA256 Hash berechnet.
*   **Storefront & Locale:** Kaufland unterstützt verschiedene Ländershops (Storefronts, z. B. `de` für Deutschland) und Sprachen (Locales, z. B. `de-DE`). Baue die API so auf, dass bei Suchen oder Produkt-Updates der Parameter `storefront` (z. B. `?storefront=de`) flexibel an die Endpunkte übergeben werden kann.
*   **Fehlerbehandlung:** Wenn Status `429` auftritt, implementiere ein Exponential Backoff.
*   **Typisierung:** Stelle sicher, dass die Models für Orders und Units korrekt als Objekte oder Collections verarbeitet werden.