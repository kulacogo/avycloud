import React, { useEffect, useRef } from 'react';
import FileAttachmentPreview from './FileAttachmentPreview';
import { SendIcon, PaperClipIcon } from '../icons/Icons';
import { useI18n } from '../../i18n';

export type ChatInputAttachment = {
  id: string;
  name: string;
  size: number;
  type: string;
  isImage: boolean;
  previewUrl?: string;
};

type ChatInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  attachments: ChatInputAttachment[];
  onFilesSelected: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onClearChat: () => void;
  onInsertContext: () => void;
  charLimit?: number;
};

const ACCEPTED_TYPES = '.jpg,.jpeg,.png,.webp,.pdf,.txt,.csv,.json';

const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  disabled,
  attachments,
  onFilesSelected,
  onRemoveAttachment,
  onClearChat,
  onInsertContext,
  charLimit = 2000,
}) => {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const autoResize = () => {
    if (!textareaRef.current) return;
    const element = textareaRef.current;
    element.style.height = 'auto';
    const maxHeight = 10 * 24; // approx 10 rows * line-height
    element.style.height = `${Math.min(maxHeight, element.scrollHeight)}px`;
  };

  useEffect(() => {
    autoResize();
  }, [value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!disabled) {
        onSend();
      }
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) {
      onFilesSelected(event.target.files);
      event.target.value = '';
    }
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const characters = value.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-txt-muted">
        <button
          type="button"
          aria-label={t('chat.input.clear')}
          onClick={onClearChat}
          className="rounded-full border border-app-border px-3 py-1 text-txt-secondary hover:border-accent hover:text-txt-primary"
        >
          {t('chat.input.clear')}
        </button>
        <button
          type="button"
          aria-label={t('chat.input.upload')}
          onClick={handleAttachClick}
          className="rounded-full border border-app-border px-3 py-1 text-txt-secondary hover:border-accent hover:text-txt-primary"
        >
          {t('chat.input.upload')}
        </button>
        <button
          type="button"
          aria-label={t('chat.input.context')}
          onClick={onInsertContext}
          className="rounded-full border border-app-border px-3 py-1 text-txt-secondary hover:border-accent hover:text-txt-primary"
        >
          {t('chat.input.context')}
        </button>
        <span className="ml-auto text-[10px] text-txt-muted">
          {characters}/{charLimit}
        </span>
      </div>

      {attachments.length > 0 && (
        <details className="rounded-2xl border border-app-border bg-app-bg/60 px-3 py-2 text-xs text-txt-secondary">
          <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wide">
            {t('chat.input.attachments', { count: attachments.length })}
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <FileAttachmentPreview
                key={attachment.id}
                id={attachment.id}
                name={attachment.name}
                size={attachment.size}
                type={attachment.type}
                isImage={attachment.isImage}
                previewUrl={attachment.previewUrl}
                onRemove={onRemoveAttachment}
              />
            ))}
          </div>
        </details>
      )}

      <div className="flex items-end gap-3">
        <textarea
          ref={textareaRef}
          rows={1}
          aria-label="Chatnachricht eingeben"
          placeholder={t('chat.input.placeholder')}
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, charLimit))}
          onKeyDown={handleKeyDown}
          className="h-12 flex-1 resize-none rounded-2xl bg-app-elevated px-4 py-3 text-sm text-txt-primary placeholder-txt-muted focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
          aria-label={t('chat.input.attachButton')}
            onClick={handleAttachClick}
            className="flex items-center justify-center rounded-2xl border border-app-border bg-app-surface px-3 py-2 text-txt-secondary hover:border-accent hover:text-txt-primary"
          >
            <PaperClipIcon className="h-4 w-4" />
            <span className="ml-2 text-xs uppercase tracking-wide">{t('chat.input.attachButton')}</span>
          </button>
          <button
            type="button"
            aria-label="Nachricht senden"
            onClick={onSend}
            disabled={disabled || (!value.trim() && attachments.length === 0)}
            className="flex items-center justify-center rounded-2xl bg-accent px-4 py-3 text-sm font-semibold text-txt-primary hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-app-border"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        aria-label="Dateien zum Chat hinzufügen"
        className="hidden"
        multiple
        onChange={handleFileChange}
      />
    </div>
  );
};

export default ChatInput;

