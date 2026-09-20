'use strict';

// Read-only marketplace support evidence. Shop replies are attributed through
// the owner's explicit exclusive-responsibility setting, not inferred identities.
const MESSAGE_SCOPE = 'https://api.ebay.com/oauth/api_scope/commerce.message';
const unavailable = (status = 'unavailable') => ({ status, cases: null, replies: null });
const id = (value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

function aggregateSupport(messages, { fromMs, toMs }) {
  const replies = new Set();
  const cases = new Set();
  let status = 'complete';
  for (const message of messages) {
    if (message?.isSeller == null) { status = 'limited'; continue; }
    if (message?.isSeller !== true) continue;
    const at = Date.parse(message.at);
    if (!Number.isFinite(at) || !id(message.id) || !id(message.caseId)) { status = 'limited'; continue; }
    if (at < fromMs || at >= toMs || replies.has(id(message.id))) continue;
    replies.add(id(message.id));
    cases.add(id(message.caseId));
  }
  return { status, cases: cases.size, replies: replies.size };
}

async function readKauflandSupport({ request, fromMs, toMs, maxPages = 20 }) {
  const messages = [];
  let offset = 0;
  let complete = false;
  const seen = new Set();
  let repeated = false;
  try {
    for (let page = 0; page < maxPages; page++) {
      const result = await request('/tickets/messages', { limit: 30, offset, sort: 'ts_created_iso:desc', ts_created_from_iso: new Date(fromMs).toISOString() });
      if (!Array.isArray(result?.data)) throw Error('Invalid support source');
      for (const row of result.data) {
        const key = id(row.id_ticket_message);
        if (seen.has(key)) repeated = true;
        seen.add(key);
        messages.push({ id: key, caseId: row.id_ticket, at: row.ts_created_iso, isSeller: ['seller', 'buyer', 'system', 'customer_service'].includes(row.author?.role) ? row.author.role === 'seller' : null });
      }
      offset += result.data.length;
      const total = result.pagination?.total;
      if (Number.isSafeInteger(total) && total >= 0 && offset >= total) { complete = true; break; }
      if (!result.data.length) break;
    }
  } catch (_) { if (!messages.length) return unavailable(); }
  const counts = aggregateSupport(messages, { fromMs, toMs });
  return { ...counts, status: complete && !repeated ? counts.status : 'limited' };
}

async function readEbaySupport({ request, username, fromMs, toMs, maxCalls = 45 }) {
  if (!id(username)) return unavailable();
  const seller = id(username).toLowerCase();
  const messages = [];
  const conversations = new Map();
  let calls = 0;
  let complete = true;
  const pageThrough = async (path, field, query, consume) => {
    let offset = 0;
    const seen = new Set();
    while (calls < maxCalls) {
      calls++;
      const result = await request(path, { conversation_type: 'FROM_MEMBERS', limit: 50, offset, ...query });
      const rows = result?.[field];
      if (!Array.isArray(rows)) throw Error('Invalid support source');
      for (const row of rows) {
        const key = id(field === 'conversations' ? row.conversationId : row.messageId);
        if (!key || seen.has(key)) complete = false;
        seen.add(key);
        consume(row);
      }
      if (Number.isSafeInteger(result.total) && result.total >= 0 && offset + rows.length >= result.total) return;
      if (rows.length !== 50) break;
      // eBay requires offsets aligned to the requested page size.
      offset += 50;
    }
    complete = false;
  };
  try {
    // No creation-time filter: an old conversation can have new replies.
    await pageThrough('/commerce/message/v1/conversation', 'conversations', {}, (row) => {
      const key = id(row.conversationId);
      const latestAt = Date.parse(row.latestMessage?.createdDate);
      if (!key || !Number.isFinite(latestAt)) { complete = false; return; }
      if (latestAt >= fromMs) conversations.set(key, row);
    });
    for (const key of conversations.keys()) {
      await pageThrough(`/commerce/message/v1/conversation/${encodeURIComponent(key)}`, 'messages', {}, (row) => {
        messages.push({ id: row.messageId, caseId: key, at: row.createdDate, isSeller: id(row.senderUsername) ? id(row.senderUsername).toLowerCase() === seller : null });
      });
    }
  } catch (_) { if (!messages.length && !conversations.size) return unavailable(); complete = false; }
  const counts = aggregateSupport(messages, { fromMs, toMs });
  return { ...counts, status: complete ? counts.status : 'limited' };
}

async function loadSupportPerformance({ tenantId, fromMs, toMs }, deps) {
  const base = { ownerUid: null, attribution: 'exclusive_responsibility', complete: false, channels: { kaufland: unavailable(), ebay: unavailable() } };
  // Existing eBay/Kaufland adapters use the original shared shop connections.
  // Never use these credentials for a different tenant.
  if (tenantId !== 'default') return base;
  const assignment = await deps.readAssignment(tenantId);
  if (assignment?.tenantId !== tenantId || !id(assignment.responsibleUid) || assignment.exclusive !== true) return base;
  const results = await Promise.allSettled([deps.readKaufland({ fromMs, toMs }), deps.readEbay({ fromMs, toMs })]);
  const [kaufland, ebay] = results.map((result) => result.status === 'fulfilled' ? result.value : unavailable());
  return { ...base, ownerUid: assignment.responsibleUid, channels: { kaufland, ebay }, complete: kaufland.status === 'complete' && ebay.status === 'complete' };
}

const cache = new Map();
function invalidateSupportCache() { cache.clear(); }
async function getSupportPerformance({ tenantId = 'default', range = 'week', from, to } = {}) {
  const key = JSON.stringify([tenantId, range, from, to]);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const { computeWindow } = require('./performance-scoreboard');
  const window = computeWindow({ range, from, to });
  const startedAt = Date.now();
  const withinBudget = () => { if (Date.now() - startedAt > 25000) throw Error('Support request budget reached'); };
  const promise = loadSupportPerformance({ tenantId, ...window }, {
    readAssignment: async (tenant) => {
      const { firestore } = require('../lib/firestore');
      const doc = await firestore.collection('support_assignments').doc(tenant).get();
      return doc.exists ? doc.data() : null;
    },
    readKaufland: (dates) => readKauflandSupport({ ...dates, request: async (path, query) => {
      withinBudget();
      const { kauflandRequest } = require('../lib/kaufland-api');
      return (await kauflandRequest('GET', path, { query, timeoutMs: 5000, maxRetries: 0 })).data;
    } }),
    readEbay: async (dates) => {
      const { getEbayIntegration } = require('../lib/ebay-oauth');
      const integration = await getEbayIntegration();
      if (!integration?.scopes?.includes(MESSAGE_SCOPE)) return unavailable('connection_required');
      const { ebayGetJson } = require('../lib/ebay-api');
      const request = (path, query) => { withinBudget(); return ebayGetJson(path, { query, timeoutMs: 7000 }); };
      const identityHost = integration.env === 'sandbox' ? 'apiz.sandbox.ebay.com' : 'apiz.ebay.com';
      const identity = await request(`https://${identityHost}/commerce/identity/v1/user/`);
      return readEbaySupport({ ...dates, request, username: identity?.username });
    },
  }).then((result) => ({ ...result, range: window.label, updatedAt: new Date().toISOString() }));
  // Coalesce concurrent views; bounded cache, no background sync or writes.
  if (cache.size >= 30) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: Date.now() + 60000, promise });
  try { return await promise; } catch (error) { cache.delete(key); throw error; }
}

module.exports = { MESSAGE_SCOPE, aggregateSupport, readKauflandSupport, readEbaySupport, loadSupportPerformance, getSupportPerformance, invalidateSupportCache };
