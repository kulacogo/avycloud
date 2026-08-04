'use strict';

// Incident 2026-08-04: Identify speichert 31-Zeichen-Stub-Titel (Stage-3-
// Fallback = brand+model). Die Save-Boundary lief coerceTitleToPolicy mit
// minLen 0 im Passthrough — Automatik-Titel hatten KEIN Mindestlängen-Netz.
// Neu: fillTitleToMinLength läuft im selben Automatik-Block wie die
// Title-Policy (NIE bei manuellen Saves — derselbe Guard wie mpn-append).

const fs = require('fs');

const src = fs.readFileSync(require.resolve('../lib/firestore.js'), 'utf8');

describe('Save-Boundary — Titel-Mindestlänge für Automatik-Pfade', () => {
  it('fillTitleToMinLength läuft im !isManualSave && !skipTitlePolicy Block nach dem Coerce', () => {
    const guardIdx = src.indexOf('if (!isManualSave && !skipTitlePolicy) {');
    expect(guardIdx).toBeGreaterThan(-1);
    const block = src.slice(guardIdx, guardIdx + 3500);
    const coerceIdx = block.indexOf('coerceTitleToPolicy(');
    const fillIdx = block.indexOf('fillTitleToMinLength(');
    expect(coerceIdx).toBeGreaterThan(-1);
    expect(fillIdx).toBeGreaterThan(coerceIdx);
    expect(block).toMatch(/titleMinFillEnabled\(\)/);
    // Min-Fill läuft VOR dem MPN-Append (MPN kann Teil der Auffüllung sein,
    // mpn-append bleibt idempotentes Netz dahinter).
    const mpnIdx = block.indexOf('computeMpnTitleAppend(');
    expect(mpnIdx).toBeGreaterThan(fillIdx);
  });
});
