'use strict';

const { CHANGE_FIELD_SCOPES, IDENTITY_FIELD_SCOPES, IDENTITY_CLEARABLE, CHANGE_PROTOCOL_FIELDS } = require('./chat-datasheet-contract');

/**
 * Rahmen der Chat-Schnellaktionen — an EINER Stelle.
 *
 * Die Knöpfe im Chat setzen einen engen Rahmen ("Preischeck" = pricing,
 * "Titel verbessern" = title, "EAN / GTIN finden" = gtin). Die Legacy-Pipeline
 * setzte ihn seit jeher hart durch; die heute laufende V2-Pipeline nahm ihn
 * entgegen, schrieb ihn ins Prompt — und wertete ihn beim Bereinigen NIE aus.
 *
 * Damit konnte ein Klick auf "Preischeck" Titel, Beschreibung, Highlights,
 * Merkmale, Marke und GPSR mitschreiben, und der Mensch konnte nichts davon
 * abwählen: alle Vorschläge stecken in EINER Karte.
 *
 * Eine Bitte im Prompt ist keine Durchsetzung. Diese Regeln liegen deshalb
 * gemeinsam hier, damit die beiden Wege nicht wieder auseinanderlaufen.
 */

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Zerlegt die Rahmen-Angabe und vereinheitlicht Schreibweisen. */
function parseScopeSet(scope = null) {
  const raw = safeString(scope).toLowerCase();
  if (!raw) return new Set();
  const out = new Set();
  raw
    .split(/[,\s|;]+/g)
    .map((token) => safeString(token))
    .filter(Boolean)
    .forEach((tokenRaw) => {
      const token = tokenRaw.toLowerCase();
      if (token === 'all' || token === 'full') {
        out.add('datasheet');
        return;
      }
      if (token === 'ean' || token === 'barcode' || token === 'barcodes') {
        out.add('gtin');
        return;
      }
      if (token === 'attr' || token === 'attrs') {
        out.add('attributes');
        return;
      }
      out.add(token);
    });
  return out;
}

/**
 * Welche Feldgruppen darf ein Lauf mit diesem Rahmen anfassen?
 *
 * Leerer Rahmen bleibt für interne Alt-Aufrufer abwärtskompatibel. HTTP-Chat
 * löst Freitext zuerst deterministisch auf; dort gibt es keinen leeren Rahmen.
 *
 * Marke und SKU hängen bewusst am Voll-Rahmen: sie sind Identität, keine
 * Textverbesserung. Notizen sind immer erlaubt — sie ändern keine Produktdaten.
 */
function buildScopeAllowMap(scope = null) {
  const scopeSet = parseScopeSet(scope);
  const unrestricted = scopeSet.size === 0 || scopeSet.has('datasheet');
  const allows = (...tokens) =>
    unrestricted || tokens.some((token) => scopeSet.has(String(token || '').toLowerCase()));

  return {
    title: allows('title'),
    brand: allows('brand'),
    category: allows('category'),
    sku: allows('sku'),
    mpn: allows('mpn'),
    barcodes: allows('gtin'),
    pricing: allows('pricing'),
    description: allows('description'),
    highlights: allows('highlights'),
    attributes: allows('attributes'),
    gpsr: allows('gpsr'),
    notes: true,
  };
}

const scopeCatalog = require('./chat-request-scope-catalog.json');
const SCOPE_LABELS = Object.freeze(scopeCatalog.labels);
const TOPIC_PATTERNS = Object.fromEntries(Object.entries(scopeCatalog.topics).map(([key, pattern]) => [key, new RegExp(pattern, 'i')]));

function scopeLabel(scope) {
  const groups = [...parseScopeSet(scope)];
  if (groups.includes('datasheet')) return SCOPE_LABELS.datasheet;
  if (groups.length === 1 && groups[0] === 'info') return SCOPE_LABELS.info;
  return `Nur ${groups.map(group => SCOPE_LABELS[group] || group).join(' + ')}`;
}

