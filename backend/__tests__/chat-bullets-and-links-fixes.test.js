'use strict';

/**
 * Fixes 2026-07-05 (Owner-Report):
 *
 * D) Beschreibung enthielt nach Chat-"Übernehmen" Bullets. Der Prose-Guard
 *    (enforceDescriptionProse) triggerte nur auf HTML-Listen (<ul|ol|li>) —
 *    Klartext-Bullets ("• ", "- ", "* " am Zeilenanfang) rutschten durch, und
 *    sanitizeDescriptionProse ließ die Glyphen stehen.
 *
 * E) Konkurrenzpreis-Links führten auf gstatic-Thumbnails statt zum Angebot:
 *    in summarizeSerpEntries gewann imageMeta.url (thumbnail-Fallback) über
 *    entry.product_link. Für Shopping-Engines muss der Angebots-Link gewinnen.
 *
 * Vitest CJS — globals enabled.
 */

const {
  enforceDescriptionProse,
  sanitizeDescriptionProse,
} = require('../lib/listing-sanitize');
const { summarizeSerpEntries } = require('../lib/serpapi');

describe('enforceDescriptionProse — Klartext-Bullets (D)', () => {
  it('triggert weiterhin auf HTML-Listen', () => {
    const p = { details: { short_description: '<p>Intro.</p><ul><li>Punkt eins hier.</li></ul>' } };
    const out = enforceDescriptionProse(p);
    expect(out.details.short_description).not.toMatch(/<(ul|li)\b/i);
  });

  it('triggert jetzt auch auf Klartext-Bullet-Zeilen ("• ")', () => {
    const p = { details: { short_description: 'Der Ventilator ist stark.\n• Drei Geschwindigkeitsstufen für jeden Bedarf.\n• Oszillation verteilt die Luft im Raum.' } };
    const out = enforceDescriptionProse(p);
    expect(out.details.short_description).not.toContain('•');
    expect(out.details.short_description).toMatch(/<p>/);
  });

  it('triggert auf "- "-Listen am Zeilenanfang', () => {
    const p = { details: { short_description: 'Solides Produkt.\n- Leiser Betrieb im Schlafzimmer.\n- Stabiler Kreuzfuß aus Metall.' } };
    const out = enforceDescriptionProse(p);
    expect(out.details.short_description).not.toContain('\n- ');
    expect(out.details.short_description).toMatch(/<p>/);
  });

  it('lässt saubere Prosa byte-identisch (idempotent, kein False-Positive auf Binde-Striche)', () => {
    const clean = '<p>Der KC-2125 ist ideal für 10 - 20 m² große Räume und sehr leise.</p>';
    const p = { details: { short_description: clean } };
    expect(enforceDescriptionProse(p).details.short_description).toBe(clean);
  });
});

describe('sanitizeDescriptionProse — Glyphen werden entfernt (D)', () => {
  it('macht aus Bullet-Zeilen Absätze ohne Glyphen', () => {
    const out = sanitizeDescriptionProse('Einleitung zum Produkt hier.\n• Erster wichtiger Punkt mit Inhalt.\n• Zweiter wichtiger Punkt mit Inhalt.');
    expect(out).not.toContain('•');
    expect(out).toMatch(/<p>/);
    expect(out).toContain('Erster wichtiger Punkt');
  });
});

describe('summarizeSerpEntries — Angebots-Link schlägt Thumbnail (E)', () => {
  it('google_shopping: url ist der product_link, nie das gstatic-Thumbnail', () => {
    const data = {
      shopping_results: [
        {
          title: 'KING Cool KC-2125 Standventilator',
          extracted_price: 39.99,
          source: 'beispiel-shop.de',
          thumbnail: 'https://encrypted-tbn0.gstatic.com/shopping?q=abc123',
          product_link: 'https://www.google.com/shopping/product/123456?gl=de',
        },
      ],
    };
    const items = summarizeSerpEntries('google_shopping', data, 5);
    expect(items.length).toBe(1);
    expect(items[0].url).toBe('https://www.google.com/shopping/product/123456?gl=de');
    expect(items[0].url).not.toContain('gstatic.com');
    // Thumbnail bleibt als Bild-Feld erhalten
    expect(items[0].thumbnail).toContain('gstatic.com');
  });

  it('Bild-Engines behalten die Bild-URL-Präzedenz (kein Verhaltensbruch)', () => {
    const data = { images_results: [{ title: 'Bild', original: 'https://example-cdn.com/full.jpg', link: 'https://seite.de/artikel' }] };
    const items = summarizeSerpEntries('google_images', data, 5);
    expect(items.length).toBe(1);
    expect(items[0].url).toBe('https://example-cdn.com/full.jpg');
  });
});
