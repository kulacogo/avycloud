'use strict';

/**
 * Rahmen der Chat-Schnellaktionen — an EINER Stelle.
 *
 * Die Knöpfe im Chat setzen einen engen Rahmen ("Preischeck" = pricing,
 * "Titel verbessern" = title, "EAN / GTIN finden" = gtin). Die Legacy-Pipeline
 * setzte ihn seit jeher hart durch; die heute laufende V2-Pipeline nahm ihn
 * entgegen, schrieb ihn ins Prompt — und wertete ihn beim Bereinigen NIE aus.
 *
 * Damit konnte ein Klick auf "Preischeck" Titel, Beschreibung, Highlights,
 * Merkmale, Marke und GPSR mitschreiben, und der Mensch konnte nichts davon
 * abwählen: alle Vorschläge stecken in EINER Karte.
 *
 * Eine Bitte im Prompt ist keine Durchsetzung. Diese Regeln liegen deshalb
 * gemeinsam hier, damit die beiden Wege nicht wieder auseinanderlaufen.
 */

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Zerlegt die Rahmen-Angabe und vereinheitlicht Schreibweisen. */
function parseScopeSet(scope = null) {
  const raw = safeString(scope).toLowerCase();
  if (!raw) return new Set();
  const out = new Set();
  raw
    .split(/[,\s|;]+/g)
    .map((token) => safeString(token))
    .filter(Boolean)
    .forEach((tokenRaw) => {
      const token = tokenRaw.toLowerCase();
      if (token === 'all' || token === 'full') {
        out.add('datasheet');
        return;
      }
      if (token === 'ean' || token === 'barcode' || token === 'barcodes') {
        out.add('gtin');
        return;
      }
      if (token === 'attr' || token === 'attrs') {
        out.add('attributes');
        return;
      }
      out.add(token);
    });
  return out;
}

/**
 * Welche Feldgruppen darf ein Lauf mit diesem Rahmen anfassen?
 *
 * Leerer Rahmen = freie Frage im Chat = alles erlaubt. Das ist Absicht: wer
 * frei tippt, will keine künstliche Grenze.
 *
 * Marke und SKU hängen bewusst am Voll-Rahmen: sie sind Identität, keine
 * Textverbesserung. Notizen sind immer erlaubt — sie ändern keine Produktdaten.
 */
function buildScopeAllowMap(scope = null) {
  const scopeSet = parseScopeSet(scope);
  const unrestricted = scopeSet.size === 0 || scopeSet.has('datasheet');
  const allows = (...tokens) =>
    unrestricted || tokens.some((token) => scopeSet.has(String(token || '').toLowerCase()));

  return {
    title: allows('title'),
    brand: allows('datasheet'),
    category: allows('category'),
    sku: allows('datasheet'),
    barcodes: allows('gtin'),
    pricing: allows('pricing'),
    description: allows('description'),
    highlights: allows('highlights'),
    attributes: allows('attributes'),
    gpsr: allows('gpsr'),
    notes: true,
  };
}

module.exports = { parseScopeSet, buildScopeAllowMap };
