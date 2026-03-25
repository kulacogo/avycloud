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
    const maxHeight = 8 * 24;
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

  return (
    <div className="space-y-2">
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
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
      )}

      {/* Input row */}
      <div className="flex items-end gap-2">
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            rows={1}
            aria-label="Chatnachricht eingeben"
            placeholder={t('chat.input.placeholder')}
            value={value}
            onChange={(event) => onChange(event.target.value.slice(0, charLimit))}
            onKeyDown={handleKeyDown}
            className="w-full resize-none rounded-xl bg-app-elevated/80 pl-4 pr-12 py-3 text-sm text-txt-primary placeholder-txt-muted/60 focus:outline-none focus:ring-1 focus:ring-accent/50 transition-shadow"
          />
          {/* Attach button inside textarea */}
          <button
            type="button"
            aria-label={t('chat.input.attachButton')}
            onClick={() => fileInputRef.current?.click()}
            className="absolute right-2 bottom-2 rounded-lg p-1.5 text-txt-muted hover:text-accent hover:bg-app-bg/40 transition-colors"
          >
            <PaperClipIcon className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          aria-label="Nachricht senden"
          onClick={onSend}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          className="flex-shrink-0 rounded-xl bg-accent p-3 text-txt-primary hover:bg-accent/80 disabled:cursor-not-allowed disabled:bg-app-border/50 disabled:text-txt-muted transition-colors"
        >
          <SendIcon className="h-4 w-4" />
        </button>
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
