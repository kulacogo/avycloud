import React from 'react';
import AttachmentMessage from './AttachmentMessage';
import { DatasheetChange } from '../../types';

type MessageAttachment = {
  id: string;
  name: string;
  url?: string;
  type?: string;
  size?: number;
  isImage?: boolean;
};

type InlineDatasheetChange = {
  id: string;
  change: DatasheetChange;
};

type MessageBubbleProps = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  datasheetChanges?: InlineDatasheetChange[];
  onApplyDatasheetChange?: (changeId: string, change: DatasheetChange) => void;
  applyingChangeIds?: Set<string>;
};

const CODE_REGEX = /```([\w-]+)?\n([\s\S]*?)```/g;
const URL_REGEX = /(https?:\/\/[^\s)]+)/g;

const formatTime = (iso: string) => {
  if (!iso) return '';
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

const MessageBubble: React.FC<MessageBubbleProps> = ({
  role,
  text,
  timestamp,
  attachments = [],
  datasheetChanges = [],
  onApplyDatasheetChange,
  applyingChangeIds,
}) => {
  const describeChangeFields = (change: DatasheetChange): string[] => {
    const fields: string[] = [];
    if (change.title || change.identity?.name) {
      fields.push('Titel');
    }
    if (change.identity?.brand) {
      fields.push('Marke');
    }
    if (change.identity?.category) {
      fields.push('Kategorie');
    }
    if (change.identity?.sku) {
      fields.push('SKU');
    }
    if (change.short_description) {
      fields.push('Kurzbeschreibung');
    }
    if (change.key_features?.length) {
      fields.push('Highlights');
    }
    if (change.attributes && Object.keys(change.attributes).length) {
      fields.push('Attribute');
    }
    if ((change as any).gpsr && Object.keys(((change as any).gpsr || {})).length) {
      fields.push('GPSR');
    }
    if (change.pricing) {
      fields.push('Preis');
    }
    if (change.notes) {
      fields.push('Notizen');
    }
    return fields;
  };

  const segments: Array<{ type: 'text' | 'code'; value: string; language?: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CODE_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', value: match[2].trimEnd(), language: match[1] || 'text' });
    lastIndex = CODE_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  const bubbleClasses =
    role === 'user'
      ? 'bg-accent/90 text-txt-primary'
      : 'bg-app-elevated/90 text-txt-primary border border-app-border';

  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded px-4 py-3 text-sm shadow-lg shadow-black/20 ${bubbleClasses}`}>
        <div className="space-y-3">
          {segments.map((segment, index) => {
            if (segment.type === 'code') {
              return (
                <div key={`code-${index}`} className="relative rounded-xl bg-app-bg/80 p-3 font-mono text-xs text-txt-secondary">
                  <pre className="overflow-auto whitespace-pre-wrap">
                    <code>{segment.value}</code>
                  </pre>
                  <button
                    type="button"
                    aria-label="Code kopieren"
                    onClick={() => navigator.clipboard?.writeText(segment.value)}
                    className="absolute right-2 top-2 rounded-lg bg-app-surface px-2 py-1 text-[10px] text-txt-secondary hover:bg-app-elevated/60"
                  >
                    Copy
                  </button>
                </div>
              );
            }

            const parts = segment.value.split(URL_REGEX);
            return (
              <p key={`text-${index}`} className="whitespace-pre-line leading-relaxed">
                {parts.map((part, idx) => {
                  const isUrl = /^https?:\/\/\S+$/i.test(part);
                  return isUrl ? (
                    <a
                      key={`link-${idx}`}
                      href={part}
                      target="_blank"
                      rel="noreferrer"
                      className="break-words text-accent underline hover:text-accent"
                    >
                      {part}
                    </a>
                  ) : (
                    <span key={`span-${idx}`}>{part}</span>
                  );
                })}
              </p>
            );
          })}

          {role === 'assistant' && datasheetChanges.length > 0 && (
            <div className="space-y-2 rounded-xl border border-app-border bg-app-bg/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-txt-secondary">Übernehmbare Daten</p>
              {datasheetChanges.map((entry) => {
                const fieldKeys = describeChangeFields(entry.change);
                const proposedTitle =
                  typeof entry.change?.title === 'string' && entry.change.title.trim()
                    ? entry.change.title.trim()
                    : typeof (entry.change as any)?.identity?.name === 'string' && (entry.change as any).identity.name.trim()
                      ? (entry.change as any).identity.name.trim()
                      : '';
                const titleLen = proposedTitle ? proposedTitle.length : 0;
                return (
                  <div key={entry.id} className="flex flex-col gap-2 rounded-lg bg-app-bg/80 p-3 text-xs text-txt-secondary">
                    <div>
                      <p className="text-sm font-semibold text-txt-primary">{entry.change.summary || 'Änderung aus Chat'}</p>
                      {fieldKeys.length > 0 && (
                        <p className="text-[11px] text-txt-muted">Felder: {fieldKeys.join(', ')}</p>
                      )}
                      {proposedTitle && (
                        <div className="mt-2 rounded-lg bg-app-bg/30 p-2 ring-1 ring-app-border/40">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">
                              Titel-Vorschlag
                            </p>
                            <span
                              className={`text-[11px] font-semibold ${
                                titleLen > 80 ? 'text-danger' : titleLen < 55 ? 'text-amber-200' : 'text-txt-secondary'
                              }`}
                              title="eBay Hard-Limit: 80 Zeichen."
                            >
                              {titleLen}/80
                            </span>
                          </div>
                          <p className="mt-1 text-sm text-txt-primary">{proposedTitle}</p>
                        </div>
                      )}
                    </div>
                    {onApplyDatasheetChange && (
                      <button
                        type="button"
                        onClick={() => onApplyDatasheetChange(entry.id, entry.change)}
                        disabled={Boolean(applyingChangeIds?.has(entry.id))}
                        className="self-start rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-txt-primary hover:bg-accent/80 disabled:cursor-wait disabled:opacity-60"
                      >
                        {applyingChangeIds?.has(entry.id) ? 'Übernehme…' : 'Übernehmen'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {attachments.length > 0 && (
            <details className="rounded-xl border border-app-border bg-app-bg/60">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-txt-secondary">
                Anhänge ({attachments.length})
              </summary>
              <div className="grid gap-3 p-3 sm:grid-cols-2">
                {attachments.map((attachment) => (
                  <AttachmentMessage key={attachment.id} {...attachment} />
                ))}
              </div>
            </details>
          )}
        </div>
        <span className="mt-2 block text-right text-[10px] uppercase tracking-wide text-txt-muted">
          {formatTime(timestamp)}
        </span>
      </div>
    </div>
  );
};

export default MessageBubble;

