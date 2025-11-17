
import React, { useState, useEffect } from 'react';
import { ProductImage } from '../types';
import { DownloadIcon } from './icons/Icons';

interface ImageGalleryProps {
  images: ProductImage[];
  isEditing?: boolean;
  onDeleteImage?: (index: number) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

const ImageGallery: React.FC<ImageGalleryProps> = ({ images, isEditing = false, onDeleteImage, onReorder }) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    // Reset to the first image when the product changes
    setActiveIndex(0);
  }, [images]);

  if (!images || images.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-64 bg-slate-700 rounded-lg text-slate-400">
        No Images Available
      </div>
    );
  }

  // Ensure at least 3 images (pad with placeholders)
  const minImages = 3;
  const ensureList = (arr: (ProductImage | undefined | null)[]) => {
    const result = arr.filter(Boolean) as ProductImage[];
    const placeholder = (i: number): ProductImage => ({
      source: 'web',
      variant: 'other',
      url_or_base64: `https://placehold.co/600x600/1f2937/94a3b8?text=Image+${i+1}`
    });
    while (result.length < minImages) result.push(placeholder(result.length));
    return result;
  };

  const padded = ensureList(images || []);
  const activeImage = padded[activeIndex] || padded[0];
  const originalCount = images?.length || 0;
  const isActiveReal = activeIndex < originalCount;
  const resolveSrc = (img: ProductImage | any) => (img?.url_or_base64 ? img.url_or_base64 : img?.url ? img.url : '');
  const placeholder = 'https://placehold.co/600x600/1f2937/94a3b8?text=No+Image';

  const openLightbox = (index: number) => {
    setLightboxIndex(index);
  };

  const closeLightbox = () => setLightboxIndex(null);

  const handleDragStart = (index: number) => {
    if (!isEditing || !onReorder || index >= originalCount) return;
    setDragIndex(index);
  };

  const handleDrop = (index: number) => {
    if (!isEditing || !onReorder) return;
    if (dragIndex === null) {
      setDragIndex(null);
      return;
    }
    const boundedTarget = Math.max(0, Math.min(originalCount - 1, index));
    if (boundedTarget === dragIndex) {
      setDragIndex(null);
      return;
    }
    onReorder(dragIndex, boundedTarget);
    setDragIndex(null);
  };

  return (
    <div>
      <div className="relative w-full aspect-square bg-slate-700 rounded-lg overflow-hidden group">
        <img
          src={resolveSrc(activeImage) || placeholder}
          alt={`Product image ${activeIndex + 1}`}
          className="w-full h-full object-contain"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
          onClick={() => openLightbox(activeIndex)}
        />
        {isEditing && onDeleteImage && isActiveReal && (
          <button
            aria-label="Delete selected image"
            onClick={() => onDeleteImage(activeIndex)}
            className="absolute top-2 left-2 px-2 py-1 text-xs bg-red-600 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity"
          >
            Delete
          </button>
        )}
        <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={() => openLightbox(activeIndex)}
            className="p-2 bg-black/50 text-white rounded-full"
            aria-label="Bild vergrößern"
          >
            🔍
          </button>
          <a
            href={resolveSrc(activeImage) || '#'}
            download={`product-image-${activeIndex + 1}`}
            className="p-2 bg-black/50 text-white rounded-full"
            aria-label="Download image"
          >
            <DownloadIcon />
          </a>
        </div>
        {activeImage.source === 'generated' && (
            <span className="absolute bottom-2 left-2 px-2 py-1 text-xs bg-sky-500/80 text-white rounded">AI Generated</span>
        )}
      </div>
      <div className="grid grid-cols-4 gap-2 mt-2">
        {padded.map((image, index) => {
          const isReal = index < originalCount;
          return (
          <div
            key={index}
            role="button"
            tabIndex={0}
            onClick={() => setActiveIndex(index)}
            onKeyDown={(e) => e.key === 'Enter' && setActiveIndex(index)}
            className={`relative aspect-square rounded-md overflow-hidden border-2 transition-colors cursor-pointer ${
              index === activeIndex ? 'border-sky-500' : 'border-transparent hover:border-slate-500'
            }`}
            draggable={isEditing && isReal}
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => {
              if (isEditing && isReal) {
                e.preventDefault();
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(index);
            }}
            onDragEnd={() => setDragIndex(null)}
          >
            <img
              src={resolveSrc(image) || placeholder}
              alt={`Thumbnail ${index + 1}`}
              className="w-full h-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
            />
            {isEditing && onDeleteImage && isReal && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Delete image thumbnail"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteImage(index);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.stopPropagation();
                    onDeleteImage(index);
                  }
                }}
                className="absolute top-1 right-1 px-1 py-0.5 text-[10px] bg-red-600 text-white rounded opacity-0 hover:opacity-100 transition-opacity"
              >
                ×
              </span>
            )}
          </div>
        );})}
      </div>
      {lightboxIndex !== null && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute top-4 right-4 px-3 py-1 text-sm rounded-full bg-white/80 text-slate-900"
            onClick={closeLightbox}
          >
            Schließen
          </button>
          <img
            src={resolveSrc(padded[lightboxIndex]) || placeholder}
            alt={`Großansicht ${lightboxIndex + 1}`}
            className="max-h-[85vh] max-w-[90vw] object-contain rounded-lg shadow-2xl"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
          />
        </div>
      )}
    </div>
  );
};

export default ImageGallery;
