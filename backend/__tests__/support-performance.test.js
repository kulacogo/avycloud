'use strict';
const { aggregateSupport, readKauflandSupport, readEbaySupport, loadSupportPerformance } = require('../services/support-performance');
const window = { fromMs: Date.parse('2026-09-01T00:00:00Z'), toMs: Date.parse('2026-09-08T00:00:00Z') };
const message = (id, caseId, overrides = {}) => ({ id, caseId, at: '2026-09-03T10:00:00Z', isSeller: true, ...overrides });

describe('Supportbeitrag aus bestätigten Händlerantworten', () => {
  it('zählt Anliegen einmal, Antworten separat; dedupliziert wiederholten Import', () => {
    expect(aggregateSupport([message('1', 'a'), message('2', 'a'), message('3', 'b'), message('1', 'a')], window)).toEqual({ status: 'complete', cases: 2, replies: 3 });
  });
  it('zählt weder Käufer/System noch Antworten außerhalb des halboffenen Zeitfensters', () => {
    expect(aggregateSupport([message('1', 'a', { isSeller: false }), message('2', 'b', { at: '2026-09-08T00:00:00Z' }), message('3', 'c', { at: '2026-08-31T23:59:59Z' }), message('4', 'd', { at: '2026-09-01T00:00:00Z' })], window)).toEqual({ status: 'complete', cases: 1, replies: 1 });
  });
  it('macht unbekannte Zeit oder Fall-ID sichtbar statt Punkte zu erfinden', () => {
    expect(aggregateSupport([message('1', '', {}), message('2', 'a', { at: 'invalid' })], window)).toEqual({ status: 'limited', cases: 0, replies: 0 });
  });
  it('exportiert weder Kundentext noch Kundenkennung in die Leistungsantwort', () => {
    expect(JSON.stringify(aggregateSupport([message('1', 'a', { text: 'private-content', buyer: 'private-buyer' })], window))).not.toContain('private');
  });
});

describe('Kaufland: echte Antwortzeiten und vollständige Paginierung', () => {
  const raw = (id, ticket = 'ticket-a', role = 'seller') => ({ id_ticket_message: id, id_ticket: ticket, ts_created_iso: '2026-09-03T10:00:00Z', author: { role, name: 'Shop' }, text: 'private' });
  it('liest nur GET-Nachrichten, prüft Seiten und zählt nicht nach Shopnamen', async () => {
    const calls = [];
    const request = async (path, query) => { calls.push({ path, query }); return query.offset === 0 ? { data: [raw('1'), raw('2')], pagination: { total: 3 } } : { data: [raw('3', 'b')], pagination: { total: 3 } }; };
    expect(await readKauflandSupport({ request, ...window })).toEqual({ status: 'complete', cases: 2, replies: 3 });
    expect(calls.map(x => x.query.offset)).toEqual([0, 2]);
    expect(calls.every(x => x.path === '/tickets/messages' && x.query.limit === 30)).toBe(true);
  });
  it('markiert eine abgeschnittene Antwortliste als Teilmenge', async () => {
    const request = async () => ({ data: [raw('1')], pagination: { total: 50 } });
    expect(await readKauflandSupport({ request, ...window, maxPages: 1 })).toEqual({ status: 'limited', cases: 1, replies: 1 });
  });
  it('gibt bei Fehlern keine scheinbare Nullarbeit aus', async () => {
    const result = await readKauflandSupport({ request: async () => { throw Error('private'); }, ...window });
    expect(result).toEqual({ status: 'unavailable', cases: null, replies: null });
  });
});

