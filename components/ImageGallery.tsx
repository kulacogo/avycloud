
import React, { useState, useEffect } from 'react';
import { ProductImage } from '../types';
import { DownloadIcon } from './icons/Icons';

interface ImageGalleryProps {
  images: ProductImage[];
  isEditing?: boolean;
  onDeleteImage?: (index: number) => void;
}

const ImageGallery: React.FC<ImageGalleryProps> = ({ images, isEditing = false, onDeleteImage }) => {
  const [activeIndex, setActiveIndex] = useState(0);

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

  return (
    <div>
      <div className="relative w-full aspect-square bg-slate-700 rounded-lg overflow-hidden group">
        <img
          src={resolveSrc(activeImage) || placeholder}
          alt={`Product image ${activeIndex + 1}`}
          className="w-full h-full object-contain"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
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
        <a
          href={resolveSrc(activeImage) || '#'}
          download={`product-image-${activeIndex + 1}`}
          className="absolute top-2 right-2 p-2 bg-black/50 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Download image"
        >
          <DownloadIcon />
        </a>
        {activeImage.source === 'generated' && (
            <span className="absolute bottom-2 left-2 px-2 py-1 text-xs bg-sky-500/80 text-white rounded">AI Generated</span>
        )}
      </div>
      <div className="grid grid-cols-4 gap-2 mt-2">
        {padded.map((image, index) => {
          const isReal = index < originalCount;
          return (
          <button
            key={index}
            onClick={() => setActiveIndex(index)}
            className={`aspect-square rounded-md overflow-hidden border-2 transition-colors ${
              index === activeIndex ? 'border-sky-500' : 'border-transparent hover:border-slate-500'
            }`}
          >
            <img
              src={resolveSrc(image) || placeholder}
              alt={`Thumbnail ${index + 1}`}
              className="w-full h-full object-cover"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = placeholder; }}
            />
            {isEditing && onDeleteImage && isReal && (
              <button
                aria-label="Delete image thumbnail"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteImage(index);
                }}
                className="absolute top-1 right-1 px-1 py-0.5 text-[10px] bg-red-600 text-white rounded opacity-0 hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            )}
          </button>
        );})}
      </div>
    </div>
  );
};

export default ImageGallery;
