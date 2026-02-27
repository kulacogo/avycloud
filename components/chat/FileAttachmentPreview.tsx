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
    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-900/80 px-3 py-2 text-xs text-slate-200">
      {isImage ? (
        <img
          src={previewUrl}
          alt={name}
          className="h-10 w-10 rounded-md object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-slate-800 text-[10px] uppercase text-slate-400">
          {type?.slice(0, 3) || 'file'}
        </div>
      )}
      <div className="flex-1 truncate">
        <p className="truncate font-semibold">{name}</p>
        <p className="text-slate-400">
          {type || 'Datei'} · {formatSize(size)}
        </p>
      </div>
      <button
        type="button"
        aria-label={`${name} entfernen`}
        onClick={() => onRemove(id)}
        className="rounded-full bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
      >
        Entfernen
      </button>
    </div>
  );
};

export default FileAttachmentPreview;

