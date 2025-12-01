import React from 'react';

type AttachmentMessageProps = {
  name: string;
  url?: string;
  type?: string;
  size?: number;
  isImage?: boolean;
};

const formatSize = (bytes?: number) => {
  if (!bytes || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const AttachmentMessage: React.FC<AttachmentMessageProps> = ({
  name,
  url,
  type,
  size,
  isImage,
}) => {
  if (isImage && url) {
    return (
      <figure className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/70">
        <img
          src={url}
          alt={name}
          className="block h-40 w-full object-cover"
          loading="lazy"
          decoding="async"
        />
        <figcaption className="flex items-center justify-between px-3 py-2 text-xs text-slate-200">
          <span className="truncate">{name}</span>
          {url && (
            <a
              href={url}
              download={name}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:text-sky-200"
            >
              Download
            </a>
          )}
        </figcaption>
      </figure>
    );
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-xs text-slate-200">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold truncate">{name}</p>
          <p className="text-slate-400">{type || 'Datei'} {size ? `· ${formatSize(size)}` : ''}</p>
        </div>
        {url && (
          <a
            href={url}
            download={name}
            target="_blank"
            rel="noreferrer"
            className="ml-3 whitespace-nowrap text-sky-400 hover:text-sky-200"
          >
            Download
          </a>
        )}
      </div>
    </div>
  );
};

export default AttachmentMessage;

