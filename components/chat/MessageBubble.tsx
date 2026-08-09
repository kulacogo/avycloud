import React, { useMemo } from 'react';
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
  onApplyDatasheetChange?: (changeId: string, change: DatasheetChange) => void | Promise<void>;
  applyingChangeIds?: Set<string>;
};

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

/** Convert simple markdown-like text to safe HTML for assistant messages */
const renderMarkdown = (text: string): string => {
  if (!text) return '';
  let html = text
    // Escape HTML entities first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Bold **text**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Inline code `text`
    .replace(/`([^`]+)`/g, '<code class="rounded bg-app-bg/60 px-1.5 py-0.5 text-xs font-mono text-accent">$1</code>')
    // URLs
    .replace(URL_REGEX, '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-accent underline break-all hover:text-accent/80">$1</a>')
    // Line breaks → paragraphs (double newline = new paragraph, single = <br>)
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      // Bullet lists
      const lines = trimmed.split('\n');
      const isList = lines.every((l) => /^[-•*]\s/.test(l.trim()));
      if (isList) {
        const items = lines
          .map((l) => l.replace(/^[-•*]\s+/, '').trim())
          .filter(Boolean)
          .map((l) => `<li>${l}</li>`)
          .join('');
        return `<ul class="list-disc pl-4 space-y-1">${items}</ul>`;
      }
      // Numbered lists
      const isNumbered = lines.every((l) => /^\d+[.)]\s/.test(l.trim()));
      if (isNumbered) {
        const items = lines
          .map((l) => l.replace(/^\d+[.)]\s+/, '').trim())
          .filter(Boolean)
          .map((l) => `<li>${l}</li>`)
          .join('');
        return `<ol class="list-decimal pl-4 space-y-1">${items}</ol>`;
      }
      return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`;
    })
    .filter(Boolean)
    .join('');
  return html;
};

const describeChangeFields = (change: DatasheetChange): string[] => {
  const fields: string[] = [];
  if (change.title || change.identity?.name) fields.push('Titel');
  if (change.identity?.brand) fields.push('Marke');
  if (change.identity?.category) fields.push('Kategorie');
  if (change.identity?.sku) fields.push('SKU');
  if (change.short_description) fields.push('Kurzbeschreibung');
  if (change.key_features?.length) fields.push('Highlights');
  if (change.attributes && Object.keys(change.attributes).length) fields.push('Attribute');
  if ((change as any).gpsr && Object.keys(((change as any).gpsr || {})).length) fields.push('GPSR');
  if (change.pricing) fields.push('Preis');
  if (change.notes) fields.push('Notizen');
  return fields;
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
  const renderedHtml = useMemo(() => {
    if (role === 'user') return null;
    return renderMarkdown(text);
  }, [role, text]);

  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] rounded-2xl text-sm leading-relaxed ${
          role === 'user'
            ? 'bg-accent/15 text-txt-primary px-4 py-2.5'
            : 'text-txt-primary px-1 py-1'
        }`}
      >
        {/* Message content */}
        {role === 'user' ? (
          <p className="whitespace-pre-line">{text}</p>
        ) : (
          <div
            className="chat-assistant-msg space-y-2 [&_p]:leading-relaxed [&_ul]:text-txt-secondary [&_ol]:text-txt-secondary [&_a]:text-accent [&_strong]:text-txt-primary [&_strong]:font-semibold"
            dangerouslySetInnerHTML={{ __html: renderedHtml || '' }}
          />
        )}

        {/* Inline datasheet changes */}
        {role === 'assistant' && datasheetChanges.length > 0 && (
          <div className="mt-3 space-y-2">
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
                <div key={entry.id} className="rounded-xl border border-app-border/60 bg-app-elevated/40 p-3">
                  <p className="text-sm font-semibold text-txt-primary">{entry.change.summary || 'Änderung aus Chat'}</p>
                  {fieldKeys.length > 0 && (
                    <p className="mt-0.5 text-xs text-txt-muted">Felder: {fieldKeys.join(', ')}</p>
                  )}
                  {proposedTitle && (
                    <div className="mt-2 rounded-lg bg-app-bg/50 p-2.5 ring-1 ring-app-border/30">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-txt-muted">Titel-Vorschlag</p>
                        <span
                          className={`text-[11px] font-semibold tabular-nums ${
                            titleLen > 80 ? 'text-danger' : titleLen < 55 ? 'text-warning' : 'text-txt-secondary'
                          }`}
                        >
                          {titleLen}/80
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-txt-primary">{proposedTitle}</p>
                    </div>
                  )}
                  {onApplyDatasheetChange && (
                    <button
                      type="button"
                      onClick={() => onApplyDatasheetChange(entry.id, entry.change)}
                      disabled={Boolean(applyingChangeIds?.has(entry.id))}
                      className="mt-2.5 rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-txt-primary hover:bg-accent/80 disabled:cursor-wait disabled:opacity-60 transition-colors"
                    >
                      {applyingChangeIds?.has(entry.id) ? 'Übernehme…' : 'Übernehmen'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Attachments */}
        {attachments.length > 0 && (
          <details className="mt-2 rounded-xl border border-app-border/40 bg-app-bg/40">
            <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-txt-muted">
              Anhänge ({attachments.length})
            </summary>
            <div className="grid gap-2 p-2 sm:grid-cols-2">
              {attachments.map((attachment) => (
                <AttachmentMessage key={attachment.id} {...attachment} />
              ))}
            </div>
          </details>
        )}

        {/* Timestamp */}
        <span className={`mt-1.5 block text-right text-[10px] text-txt-muted/60 ${role === 'user' ? '' : 'pr-2'}`}>
          {formatTime(timestamp)}
        </span>
      </div>
    </div>
  );
};

export default MessageBubble;
