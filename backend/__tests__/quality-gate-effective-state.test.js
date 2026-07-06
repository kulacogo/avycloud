// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// REGRESSION GUARD — Admin-Health muss den EFFEKTIVEN Gate-Zustand melden.
//
// Quality-Gate + Rulebook sind default-AN (Opt-out-Flags). Der Health-Endpoint
// berechnete die Anzeige aber mit parseBool(env) === true — bei unset ENV
// (der dokumentierte Default-Betrieb) meldete das Panel beide Gates als
// DISABLED, obwohl sie liefen. Seit Fix liest der Endpoint die echten
// Prädikate isQualityGateEnabled() / isRulebookDisabled().

const { isQualityGateEnabled } = require('../lib/datasheet-quality');
const { isRulebookDisabled } = require('../lib/llm-rulebook');

describe('isQualityGateEnabled (lib/datasheet-quality.js)', () => {
  let original;
  beforeEach(() => { original = process.env.QUALITY_GATE_ENABLED; });
  afterEach(() => {
    if (original === undefined) delete process.env.QUALITY_GATE_ENABLED;
    else process.env.QUALITY_GATE_ENABLED = original;
  });

  it('unset → AN (dokumentierter Default)', () => {
    delete process.env.QUALITY_GATE_ENABLED;
    expect(isQualityGateEnabled()).toBe(true);
  });

  it.each([['false'], ['0'], ['no']])('%s → AUS', (v) => {
    process.env.QUALITY_GATE_ENABLED = v;
    expect(isQualityGateEnabled()).toBe(false);
  });

  it('true → AN', () => {
    process.env.QUALITY_GATE_ENABLED = 'true';
    expect(isQualityGateEnabled()).toBe(true);
  });
});

describe('isRulebookDisabled (lib/llm-rulebook.js)', () => {
  let original;
  beforeEach(() => { original = process.env.RULEBOOK_ENABLED; });
  afterEach(() => {
    if (original === undefined) delete process.env.RULEBOOK_ENABLED;
    else process.env.RULEBOOK_ENABLED = original;
  });

  it('unset → aktiv (nicht disabled)', () => {
    delete process.env.RULEBOOK_ENABLED;
    expect(isRulebookDisabled()).toBe(false);
  });

  it('false → disabled', () => {
    process.env.RULEBOOK_ENABLED = 'false';
    expect(isRulebookDisabled()).toBe(true);
  });
});

describe('routes/admin.js nutzt die Prädikate (Source-Assertion)', () => {
  it('llm-health flags kommen aus isQualityGateEnabled/isRulebookDisabled', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../routes/admin.js'), 'utf8');
    expect(src).toMatch(/qualityGateEnabled:.*isQualityGateEnabled\(\)/);
    expect(src).toMatch(/rulebookEnabled:\s*!require\(.*llm-rulebook.*\)\.isRulebookDisabled\(\)/);
    // Das alte fehleranfällige Muster darf nicht zurückkommen:
    expect(src).not.toMatch(/qualityGateEnabled:\s*parseBool\(process\.env\.QUALITY_GATE_ENABLED\)/);
  });
});
