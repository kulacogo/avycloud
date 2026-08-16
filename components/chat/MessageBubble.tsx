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
  /** Vorschlag ablehnen — ohne das blieb ein veralteter Vorschlag scharf stehen. */
  onDiscardDatasheetChange?: (changeId: string) => void;
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
  // Barcodes und Herstellernummer fehlten hier komplett. Enthielt eine Karte NUR
  // solche Felder, blieb die Zeile "Felder: …" sogar ganz weg — ein falsch
  // recherchierter Code fuhr unsichtbar mit und ersetzt beim Uebernehmen die
  // komplette Codeliste.
  if ((change as any).identity?.barcodes?.length || (change as any).barcodes?.length) fields.push('Barcodes (EAN/GTIN)');
  if ((change as any).identity?.mpn) fields.push('Herstellernummer');
  if (change.short_description) fields.push('Beschreibung');
  if (change.key_features?.length) fields.push('Highlights');
  if (change.attributes && Object.keys(change.attributes).length) fields.push('Attribute');
  if ((change as any).gpsr && Object.keys(((change as any).gpsr || {})).length) fields.push('GPSR');
  if (change.pricing) fields.push('Preis');
  if (change.notes) fields.push('Notizen');
  return fields;
};

/** Kurzfassung eines HTML-Textes fuer die Vorschau. */
const alsText = (html: string, maxLen = 260): string => {
  const roh = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return roh.length > maxLen ? `${roh.slice(0, maxLen)}…` : roh;
};

/**
 * Alle vorgeschlagenen Werte einer Karte — damit der Mensch VOR dem Uebernehmen
 * sieht, was geschrieben wird.
 *
 * Vorher zeigte die Karte nur Feldnamen und den Titel. Beschreibung, Highlights,
 * Merkmale, Preis, GPSR und die Kennnummern blieben unsichtbar — "Uebernehmen"
 * schrieb sie trotzdem und speicherte sofort.
 */
const ChangeDetails: React.FC<{ change: DatasheetChange }> = ({ change }) => {
  const c = change as any;
  const zeilen: Array<{ label: string; wert: string; warnung?: boolean }> = [];

  const barcodes = c.identity?.barcodes || c.barcodes;
  if (Array.isArray(barcodes) && barcodes.length) {
    zeilen.push({ label: 'Barcodes (EAN/GTIN)', wert: barcodes.join(', '), warnung: true });
  }
  if (c.identity?.mpn) zeilen.push({ label: 'Herstellernummer', wert: String(c.identity.mpn), warnung: true });
  if (c.identity?.brand) zeilen.push({ label: 'Marke', wert: String(c.identity.brand) });
  if (c.identity?.category || c.categoryPath) zeilen.push({ label: 'Kategorie', wert: String(c.categoryPath || c.identity.category) });
  if (change.short_description) zeilen.push({ label: 'Beschreibung', wert: alsText(change.short_description) });
  if (change.key_features?.length) {
    zeilen.push({ label: 'Highlights', wert: change.key_features.map((f: string) => `• ${f}`).join('\n') });
  }
  if (change.attributes && Object.keys(change.attributes).length) {
    zeilen.push({
      label: 'Merkmale',
      wert: Object.entries(change.attributes).map(([k, v]) => `${k}: ${v}`).join('\n'),
    });
  }
  if (change.pricing) {
    const p: any = change.pricing;
    const betrag = p.sellPrice ?? p.lowest_price?.amount ?? p.amount;
    if (betrag != null) {
      zeilen.push({
        label: 'Preis',
        wert: `${Number(betrag).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`,
        warnung: true,
      });
    }
  }
  if (c.gpsr && Object.keys(c.gpsr).length) {
    zeilen.push({
      label: 'GPSR-Angaben',
      wert: Object.entries(c.gpsr).map(([k, v]) => `${k}: ${v}`).join('\n'),
      warnung: true,
    });
  }
  const beleg = c.gpsr_evidence_check;
  if (beleg && beleg.outcome && beleg.outcome !== 'verified') {
    zeilen.push({ label: 'GPSR-Beleg', wert: `${beleg.outcome} — nicht bestätigt`, warnung: true });
  }

  if (!zeilen.length) return null;

  return (
    <details className="mt-2 rounded-lg bg-app-bg/50 p-2.5 ring-1 ring-app-border/30">
      <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wide text-txt-muted">
        Werte ansehen ({zeilen.length})
      </summary>
      <div className="mt-2 space-y-2">
        {zeilen.map((z) => (
          <div key={z.label}>
            <p className={`text-[11px] font-semibold ${z.warnung ? 'text-warning' : 'text-txt-muted'}`}>{z.label}</p>
            <p className="whitespace-pre-wrap break-words text-xs text-txt-primary">{z.wert}</p>
          </div>
        ))}
      </div>
    </details>
  );
};

const MessageBubble: React.FC<MessageBubbleProps> = ({
  role,
  text,
  timestamp,
  attachments = [],
  datasheetChanges = [],
  onApplyDatasheetChange,
  onDiscardDatasheetChange,
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
                  <ChangeDetails change={entry.change} />
                  <div className="mt-2.5 flex items-center gap-2">
                    {onApplyDatasheetChange && (
                      <button
                        type="button"
                        onClick={() => onApplyDatasheetChange(entry.id, entry.change)}
                        disabled={Boolean(applyingChangeIds?.has(entry.id))}
                        className="rounded-lg bg-accent px-4 py-1.5 text-xs font-semibold text-txt-primary hover:bg-accent/80 disabled:cursor-wait disabled:opacity-60 transition-colors"
                      >
                        {applyingChangeIds?.has(entry.id) ? 'Übernehme…' : 'Übernehmen'}
                      </button>
                    )}
                    {/* Ohne Verwerfen blieb ein abgelehnter oder veralteter
                        Vorschlag mit scharfem Uebernehmen-Knopf stehen. */}
                    {onDiscardDatasheetChange && (
                      <button
                        type="button"
                        onClick={() => onDiscardDatasheetChange(entry.id)}
                        disabled={Boolean(applyingChangeIds?.has(entry.id))}
                        className="rounded-lg border border-app-border px-3 py-1.5 text-xs font-medium text-txt-muted hover:text-txt-primary disabled:opacity-40"
                      >
                        Verwerfen
                      </button>
                    )}
                  </div>
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
