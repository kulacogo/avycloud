'use strict';
// Druckwarteschlange: reine Entscheidungen. Kein Firestore, kein Netz.
const {
  JOB_STATUS,
  computeRetryDelayMs,
  isAgentOnline,
  shouldRetry,
  buildPrintJob,
  isClaimable,
  printQueueEnabled,
} = require('../lib/print-queue');

const iso = (ms) => new Date(ms).toISOString();

describe('buildPrintJob', () => {
  const base = {
    tenantId: 'default',
    orderId: 'AVY-1',
    printerRole: 'parcel',
    formatKey: 'parcel',
    widthMm: 103,
    heightMm: 164,
  };

  it('legt einen abholbereiten Auftrag an', () => {
    const job = buildPrintJob({ ...base, nowIso: iso(1000) });
    expect(job.status).toBe(JOB_STATUS.QUEUED);
    expect(job.attempts).toBe(0);
    expect(job.printerRole).toBe('parcel');
    expect(job.widthMm).toBe(103);
    expect(job.heightMm).toBe(164);
    expect(job.notBefore).toBe(iso(1000));
  });

  it('verlangt tenantId, orderId und Druckerrolle', () => {
    expect(() => buildPrintJob({ ...base, tenantId: '' })).toThrow(/tenantId/);
    expect(() => buildPrintJob({ ...base, orderId: '' })).toThrow(/orderId/);
    expect(() => buildPrintJob({ ...base, printerRole: '' })).toThrow(/printerRole/);
  });

  it('begrenzt die Stueckzahl — ein Tippfehler darf keine 900 Etiketten drucken', () => {
    expect(buildPrintJob({ ...base, copies: 900 }).copies).toBe(10);
    expect(buildPrintJob({ ...base, copies: 0 }).copies).toBe(1);
    expect(buildPrintJob({ ...base, copies: -5 }).copies).toBe(1);
    expect(buildPrintJob({ ...base, copies: 2.7 }).copies).toBe(2);
  });
});

describe('isAgentOnline', () => {
  it('frische Meldung = online', () => {
    expect(isAgentOnline(iso(100_000), 100_000 + 5_000)).toBe(true);
  });

  it('alte Meldung = offline', () => {
    expect(isAgentOnline(iso(100_000), 100_000 + 200_000)).toBe(false);
  });

  it('nie gemeldet = offline, nicht "vielleicht"', () => {
    // Diese Antwort entscheidet, ob die Oberflaeche auf den alten Weg
    // zurueckfaellt. Ein "unbekannt" das als online gilt, wuerde den Auftrag
    // ins Leere legen — der Bediener stuende ohne Etikett da.
    expect(isAgentOnline(null)).toBe(false);
    expect(isAgentOnline('')).toBe(false);
    expect(isAgentOnline('kein datum')).toBe(false);
  });
});

describe('isClaimable', () => {
  const now = 1_000_000;

  it('ein wartender Auftrag ist abholbereit', () => {
    expect(isClaimable({ status: JOB_STATUS.QUEUED, notBefore: iso(now - 1) }, now)).toBe(true);
  });

  it('erledigte und gescheiterte Auftraege nie', () => {
    expect(isClaimable({ status: JOB_STATUS.DONE }, now)).toBe(false);
    expect(isClaimable({ status: JOB_STATUS.FAILED }, now)).toBe(false);
  });

  it('wartet die Backoff-Sperre ab', () => {
    expect(isClaimable({ status: JOB_STATUS.QUEUED, notBefore: iso(now + 5_000) }, now)).toBe(false);
  });

  it('ein abgestuerzter Agent blockiert den Auftrag nicht fuer immer', () => {
    const frisch = { status: JOB_STATUS.CLAIMED, claimedAt: iso(now - 5_000) };
    const alt = { status: JOB_STATUS.CLAIMED, claimedAt: iso(now - 120_000) };
    expect(isClaimable(frisch, now)).toBe(false);
    expect(isClaimable(alt, now)).toBe(true);
  });
});

describe('shouldRetry / computeRetryDelayMs', () => {
  it('wiederholt bis zur Obergrenze', () => {
    expect(shouldRetry({ attempts: 0, maxAttempts: 3 })).toBe(true);
    expect(shouldRetry({ attempts: 2, maxAttempts: 3 })).toBe(true);
    expect(shouldRetry({ attempts: 3, maxAttempts: 3 })).toBe(false);
  });

  it('wartet laenger, aber nie ewig', () => {
    expect(computeRetryDelayMs(0)).toBe(2_000);
    expect(computeRetryDelayMs(1)).toBe(4_000);
    expect(computeRetryDelayMs(10)).toBe(30_000);
  });
});

describe('Notbremse PRINT_QUEUE', () => {
  const original = process.env.PRINT_QUEUE;
  afterEach(() => {
    if (original === undefined) delete process.env.PRINT_QUEUE;
    else process.env.PRINT_QUEUE = original;
  });

  it('ohne Konfiguration an', () => {
    delete process.env.PRINT_QUEUE;
    expect(printQueueEnabled()).toBe(true);
  });

  it('nur exakt off schaltet ab', () => {
    process.env.PRINT_QUEUE = 'off';
    expect(printQueueEnabled()).toBe(false);
    process.env.PRINT_QUEUE = 'false';
    expect(printQueueEnabled()).toBe(true);
  });
});
