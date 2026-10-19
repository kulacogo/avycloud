'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { isToolCallAllowed, scopeLabel, parseScopeSet } = require('./chat-scope');
const policy = require('./llm-prompts/chat-request-policy-v1.json');
const storage = new AsyncLocalStorage();

function currentRequest() { return storage.getStore()?.request || null; }
function withChatRequest(request, work, limitOverrides = {}) {
  // Eine Kaskade, ein Budget: weder Pipelinewechsel noch Retry setzen es zurück.
  if (storage.getStore()) return work();
  const full = parseScopeSet(request.scope).has('datasheet');
  return storage.run({ request, startedAt: Date.now(), limits: { ...policy.limits[full ? 'full' : 'focused'], ...limitOverrides }, modelCalls: 0, toolCalls: 0, groundingQueries: 0, labels: [] }, work);
}
function budgetError() {
  const error = new Error('Das Recherchebudget dieser Anfrage ist ausgeschöpft. Bitte den Auftrag eingrenzen oder einen neuen gezielten Auftrag starten.');
  error.code = 'CHAT_REQUEST_BUDGET';
  return error;
}
function consume(kind, label) {
  const state = storage.getStore();
  if (!state) return;
  const key = kind === 'model' ? 'modelCalls' : 'toolCalls';
  const max = kind === 'model' ? state.limits.maxModelCalls : state.limits.maxToolCalls;
  if (state[key] >= max || Date.now() - state.startedAt >= state.limits.durationMs) throw budgetError();
  state[key]++;
  state.labels.push(label || kind);
}
async function runModelCall(operation, label = 'chat') {
  consume('model', label);
  const result = await operation();
  const state = storage.getStore();
  if (state) {
    const response = result?.response || result;
    state.groundingQueries += (response?.candidates || []).reduce((n, candidate) => n + (candidate?.groundingMetadata?.webSearchQueries?.length || 0), 0);
  }
  return result;
}
async function runToolCall(name, operation, args = null) {
  const request = currentRequest();
  if (request && !isToolCallAllowed(name, args, request.scope)) {
    const error = new Error(`Werkzeug ${name} liegt außerhalb des Auftrags „${scopeLabel(request.scope)}“.`);
    error.code = 'CHAT_SCOPE_BLOCKED';
    throw error;
  }
  consume('tool', name);
  return operation();
}
function requestUsage() {
  const state = storage.getStore();
  if (!state) return null;
  return { policyVersion: policy.version, modelCalls: state.modelCalls, toolCalls: state.toolCalls, groundingQueries: state.groundingQueries, durationMs: Date.now() - state.startedAt, limits: state.limits };
}
function requestPrompt(scope, { finalize = false } = {}) {
  const template = parseScopeSet(scope).has('info') ? policy.information : finalize ? policy.finalize : policy.instruction;
  return `[${policy.version}] ${template.replaceAll('{{label}}', scopeLabel(scope || 'datasheet'))}`;
}
function createBudgetedModel(client, options) {
  const model = client.getGenerativeModel(options);
  return new Proxy(model, { get(target, property) {
    if (property === 'generateContent') return (...args) => runModelCall(() => target.generateContent(...args), 'legacy-generate');
    if (property === 'startChat') return (...args) => {
      const chat = target.startChat(...args);
      return new Proxy(chat, { get(chatTarget, key) {
        if (key === 'sendMessage') return (...messageArgs) => runModelCall(() => chatTarget.sendMessage(...messageArgs), 'legacy-send');
        const value = chatTarget[key];
        return typeof value === 'function' ? value.bind(chatTarget) : value;
      } });
    };
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
module.exports = { withChatRequest, currentRequest, runModelCall, runToolCall, requestUsage, requestPrompt, createBudgetedModel };