// Kein Modellaufruf zur Intent-Erkennung: eindeutig genannte Arbeitsbereiche
// sind bereits die Berechtigung. Unklare Änderungsaufträge werden nicht breit.
function resolveRequestScope({ scope = null, message = '' } = {}) {
  const explicit = [...parseScopeSet(scope)];
  if (explicit.length) {
    const valid = explicit.every(key => Object.hasOwn(SCOPE_LABELS, key));
    const normalized = explicit.includes('datasheet') ? 'datasheet' : explicit.join(',');
    return { scope: valid ? normalized : 'info', label: valid ? scopeLabel(normalized) : 'Arbeitsumfang klären', source: 'explicit', needsClarification: !valid };
  }
  const text = safeString(message);
  const informational = new RegExp(scopeCatalog.information, 'i').test(text);
  // Negationen/Erhaltungswünsche und Formulierungsdetails erweitern den Auftrag nicht.
  const positive = text.replace(/,?\s*sondern\s+/gi, '. ')
    .replace(new RegExp(scopeCatalog.unchanged, 'gi'), '')
    .replace(new RegExp(scopeCatalog.negation, 'gi'), '')
    .replace(new RegExp(scopeCatalog.constraints, 'gi'), '');
  if (!informational && new RegExp(scopeCatalog.broad, 'i').test(positive)) {
    return { scope: 'datasheet', label: scopeLabel('datasheet'), source: 'message', needsClarification: false };
  }
  const namedGroups = (value) => Object.entries(TOPIC_PATTERNS).filter(([, re]) => re.test(value)).map(([key]) => key);
  const onlyClause = positive.match(/\bnur\b([^,;.!?]+)/i)?.[1] || '';
  const onlyGroups = namedGroups(onlyClause);
  const groups = informational ? [] : onlyGroups.length ? onlyGroups : namedGroups(positive);
  const ambiguous = groups.length > 1 && !/\b(?:und|sowie|plus)\b|[,;.!?]/i.test(positive);
  if (ambiguous) return { scope: 'info', label: 'Arbeitsumfang klären', source: 'message', needsClarification: true };
  const inferred = groups.join(',') || 'info';
  const needsClarification = !groups.length && !informational && new RegExp(scopeCatalog.action, 'i').test(text);
  return { scope: inferred, label: needsClarification ? 'Arbeitsumfang klären' : scopeLabel(inferred), source: 'message', needsClarification };
}

function scopeAllowsGroup(scope, group) {
  const groups = parseScopeSet(scope);
  return groups.size === 0 || groups.has('datasheet') || groups.has(group) || (group === 'notes' && !groups.has('info'));
}

function filterChangesByScope(changes, scope) {
  const blocked = [];
  const output = [];
  for (const input of Array.isArray(changes) ? changes : []) {
    if (!input || typeof input !== 'object') continue;
    const change = {};
    let dataFields = 0;
    for (const [field, value] of Object.entries(input)) {
      if (CHANGE_PROTOCOL_FIELDS.includes(field)) { change[field] = value; continue; }
      if (field === 'identity' && value && typeof value === 'object') {
        const identity = {};
        for (const [key, entry] of Object.entries(value)) {
          if (key === '_clear' || key === 'clear') {
            const clear = (Array.isArray(entry) ? entry : []).filter(name => IDENTITY_CLEARABLE.includes(name) && scopeAllowsGroup(scope, IDENTITY_FIELD_SCOPES[name]));
            if (clear.length) identity[key] = clear;
            if (clear.length !== (Array.isArray(entry) ? entry.length : 0)) blocked.push(`identity.${key}`);
          } else if ((IDENTITY_FIELD_SCOPES[key] || key === 'title') && scopeAllowsGroup(scope, IDENTITY_FIELD_SCOPES[key] || 'title')) {
            identity[key] = entry;
          } else blocked.push(`identity.${key}`);
        }
        if (Object.keys(identity).length) { change.identity = identity; dataFields++; }
      } else if (CHANGE_FIELD_SCOPES[field] && scopeAllowsGroup(scope, CHANGE_FIELD_SCOPES[field])) {
        change[field] = value; dataFields++;
      } else blocked.push(field);
    }
    if (dataFields) output.push(change);
  }
  return { changes: output, blocked: [...new Set(blocked)] };
}

