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
  onApplyDatasheetChange?: (changeId: string) => void;
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
}) => {
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
      ? 'bg-sky-600/90 text-white'
      : 'bg-slate-800/90 text-slate-100 border border-slate-700/60';

  return (
    <div className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-none px-4 py-3 text-sm shadow-lg shadow-black/20 ${bubbleClasses}`}>
        <div className="space-y-3">
          {segments.map((segment, index) => {
            if (segment.type === 'code') {
              return (
                <div key={`code-${index}`} className="relative rounded-xl bg-slate-900/80 p-3 font-mono text-xs text-slate-200">
                  <pre className="overflow-auto whitespace-pre-wrap">
                    <code>{segment.value}</code>
                  </pre>
                  <button
                    type="button"
                    aria-label="Code kopieren"
                    onClick={() => navigator.clipboard?.writeText(segment.value)}
                    className="absolute right-2 top-2 rounded-md bg-slate-800/80 px-2 py-1 text-[10px] text-slate-200 hover:bg-slate-700"
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
                      className="break-words text-sky-300 underline hover:text-sky-200"
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
            <div className="space-y-2 rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">Übernehmbare Daten</p>
              {datasheetChanges.map((entry) => {
                const fieldKeys = Object.keys(entry.change).filter((key) => key !== 'summary');
                return (
                  <div key={entry.id} className="flex flex-col gap-2 rounded-lg bg-slate-900/80 p-3 text-xs text-slate-200">
                    <div>
                      <p className="text-sm font-semibold text-white">{entry.change.summary || 'Änderung aus Chat'}</p>
                      {fieldKeys.length > 0 && (
                        <p className="text-[11px] text-slate-400">Felder: {fieldKeys.join(', ')}</p>
                      )}
                    </div>
                    {onApplyDatasheetChange && (
                      <button
                        type="button"
                        onClick={() => onApplyDatasheetChange(entry.id)}
                        className="self-start rounded-full bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-sky-500"
                      >
                        Übernehmen
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {attachments.length > 0 && (
            <details className="rounded-xl border border-slate-700/60 bg-slate-900/60">
              <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-300">
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
        <span className="mt-2 block text-right text-[10px] uppercase tracking-wide text-slate-400">
          {formatTime(timestamp)}
        </span>
      </div>
    </div>
  );
};

export default MessageBubble;

