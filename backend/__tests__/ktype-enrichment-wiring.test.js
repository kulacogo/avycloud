// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// K-Typ-Anreicherungs-Invarianten (Fix 2026-07-16)
//
// Hintergrund (Audit 2026-07-16, Tenant default): 126 von 189 Fitment-Produkten
// ohne K-Typ; 99 davon scheiterten mit `not_fitment_category` bei traceCatId=null,
// weil die K-Typ-Anreicherung im Identify-Post-Processing PARALLEL zur
// Kategorie-Aufloesung lief und die categoryId noch nicht sehen konnte.
// Zusaetzlich hatte Chat-V3 (Default-Pipeline) den enrichKTypIfPossible-Aufruf
// nie geerbt — und kein Chat-Pfad persistierte das Ergebnis je (Chat speichert
// nur ueber datasheetChanges-Change-Cards).
//
// Diese Tests encodieren die Fix-Invarianten als Source-Contracts (Pattern:
// oversell-invariant.test.js) — schlaegt an, wenn jemand die Reihenfolge oder
// die Chat-Verdrahtung wieder entfernt.

const fs = require('fs');
const path = require('path');

const identifySrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'identify.js'), 'utf8');

describe('K-Typ Identify-Ordering — Kategorie VOR K-Typ', () => {
  it('Post-Processing: enrichKTypIfPossible laeuft NACH applyKauflandTaxonomy im selben Task', () => {
    const blockStart = identifySrc.indexOf('const postProcessingResults = await Promise.allSettled([');
    expect(blockStart).toBeGreaterThan(-1);
    const blockEnd = identifySrc.indexOf('for (const r of postProcessingResults)', blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const block = identifySrc.slice(blockStart, blockEnd);

    const taxonomyIdx = block.indexOf('applyKauflandTaxonomy(product)');
    const ktypeIdx = block.indexOf("enrichKTypIfPossible(product, { reason: 'identify' })");
    expect(taxonomyIdx).toBeGreaterThan(-1);
    expect(ktypeIdx).toBeGreaterThan(-1);
    // K-Typ NACH der Taxonomie/Kategorie-Aufloesung ...
    expect(ktypeIdx).toBeGreaterThan(taxonomyIdx);
    // ... und im SELBEN async-Task: zwischen beiden darf kein Task-Separator
    // `})(),` liegen (der wuerde K-Typ wieder in einen parallelen Task verschieben).
    const between = block.slice(taxonomyIdx, ktypeIdx);
    expect(between).not.toMatch(/\}\)\(\),/);
  });

  it('Kein eigenstaendiger paralleler K-Typ-Task mehr im allSettled-Array', () => {
    const blockStart = identifySrc.indexOf('const postProcessingResults = await Promise.allSettled([');
    const blockEnd = identifySrc.indexOf('for (const r of postProcessingResults)', blockStart);
    const block = identifySrc.slice(blockStart, blockEnd);
    // Genau EIN enrichKTypIfPossible-Aufruf im Post-Processing-Block.
    const calls = block.match(/enrichKTypIfPossible\(/g) || [];
    expect(calls.length).toBe(1);
  });
});

describe('K-Typ Chat-Chokepoint — alle Pipelines, persistiert via Change-Card', () => {
  it('startChatKTypEnrichment wird nach dem Produkt-Load gestartet', () => {
    expect(identifySrc).toMatch(/const ktypEnrichHandle = startChatKTypEnrichment\(product\)/);
  });

  it('attachKTypDatasheetChange laeuft in Stream- UND Sync-Zweig', () => {
    const calls = identifySrc.match(/await attachKTypDatasheetChange\(chatResult, product, ktypEnrichHandle\)/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('buildKTypDatasheetChange ist aus lib/ktype-enrichment exportiert', () => {
    const mod = require('../lib/ktype-enrichment');
    expect(typeof mod.buildKTypDatasheetChange).toBe('function');
    expect(typeof mod.enrichKTypIfPossible).toBe('function');
  });
});

describe('buildKTypDatasheetChange — Change-Card-Shape', () => {
  const { buildKTypDatasheetChange } = require('../lib/ktype-enrichment');

  function productWith(ktyp, trace) {
    return {
      id: 'p1',
      details: { attributes: ktyp == null ? {} : { 'K-Typ': ktyp } },
      ops: trace ? { data_quality: { ktype_enrich_v1: trace } } : {},
    };
  }

  it('null wenn kein K-Typ vorhanden', () => {
    expect(buildKTypDatasheetChange(productWith(null), { beforeValue: '' })).toBeNull();
    expect(buildKTypDatasheetChange({}, { beforeValue: '' })).toBeNull();
  });

  it('null wenn Wert unveraendert (kein Duplikat-Vorschlag)', () => {
    expect(buildKTypDatasheetChange(productWith('123|456'), { beforeValue: '123|456' })).toBeNull();
  });

  it('Change-Card mit attributes-MAP wenn K-Typ neu angereichert wurde (FE-Contract, KEIN Array)', () => {
    const change = buildKTypDatasheetChange(
      productWith('123|456|789', { source: 'local_hsn_tsn' }),
      { beforeValue: '' }
    );
    expect(change).not.toBeNull();
    // Map-Shape ist Pflicht: ProductSheet.applyAssistantChange iteriert
    // Object.entries() — ein Array erzeugte attributes['0']-Müll (2026-07-16).
    expect(Array.isArray(change.attributes)).toBe(false);
    expect(change.attributes).toEqual({ 'K-Typ': '123|456|789' });
    expect(change.confidence).toBeGreaterThanOrEqual(0.9);
    expect(change.summary).toContain('3 Fahrzeuge');
    expect(change.summary).toContain('HSN/TSN');
  });

  it('Web-Evidence-Quelle wird in der Summary benannt', () => {
    const change = buildKTypDatasheetChange(
      productWith('42', { source: 'web_evidence' }),
      { beforeValue: '' }
    );
    expect(change.summary).toContain('1 Fahrzeug ');
    expect(change.summary).toContain('Web-Beleg');
  });
});
