'use strict';

// Tests for the GPSR-Consensus migration (task D.3, 2026-05-10).
//
// `services/identify-v3.js` previously merged GPSR fields via a simple
// linear `pickFrom()` priority fallback (Registry → Stage-3 LLM → Web).
// We migrated to `resolveConsensus()` from `lib/cross-reference.js` behind
// the IDENTIFY_V3_GPSR_CONSENSUS feature flag with three modes:
//   'false'   default — legacy pickFrom behaviour
//   'shadow'  both paths run, diff is logged, legacy wins
//   'true'    new consensus path wins
//
// These tests verify all three modes plus the consensus algorithm contract.

const path = require('path');

function loadIdentifyV3() {
  // Re-require with fresh module cache so the helper picks up env changes
  // and a freshly-stubbed logger module on each test.
  const target = require.resolve('../../services/identify-v3');
  delete require.cache[target];
  return require(target);
}

function stubLogger(infoSpy) {
  const target = require.resolve('../../lib/logger');
  require.cache[target] = {
    id: target,
    filename: target,
    loaded: true,
    exports: {
      info: infoSpy,
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

function clearLoggerStub() {
  const target = require.resolve('../../lib/logger');
  delete require.cache[target];
}

describe('identify-v3 GPSR-Consensus migration', () => {
  const originalFlag = process.env.IDENTIFY_V3_GPSR_CONSENSUS;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.IDENTIFY_V3_GPSR_CONSENSUS;
    } else {
      process.env.IDENTIFY_V3_GPSR_CONSENSUS = originalFlag;
    }
    clearLoggerStub();
  });

  it('default flag-off: returns oldResult (pickFrom-behavior, Registry wins)', () => {
    delete process.env.IDENTIFY_V3_GPSR_CONSENSUS;
    const { _pickGpsrField } = loadIdentifyV3();
    const out = _pickGpsrField(
      'gpsr_manufacturer_name',
      'Registry GmbH',
      'Gemini Inferenz GmbH',
      'Manufacturer Website GmbH',
    );
    // Legacy priority: Registry > Stage3 > Web.
    expect(out).toBe('Registry GmbH');
  });

  it('flag=false: empty registry falls back to stage3 (pickFrom-behavior)', () => {
    process.env.IDENTIFY_V3_GPSR_CONSENSUS = 'false';
    const { _pickGpsrField } = loadIdentifyV3();
    const out = _pickGpsrField(
      'gpsr_manufacturer_name',
      '',
      'Gemini Inferenz GmbH',
      'Manufacturer Website GmbH',
    );
    expect(out).toBe('Gemini Inferenz GmbH');
  });

  it('flag=true: uses resolveConsensus result (web 0.90 > registry 0.85 if registry missing)', () => {
    process.env.IDENTIFY_V3_GPSR_CONSENSUS = 'true';
    const { _pickGpsrField } = loadIdentifyV3();
    // Only stage3 + web provided. Web (0.90) > Gemini-Inference (0.55) → Web wins.
    const out = _pickGpsrField(
      'gpsr_manufacturer_name',
      null,
      'Gemini Inferenz GmbH',
      'Manufacturer Website GmbH',
    );
    expect(out).toBe('Manufacturer Website GmbH');
  });

  it('flag=shadow: returns oldResult but logs diff', () => {
    process.env.IDENTIFY_V3_GPSR_CONSENSUS = 'shadow';
    let captured = null;
    stubLogger((obj, msg) => {
      captured = { obj, msg };
    });
    const { _pickGpsrField } = loadIdentifyV3();
    // Old picks 'Gemini Inferenz GmbH' (stage3, since registry empty).
    // New picks 'Manufacturer Website GmbH' (web has higher confidence).
    const out = _pickGpsrField(
      'gpsr_manufacturer_name',
      null,
      'Gemini Inferenz GmbH',
      'Manufacturer Website GmbH',
    );
    expect(out).toBe('Gemini Inferenz GmbH'); // legacy still wins
    expect(captured).not.toBeNull();
    expect(captured.msg).toMatch(/Shadow.*Diff/);
    expect(captured.obj.oldResult).toBe('Gemini Inferenz GmbH');
    expect(captured.obj.newResult).toBe('Manufacturer Website GmbH');
    expect(captured.obj.fieldName).toBe('gpsr_manufacturer_name');
  });

  it('flag=shadow: no log when old==new', () => {
    process.env.IDENTIFY_V3_GPSR_CONSENSUS = 'shadow';
    let logCount = 0;
    stubLogger(() => { logCount += 1; });
    const { _pickGpsrField } = loadIdentifyV3();
    // Single source → both paths return the same value.
    const out = _pickGpsrField(
      'gpsr_manufacturer_name',
      'Registry GmbH',
      null,
      null,
    );
    expect(out).toBe('Registry GmbH');
    expect(logCount).toBe(0);
  });

  it('consensus: when all 3 sources agree, picks the unanimous value', () => {
    process.env.IDENTIFY_V3_GPSR_CONSENSUS = 'true';
    const { _pickGpsrField } = loadIdentifyV3();
    const out = _pickGpsrField(
      'gpsr_manufacturer_name',
      'ACME GmbH',
      'ACME GmbH',
      'ACME GmbH',
    );
    expect(out).toBe('ACME GmbH');
  });

  it('consensus: when registry empty + web stronger than gemini, picks web (not gemini)', () => {
    process.env.IDENTIFY_V3_GPSR_CONSENSUS = 'true';
    const { _pickGpsrField } = loadIdentifyV3();
    // Registry empty. Web (0.90) > Gemini (0.55) → consensus picks web.
    // Legacy pickFrom would have picked gemini (stage3) here, so this also
    // proves the active-mode actually changes behaviour.
    const out = _pickGpsrField(
      'gpsr_manufacturer_address',
      '',
      'Falschstr. 1, 99999 Niemandsland',
      'Echtweg 7, 80331 München',
    );
    expect(out).toBe('Echtweg 7, 80331 München');
  });

  it('consensus: returns empty string when no source has a value', () => {
    process.env.IDENTIFY_V3_GPSR_CONSENSUS = 'true';
    const { _pickGpsrField } = loadIdentifyV3();
    const out = _pickGpsrField('gpsr_manufacturer_name', null, '', undefined);
    expect(out).toBe('');
  });

  it('email field: registry alias (manufacturer_email) is honored in legacy path', () => {
    delete process.env.IDENTIFY_V3_GPSR_CONSENSUS;
    const { _pickGpsrField } = loadIdentifyV3();
    const out = _pickGpsrField(
      'gpsr_manufacturer_email',
      null, // primary registry `email` empty
      null,
      null,
      {
        registryEmailAlias: 'fallback@registry.eu', // registry `manufacturer_email`
        webFallbackEmailAlias: null,
      },
    );
    expect(out).toBe('fallback@registry.eu');
  });

  it('flag=true unknown casing (TRUE / On / 1) treated as enabled', () => {
    const variants = ['TRUE', 'True', 'on', '1'];
    for (const v of variants) {
      process.env.IDENTIFY_V3_GPSR_CONSENSUS = v;
      const { _pickGpsrField } = loadIdentifyV3();
      const out = _pickGpsrField(
        'gpsr_manufacturer_name',
        null,
        'Stage3 Value',
        'Web Value', // higher confidence under consensus
      );
      expect(out).toBe('Web Value');
    }
  });
});
