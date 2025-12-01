import React, { useEffect, useRef } from 'react';
import FileAttachmentPreview from './FileAttachmentPreview';
import { SendIcon, PaperClipIcon } from '../icons/Icons';

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
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-500">
        <button
          type="button"
          aria-label="Verlauf löschen"
          onClick={onClearChat}
          className="rounded-full border border-slate-700 px-3 py-1 text-slate-300 hover:border-sky-500 hover:text-white"
        >
          Verlauf löschen
        </button>
        <button
          type="button"
          aria-label="Datei hochladen"
          onClick={handleAttachClick}
          className="rounded-full border border-slate-700 px-3 py-1 text-slate-300 hover:border-sky-500 hover:text-white"
        >
          Upload file
        </button>
        <button
          type="button"
          aria-label="Produktkontext einfügen"
          onClick={onInsertContext}
          className="rounded-full border border-slate-700 px-3 py-1 text-slate-300 hover:border-sky-500 hover:text-white"
        >
          Kontext einfügen
        </button>
        <span className="ml-auto text-[10px] text-slate-500">
          {characters}/{charLimit}
        </span>
      </div>

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

      <div className="flex items-end gap-3">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder="Frag GPT nach Preisen, Bildern oder Optimierungen..."
          value={value}
          onChange={(event) => onChange(event.target.value.slice(0, charLimit))}
          onKeyDown={handleKeyDown}
          className="h-12 flex-1 resize-none rounded-2xl bg-slate-800/80 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500"
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-label="Datei anhängen"
            onClick={handleAttachClick}
            className="flex items-center justify-center rounded-2xl border border-slate-700 bg-slate-800/70 px-3 py-2 text-slate-200 hover:border-sky-400 hover:text-white"
          >
            <PaperClipIcon className="h-4 w-4" />
            <span className="ml-2 text-xs uppercase tracking-wide">Attach</span>
          </button>
          <button
            type="button"
            aria-label="Nachricht senden"
            onClick={onSend}
            disabled={disabled || (!value.trim() && attachments.length === 0)}
            className="flex items-center justify-center rounded-2xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-600"
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