const TOOL_GROUPS = Object.freeze({
  update_product_datasheet: ['title', 'pricing', 'description', 'highlights', 'attributes', 'gpsr', 'gtin', 'category', 'brand', 'sku', 'mpn'],
  validate_pricing: ['pricing'],
  enrich_ktype: ['attributes'], resolve_category: ['category'],
  lookup_gtin: ['gtin', 'attributes', 'category', 'brand', 'mpn'],
  search_ebay_catalog: ['title', 'pricing', 'description', 'highlights', 'attributes', 'gtin', 'category', 'brand', 'mpn'],
  verify_brand: ['brand', 'gpsr'],
  get_required_aspects: ['attributes', 'category'],
  search_amazon_product: ['pricing', 'gtin', 'attributes'],
  search_manufacturer_site: ['gpsr', 'attributes', 'mpn'],
  suggest_product_images: ['images'], generate_ai_images: ['images'],
  fetch_url_content: ['*'], brightdata_web_search: ['*'], serpapi_web_search: ['*'], web_fetch: ['*'],
});
function isToolAllowed(name, scope) {
  const permitted = TOOL_GROUPS[name];
  if (!permitted) return false;
  if (permitted.includes('*')) return true;
  return permitted.some(group => scopeAllowsGroup(scope, group));
}
function isToolCallAllowed(name, args, scope) {
  if (!isToolAllowed(name, scope)) return false;
  // Ein generisches Suchwerkzeug darf keine gesperrte Bildsuche verstecken.
  if (name === 'serpapi_web_search' && /images?/i.test(String(args?.engine || ''))) return scopeAllowsGroup(scope, 'images');
  return true;
}
function filterToolDeclarations(declarations, scope) {
  return declarations.filter(tool => isToolAllowed(tool.name, scope)).map(tool => {
    if (tool.name !== 'update_product_datasheet' || !tool.parameters?.properties) return tool;
    const properties = {};
    for (const [field, schema] of Object.entries(tool.parameters.properties)) {
      if (CHANGE_PROTOCOL_FIELDS.includes(field)) properties[field] = schema;
      else if (field === 'identity') {
        const identity = Object.fromEntries(Object.entries(schema.properties || {}).filter(([key]) =>
          key === 'clear' || key === '_clear' ? scopeAllowsGroup(scope, 'gtin') : IDENTITY_FIELD_SCOPES[key] && scopeAllowsGroup(scope, IDENTITY_FIELD_SCOPES[key])));
        if (Object.keys(identity).length) properties.identity = { ...schema, properties: identity };
      } else if (CHANGE_FIELD_SCOPES[field] && scopeAllowsGroup(scope, CHANGE_FIELD_SCOPES[field])) properties[field] = schema;
    }
    const parameters = { ...tool.parameters, properties };
    if (parameters.required) parameters.required = parameters.required.filter(key => key in properties);
    return { ...tool, parameters };
  });
}

function restrictChatResult(result, request) {
  const { changes, blocked } = filterChangesByScope(result.datasheetChanges, request.scope);
  result.datasheetChanges = changes;
  if (request.scope === 'title') {
    const titles = changes.map(change => String(change.title || change.identity?.name || '').trim()).filter(Boolean);
    if (titles.length) {
      result.message = titles.map(title => `Titelvorschlag: ${title}`).join('\n');
      result.datasheetChanges = changes.map(change => ({ ...change, summary: 'Titel optimieren' }));
    }
  }
  if (!scopeAllowsGroup(request.scope, 'images')) result.imageSuggestions = [];
  result.requestScope = { ...request, enforced: true, blockedFields: [...new Set([...(result.requestScope?.blockedFields || []), ...blocked])] };
  return result;
}

module.exports = { parseScopeSet, buildScopeAllowMap, resolveRequestScope, scopeLabel, scopeAllowsGroup, filterChangesByScope, isToolAllowed, isToolCallAllowed, filterToolDeclarations, restrictChatResult };
