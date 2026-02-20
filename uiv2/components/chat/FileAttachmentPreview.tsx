import React from 'react';

type FileAttachmentPreviewProps = {
  id: string;
  name: string;
  size: number;
  type: string;
  isImage: boolean;
  previewUrl?: string;
  onRemove: (id: string) => void;
};

const formatSize = (bytes: number) => {
  if (!bytes || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const FileAttachmentPreview: React.FC<FileAttachmentPreviewProps> = ({
  id,
  name,
  size,
  type,
  isImage,
  previewUrl,
  onRemove,
}) => {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-secondary)]/80 px-3 py-2 text-xs text-[color:var(--text-primary)]">
      {isImage ? (
        <img
          src={previewUrl}
          alt={name}
          className="h-10 w-10 rounded-md object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[var(--surface-hover)] text-[10px] uppercase text-[color:var(--text-tertiary)]">
          {type?.slice(0, 3) || 'file'}
        </div>
      )}
      <div className="flex-1 truncate">
        <p className="truncate font-semibold">{name}</p>
        <p className="text-[color:var(--text-tertiary)]">
          {type || 'Datei'} · {formatSize(size)}
        </p>
      </div>
      <button
        type="button"
        aria-label={`${name} entfernen`}
        onClick={() => onRemove(id)}
        className="rounded-full bg-[var(--surface-hover)] px-2 py-1 text-[11px] text-[color:var(--text-primary)] hover:bg-[var(--surface)]"
      >
        Entfernen
      </button>
    </div>
  );
};

export default FileAttachmentPreview;

