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
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
        <button
          type="button"
          aria-label={t('chat.input.clear')}
          onClick={onClearChat}
          className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] transition-colors duration-150"
        >
          {t('chat.input.clear')}
        </button>
        <button
          type="button"
          aria-label={t('chat.input.upload')}
          onClick={handleAttachClick}
          className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] transition-colors duration-150"
        >
          {t('chat.input.upload')}
        </button>
        <button
          type="button"
          aria-label={t('chat.input.context')}
          onClick={onInsertContext}
          className="rounded-full border border-[var(--border)] px-3 py-1 text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] transition-colors duration-150"
        >
          {t('chat.input.context')}
        </button>
        <span className="ml-auto text-[10px] text-[var(--text-tertiary)]">
          {characters}/{charLimit}
        </span>
      </div>

      {attachments.length > 0 && (
        <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
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
          placeholder={t('chat.input.placeholder')}
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, charLimit))}
          onKeyDown={handleKeyDown}
          className="h-12 flex-1 resize-none rounded-xl bg-[var(--surface-secondary)] px-4 py-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-tertiary)] border border-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--avy-purple)] transition-colors duration-150"
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-label={t('chat.input.attachButton')}
            onClick={handleAttachClick}
            className="flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] transition-colors duration-150"
          >
            <PaperClipIcon className="h-4 w-4" />
            <span className="ml-2 text-xs uppercase tracking-wide">{t('chat.input.attachButton')}</span>
          </button>
          <button
            type="button"
            aria-label={t('chat.input.send')}
            onClick={onSend}
            disabled={disabled || (!value.trim() && attachments.length === 0)}
            className="flex items-center justify-center rounded-xl bg-[var(--avy-purple)] px-4 py-3 text-sm font-semibold text-white hover:bg-[var(--avy-purple-hover)] hover:shadow-[0_4px_12px_rgba(99,91,255,0.3)] disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200"
          >
            <SendIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        multiple
        onChange={handleFileChange}
      />
    </div>
  );
};

export default ChatInput;
