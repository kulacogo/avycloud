'use strict';

/**
 * Reine Funktionen — kein I/O, keine Mocks nötig.
 */

const {
  normalizeKey,
  isUsefulMpn,
  titleContainsMpn,
  appendMpnToTitle,
  computeMpnTitleAppend,
  getTitleAppendMpnMode,
} = require('../../lib/mpn-title-append');

describe('normalizeKey', () => {
  it('macht Grossschrift und wirft alles ausser A-Z0-9 weg', () => {
    expect(normalizeKey('0 986 479 058')).toBe('0986479058');
    expect(normalizeKey('fx-80327x')).toBe('FX80327X');
    expect(normalizeKey('  a/b_c  ')).toBe('ABC');
  });

  it('liefert leeren String für Müll-Eingaben', () => {
    expect(normalizeKey('')).toBe('');
    expect(normalizeKey('-')).toBe('');
    expect(normalizeKey(null)).toBe('');
    expect(normalizeKey(undefined)).toBe('');
    expect(normalizeKey({})).toBe('');
  });
});

describe('isUsefulMpn — Müll-Filter', () => {
  const ctx = {
    gtins: ['0085854258548', '085854258548'],
    sku: 'SKU-1844691476',
    brand: 'Thule',
  };

  it('leer', () => {
    expect(isUsefulMpn('', ctx)).toMatchObject({ ok: false, reason: 'empty' });
    expect(isUsefulMpn(null, ctx)).toMatchObject({ ok: false, reason: 'empty' });
    expect(isUsefulMpn('   ', ctx)).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('reine 8/12/13/14-stellige Ziffernfolgen (EAN/GTIN-Fehlablagen)', () => {
    expect(isUsefulMpn('20201523', ctx)).toMatchObject({ ok: false, reason: 'gtin_like' }); // 8
    expect(isUsefulMpn('085854258549', ctx)).toMatchObject({ ok: false, reason: 'gtin_like' }); // 12
    expect(isUsefulMpn('4006381333931', ctx)).toMatchObject({ ok: false, reason: 'gtin_like' }); // 13
    expect(isUsefulMpn('14006381333931', ctx)).toMatchObject({ ok: false, reason: 'gtin_like' }); // 14
  });

  it('erlaubt Ziffernfolgen anderer Länge (echte Teilenummern)', () => {
    expect(isUsefulMpn('3205317', ctx)).toMatchObject({ ok: true }); // 7 Stellen
    expect(isUsefulMpn('123456789', ctx)).toMatchObject({ ok: true }); // 9 Stellen
  });

  it('identisch mit einer GTIN des Produkts — auch mit abweichender Nullen-Führung', () => {
    // 13-stellig → greift schon der gtin_like-Filter; in jedem Fall aussortiert.
    const sameAsGtin = isUsefulMpn('0085854258548', ctx);
    expect(sameAsGtin.ok).toBe(false);
    expect(['gtin_like', 'equals_gtin']).toContain(sameAsGtin.reason);
    // 11-stellig, damit nicht schon gtin_like greift; matcht die GTIN nach Nullen-Strip.
    expect(isUsefulMpn('12345678901', { gtins: ['0012345678901'] }))
      .toMatchObject({ ok: false, reason: 'equals_gtin' });
  });

  it('identisch mit der SKU', () => {
    expect(isUsefulMpn('SKU-1844691476', ctx)).toMatchObject({ ok: false, reason: 'equals_sku' });
    expect(isUsefulMpn('sku 1844691476', ctx)).toMatchObject({ ok: false, reason: 'equals_sku' });
  });

  it('identisch mit dem Markennamen', () => {
    expect(isUsefulMpn('Thule', ctx)).toMatchObject({ ok: false, reason: 'equals_brand' });
    expect(isUsefulMpn('THULE', ctx)).toMatchObject({ ok: false, reason: 'equals_brand' });
  });

  it('kürzer als 3 Zeichen', () => {
    expect(isUsefulMpn('A1', ctx)).toMatchObject({ ok: false, reason: 'too_short' });
    expect(isUsefulMpn('7', ctx)).toMatchObject({ ok: false, reason: 'too_short' });
  });

  it('generische Platzhalter', () => {
    for (const junk of ['Does not apply', 'DOESNOTAPPLY', 'N/A', 'n.a.', 'Unbekannt', 'TODO', '-', 'None', 'keine Angabe']) {
      const res = isUsefulMpn(junk, ctx);
      expect(res.ok, `"${junk}" muss aussortiert werden`).toBe(false);
      expect(['placeholder', 'empty', 'too_short']).toContain(res.reason);
    }
  });

  it('lässt echte Teilenummern durch', () => {
    expect(isUsefulMpn('FX-80327X', ctx)).toMatchObject({ ok: true, reason: 'ok' });
    expect(isUsefulMpn('0 986 479 058', ctx)).toMatchObject({ ok: true, reason: 'ok' });
  });
});

describe('appendMpnToTitle — Fit-Regel an der 80-Zeichen-Grenze', () => {
  it('hängt an, solange "<titel> <mpn>" in maxLen passt', () => {
    // 73 Zeichen + ' ' + 6 = 80 → passt exakt
    const title = 'A'.repeat(73);
    const out = appendMpnToTitle(title, 'FX-800', { maxLen: 80 });
    expect(out).toBe(`${title} FX-800`);
    expect(out.length).toBe(80);
  });

  it('gibt den Titel unverändert zurück, wenn es um 1 Zeichen nicht passt', () => {
    const title = 'A'.repeat(74);
    const out = appendMpnToTitle(title, 'FX-800', { maxLen: 80 });
    expect(out).toBe(title);
    expect(out.length).toBe(74);
  });

  it('kürzt NIEMALS und sortiert NICHT um', () => {
    const title = 'Thule Trekking Reiserucksack 33cm 420D Dobby-Polyester 600D Polyester Reisen';
    const out = appendMpnToTitle(title, '3205317', { maxLen: 80 });
    expect(out).toBe(title); // passt nicht → unverändert
    expect(out.startsWith('Thule')).toBe(true);
  });

  it('respektiert einen abweichenden maxLen', () => {
    // 'Bosch Bremsscheibe BD1234' hat exakt 25 Zeichen.
    expect(appendMpnToTitle('Bosch Bremsscheibe', 'BD1234', { maxLen: 24 })).toBe('Bosch Bremsscheibe');
    expect(appendMpnToTitle('Bosch Bremsscheibe', 'BD1234', { maxLen: 25 })).toBe('Bosch Bremsscheibe BD1234');
  });

  it('leerer Titel oder leere MPN → unverändert', () => {
    expect(appendMpnToTitle('', 'FX-800')).toBe('');
    expect(appendMpnToTitle('Bosch Bremsscheibe', '')).toBe('Bosch Bremsscheibe');
    expect(appendMpnToTitle('Bosch Bremsscheibe', null)).toBe('Bosch Bremsscheibe');
  });
});

describe('appendMpnToTitle — Doppel-Schutz mit abweichenden Trennzeichen', () => {
  it('erkennt die MPN im Titel trotz anderer Trennzeichen', () => {
    const title = 'Bosch Bremsbelagsatz 0 986 479 058 Vorderachse';
    expect(appendMpnToTitle(title, '0986479058', { maxLen: 80 })).toBe(title);
    expect(titleContainsMpn(title, '0986479058')).toBe(true);
  });

  it('erkennt die MPN auch bei Bindestrich-Varianten', () => {
    const title = 'STOOLINK Barhocker FX80327X Schwarz';
    expect(appendMpnToTitle(title, 'FX-80327X', { maxLen: 80 })).toBe(title);
  });

  it('erkennt Klein-/Grossschreibungs-Varianten', () => {
    const title = 'Stoolink Barhocker fx-80327x Schwarz';
    expect(appendMpnToTitle(title, 'FX-80327X', { maxLen: 80 })).toBe(title);
  });
});

describe('appendMpnToTitle — Idempotenz', () => {
  it('zweimal anwenden ändert nichts', () => {
    const title = 'Bosch Bremsbelagsatz Vorderachse';
    const once = appendMpnToTitle(title, '0986479058', { maxLen: 80 });
    expect(once).toBe('Bosch Bremsbelagsatz Vorderachse 0986479058');
    const twice = appendMpnToTitle(once, '0986479058', { maxLen: 80 });
    expect(twice).toBe(once);
    const thrice = appendMpnToTitle(twice, '0986479058', { maxLen: 80 });
    expect(thrice).toBe(once);
  });

  it('ist auch mit abweichender Schreibweise idempotent', () => {
    const title = 'Bosch Bremsbelagsatz Vorderachse';
    const once = appendMpnToTitle(title, '0 986 479 058', { maxLen: 80 });
    expect(once).toBe('Bosch Bremsbelagsatz Vorderachse 0 986 479 058');
    expect(appendMpnToTitle(once, '0986479058', { maxLen: 80 })).toBe(once);
  });
});

describe('appendMpnToTitle — Markenschutz', () => {
  it('der Titel beginnt weiterhin mit der Marke', () => {
    const title = 'Bosch Bremsbelagsatz Vorderachse';
    const out = appendMpnToTitle(title, 'BP1234', { maxLen: 80 });
    expect(out.startsWith('Bosch ')).toBe(true);
    expect(out.indexOf('Bosch')).toBe(0);
    // Nur hinten angehängt: der Präfix bleibt Zeichen für Zeichen identisch.
    expect(out.slice(0, title.length)).toBe(title);
  });
});

describe('computeMpnTitleAppend', () => {
  const baseProduct = {
    identification: { name: 'Bosch Bremsbelagsatz Vorderachse', brand: 'Bosch', sku: 'SKU-1234567890' },
    details: { identifiers: { mpn: '0986479058', ean: '4047024537231', sku: 'SKU-1234567890' } },
  };

  it('hängt eine brauchbare MPN an', () => {
    const res = computeMpnTitleAppend(baseProduct, baseProduct.identification.name, { maxLen: 80 });
    expect(res).toMatchObject({ changed: true, reason: 'appended', mpn: '0986479058' });
    expect(res.title).toBe('Bosch Bremsbelagsatz Vorderachse 0986479058');
  });

  it('liest die MPN notfalls aus dem Attribut Herstellernummer', () => {
    const p = {
      identification: { name: 'Bosch Bremsbelagsatz', brand: 'Bosch' },
      details: { identifiers: {}, attributes: { Herstellernummer: 'BP-9911' } },
    };
    const res = computeMpnTitleAppend(p, p.identification.name, { maxLen: 80 });
    expect(res).toMatchObject({ changed: true, mpn: 'BP-9911' });
    expect(res.title).toBe('Bosch Bremsbelagsatz BP-9911');
  });

  it('sortiert MPN aus, die gleich der EAN ist', () => {
    const p = {
      identification: { name: 'Bosch Bremsbelagsatz', brand: 'Bosch' },
      details: { identifiers: { mpn: '4047024537231', ean: '4047024537231' } },
    };
    const res = computeMpnTitleAppend(p, p.identification.name, { maxLen: 80 });
    // 13-stellig → schon gtin_like, in jedem Fall aussortiert
    expect(res.changed).toBe(false);
    expect(['gtin_like', 'equals_gtin']).toContain(res.reason);
  });

  it('meldet already_in_title', () => {
    const res = computeMpnTitleAppend(baseProduct, 'Bosch Bremsbelagsatz 0 986 479 058', { maxLen: 80 });
    expect(res).toMatchObject({ changed: false, reason: 'already_in_title' });
  });

  it('meldet no_fit wenn der Titel zu lang wäre', () => {
    const longTitle = 'B'.repeat(78);
    const res = computeMpnTitleAppend(baseProduct, longTitle, { maxLen: 80 });
    expect(res).toMatchObject({ changed: false, reason: 'no_fit' });
    expect(res.title).toBe(longTitle);
  });

  it('meldet no_title bei leerem Titel', () => {
    const res = computeMpnTitleAppend(baseProduct, '   ', { maxLen: 80 });
    expect(res).toMatchObject({ changed: false, reason: 'no_title' });
  });
});

describe('getTitleAppendMpnMode — Flag TITLE_APPEND_MPN', () => {
  it('unset == off', () => {
    expect(getTitleAppendMpnMode({})).toBe('off');
  });

  it('off/shadow/on', () => {
    expect(getTitleAppendMpnMode({ TITLE_APPEND_MPN: 'off' })).toBe('off');
    expect(getTitleAppendMpnMode({ TITLE_APPEND_MPN: 'shadow' })).toBe('shadow');
    expect(getTitleAppendMpnMode({ TITLE_APPEND_MPN: 'SHADOW' })).toBe('shadow');
    expect(getTitleAppendMpnMode({ TITLE_APPEND_MPN: 'on' })).toBe('on');
    expect(getTitleAppendMpnMode({ TITLE_APPEND_MPN: 'true' })).toBe('on');
  });

  it('unbekannte Werte fallen auf off zurück (fail-closed)', () => {
    expect(getTitleAppendMpnMode({ TITLE_APPEND_MPN: 'yolo' })).toBe('off');
    expect(getTitleAppendMpnMode({ TITLE_APPEND_MPN: '' })).toBe('off');
  });
});