describe('eBay: ausgehende Antworten statt Fragezeit/Antwortstatus', () => {
  it('findet neue Antworten in alten Konversationen und paginiert Nachrichten', async () => {
    const calls = [];
    const request = async (path, query) => {
      calls.push({ path, query });
      if (path.endsWith('/conversation')) return { total: 1, conversations: [{ conversationId: 'old', createdDate: '2025-01-01', latestMessage: { createdDate: '2026-09-04T10:00:00Z' } }] };
      return { total: 51, messages: query.offset === 0 ? Array.from({ length: 50 }, (_, i) => ({ messageId: String(i), senderUsername: i === 0 ? 'OurShop' : 'Buyer', createdDate: '2026-09-03T10:00:00Z' })) : [{ messageId: 'last', senderUsername: 'Buyer', createdDate: '2026-09-03T10:00:00Z' }] };
    };
    expect(await readEbaySupport({ request, username: 'ourshop', ...window })).toEqual({ status: 'complete', cases: 1, replies: 1 });
    expect(calls[0].query.start_time).toBeUndefined();
    expect(calls.map(x => x.query.offset)).toEqual([0, 0, 50]);
  });
  it('verwendet keine unbekannte Händleridentität und keinen bloßen Answered-Status', async () => {
    let calls = 0;
    const result = await readEbaySupport({ request: async () => { calls++; }, username: '', ...window });
    expect(result.status).toBe('unavailable');
    expect(calls).toBe(0);
  });
  it('verwechselt fehlende oder unbekannte Antwortstrukturen nicht mit null Antworten', async () => {
    const request = async (path) => path.endsWith('/conversation') ? { total: 1, conversations: [{ conversationId: 'x', latestMessage: { createdDate: '2026-09-04' } }] } : { MessageStatus: 'Answered' };
    expect((await readEbaySupport({ request, username: 'shop', ...window })).status).toBe('limited');
  });
});

describe('Alleinzuständigkeit gemäß Betreiberanweisung', () => {
  it('ordnet beide Kanäle dem konfigurierten persönlichen Konto zu', async () => {
    const result = await loadSupportPerformance({ tenantId: 'default', ...window }, {
      readAssignment: async () => ({ tenantId: 'default', responsibleUid: 'yasemin', exclusive: true }),
      readKaufland: async () => ({ status: 'complete', cases: 2, replies: 5 }),
      readEbay: async () => ({ status: 'connection_required', cases: null, replies: null }),
    });
    expect(result.ownerUid).toBe('yasemin');
    expect(result.attribution).toBe('exclusive_responsibility');
    expect(result.complete).toBe(false);
    expect(result.channels.kaufland.cases).toBe(2);
  });
  it('nutzt globale Marktplatzverbindungen niemals für andere Mandanten', async () => {
    const fail = async () => { throw Error('must not be called'); };
    const result = await loadSupportPerformance({ tenantId: 'foreign', ...window }, { readAssignment: fail, readKaufland: fail, readEbay: fail });
    expect(result.ownerUid).toBeNull();
    expect(result.complete).toBe(false);
  });
  it('lehnt widersprüchliche Zuordnung ab, ohne Shopaktivität jemand anderem zuzuschreiben', async () => {
    let calls = 0;
    const result = await loadSupportPerformance({ tenantId: 'default', ...window }, { readAssignment: async () => ({ tenantId: 'foreign', responsibleUid: 'other', exclusive: true }), readKaufland: async () => { calls++; }, readEbay: async () => { calls++; } });
    expect(result.ownerUid).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('Schutz gegen überlappende Marktplatzseiten', () => {
  it('behauptet bei wiederholten Kaufland-Seiten keine vollständige Abdeckung', async () => {
    const request = async () => ({ data: [{ id_ticket_message: '1', id_ticket: 'a', author: { role: 'seller' }, ts_created_iso: '2026-09-03' }], pagination: { total: 2 } });
    expect(await readKauflandSupport({ request, ...window })).toEqual({ status: 'limited', cases: 1, replies: 1 });
  });
  it('erkennt überlappende eBay-Seiten trotz scheinbar erreichtem total', async () => {
    const request = async (path) => path.endsWith('/conversation')
      ? { total: 100, conversations: Array.from({ length: 50 }, (_, i) => ({ conversationId: String(i), latestMessage: { createdDate: '2026-08-01' } })) }
      : { total: 0, messages: [] };
    expect((await readEbaySupport({ request, username: 'shop', ...window })).status).toBe('limited');
  });
});
