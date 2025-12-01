import React, { useEffect, useRef, useState } from 'react';

type ChatContainerProps = {
  children: React.ReactNode;
  onFilesDropped?: (files: FileList) => void;
};

const ChatContainer: React.FC<ChatContainerProps> = ({ children, onFilesDropped }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isCompact, setIsCompact] = useState(false);
  const [width, setWidth] = useState(420);
  const [isDragActive, setIsDragActive] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const handleResize = () => {
      if (typeof window === 'undefined') return;
      const compact = window.innerWidth < 1024;
      setIsCompact(compact);
      if (compact) {
        setWidth(window.innerWidth);
      } else {
        setWidth((prev) => Math.min(Math.max(prev, 320), 520));
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleMouseMove = (event: MouseEvent) => {
    if (!resizeStartRef.current) return;
    const { x, width: startWidth } = resizeStartRef.current;
    const delta = x - event.clientX;
    const nextWidth = Math.min(Math.max(startWidth + delta, 320), 560);
    setWidth(nextWidth);
  };

  const stopResizing = () => {
    resizeStartRef.current = null;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', stopResizing);
  };

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isCompact) return;
    resizeStartRef.current = {
      x: event.clientX,
      width,
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResizing);
  };

  useEffect(() => () => stopResizing(), []);

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      setIsDragActive(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (containerRef.current?.contains(event.relatedTarget as Node)) {
      return;
    }
    setIsDragActive(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.files?.length) return;
    event.preventDefault();
    setIsDragActive(false);
    onFilesDropped?.(event.dataTransfer.files);
    event.dataTransfer.clearData();
  };

  return (
    <aside
      ref={containerRef}
      className={`relative flex h-full min-h-[420px] flex-col rounded-xl border border-slate-800/80 bg-slate-900/80 text-slate-100 ${
        isDragActive ? 'ring-2 ring-sky-500' : ''
      }`}
      style={{ width: isCompact ? '100%' : `${width}px` }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {!isCompact && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          className="absolute left-0 top-0 h-full w-1 cursor-col-resize rounded-l-xl bg-transparent transition hover:bg-sky-500/40"
          onMouseDown={handleResizeStart}
        />
      )}
      {children}
    </aside>
  );
};

export default ChatContainer;

