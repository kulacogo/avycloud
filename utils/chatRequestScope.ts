interface ScopeCatalog { labels: Record<string, string>; topics: Record<string, string>; aliases: Record<string, string>; information: string; negation: string; broad: string; action: string; constraints: string; unchanged: string; }

export interface ChatRequestScope {
  scope: string;
  label: string;
  source: 'explicit' | 'message';
  needsClarification: boolean;
  enforced?: boolean;
  blockedFields?: string[];
}

/** UI preview uses the backend's vocabulary and expressions; the server enforces it. */
export function previewChatRequestScope(message: string, scope: string | null | undefined, catalog: ScopeCatalog): ChatRequestScope {
  const aliases = catalog.aliases as Record<string, string>;
  const labels = catalog.labels as Record<string, string>;
  const explicit = [...new Set((scope || '').trim().toLowerCase().split(/[,\s|;]+/).filter(Boolean).map(key => aliases[key] || key))];
  const label = (groups: string[]) => groups.includes('datasheet') ? labels.datasheet
    : groups.length === 1 && groups[0] === 'info' ? labels.info
      : `Nur ${groups.map(key => labels[key] || key).join(' + ')}`;
  if (explicit.length) {
    const valid = explicit.every(key => Object.hasOwn(labels, key));
    const groups = explicit.includes('datasheet') ? ['datasheet'] : explicit;
    return { scope: valid ? groups.join(',') : 'info', label: valid ? label(groups) : 'Arbeitsumfang klären', source: 'explicit', needsClarification: !valid };
  }
  const text = message.trim();
  const informational = new RegExp(catalog.information, 'i').test(text);
  const positive = text.replace(/,?\s*sondern\s+/gi, '. ')
    .replace(new RegExp(catalog.unchanged, 'gi'), '')
    .replace(new RegExp(catalog.negation, 'gi'), '')
    .replace(new RegExp(catalog.constraints, 'gi'), '');
  if (!informational && new RegExp(catalog.broad, 'i').test(positive)) {
    return { scope: 'datasheet', label: labels.datasheet, source: 'message', needsClarification: false };
  }
  const namedGroups = (value: string) => Object.entries(catalog.topics).filter(([, pattern]) => new RegExp(pattern, 'i').test(value)).map(([key]) => key);
  const onlyClause = positive.match(/\bnur\b([^,;.!?]+)/i)?.[1] || '';
  const onlyGroups = namedGroups(onlyClause);
  const groups = informational ? [] : onlyGroups.length ? onlyGroups : namedGroups(positive);
  const ambiguous = groups.length > 1 && !/\b(?:und|sowie|plus)\b|[,;.!?]/i.test(positive);
  if (ambiguous) return { scope: 'info', label: 'Arbeitsumfang klären', source: 'message', needsClarification: true };
  const needsClarification = !groups.length && !informational && new RegExp(catalog.action, 'i').test(text);
  return { scope: groups.join(',') || 'info', label: needsClarification ? 'Arbeitsumfang klären' : label(groups.length ? groups : ['info']), source: 'message', needsClarification };
}

/** Never reconstruct cards from untrusted prose after the server enforced the contract. */
export function shouldParseUnstructuredEdits(requestScope?: Pick<ChatRequestScope, 'enforced'>): boolean {
  return requestScope?.enforced !== true;
}
