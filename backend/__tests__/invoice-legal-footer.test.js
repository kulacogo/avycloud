'use strict';

/**
 * §35a GmbHG: a GmbH invoice must show Registergericht + HRB-Nummer +
 * Geschäftsführer — NOT "Inhaber". buildLegalFooterLines encodes that switch so
 * the TrendOcean-GmbH invoices are legally complete after the entity change.
 *
 * Vitest CJS — globals enabled.
 */

const { buildLegalFooterLines } = require('../services/invoice-engine');

describe('buildLegalFooterLines (§35a GmbHG on the invoice footer)', () => {
  it('prints Inhaber for a sole proprietorship (Einzelunternehmen)', () => {
    const lines = buildLegalFooterLines({
      legalForm: 'einzelunternehmen', vatId: 'DE1', taxId: 'T1', owner: 'Max Mustermann',
    });
    expect(lines).toContain('USt.-ID: DE1');
    expect(lines).toContain('Steuer-Nr.: T1');
    expect(lines).toContain('Inhaber: Max Mustermann');
    expect(lines.some((l) => l.includes('Geschäftsführer'))).toBe(false);
  });

  it('prints Registergericht/HRB/Geschäftsführer for a GmbH and NOT Inhaber', () => {
    const lines = buildLegalFooterLines({
      legalForm: 'GmbH', vatId: 'DE2', taxId: 'T2', owner: 'ignored',
      registerCourt: 'München', registerNumber: 'HRB 123456', managingDirector: 'Erika Musterfrau',
    });
    expect(lines).toContain('Registergericht: München');
    expect(lines).toContain('HRB: HRB 123456');
    expect(lines).toContain('Geschäftsführer: Erika Musterfrau');
    expect(lines.some((l) => l.startsWith('Inhaber:'))).toBe(false);
  });

  it('omits empty fields gracefully', () => {
    const lines = buildLegalFooterLines({ legalForm: 'GmbH' });
    expect(lines).toEqual([]);
  });
});
