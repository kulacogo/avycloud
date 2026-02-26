import React, { useState, useEffect } from 'react';

function useTransparentLogo(src: string): string {
  const [dataSrc, setDataSrc] = useState<string>(src);
  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245) d[i + 3] = 0;
        }
        ctx.putImageData(imageData, 0, 0);
        setDataSrc(canvas.toDataURL('image/png'));
      } catch { /* keep original */ }
    };
    img.src = src;
  }, [src]);
  return dataSrc;
}

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export interface MobileHeaderProps {
  onToggleSidebar: () => void;
  onToggleTheme?: () => void;
  className?: string;
}

/* -------------------------------------------------------
   MobileHeader — shown only on mobile (< md breakpoint)
   ------------------------------------------------------- */
export const MobileHeader: React.FC<MobileHeaderProps> = React.memo(
  ({ onToggleSidebar, onToggleTheme, className = '' }) => {
    const logoSrc = useTransparentLogo('/avy_logo.png');
    return (
      <header
        className={`
          md:hidden
          h-14 bg-[var(--avy-deep)]
          flex items-center gap-3 px-4
          sticky top-0 z-[60]
          ${className}
        `.trim()}
      >
        {/* Hamburger */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="
            w-9 h-9 flex items-center justify-center rounded-lg
            text-white/70 hover:text-white hover:bg-white/[0.08]
            transition-colors duration-150
          "
          aria-label="Toggle sidebar"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>

        {/* Brand */}
        <div className="flex items-center gap-2.5 flex-1">
          <img src={logoSrc} alt="avycloud" className="h-7 w-auto object-contain" draggable={false} />
        </div>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={onToggleTheme}
          className="
            w-9 h-9 flex items-center justify-center rounded-lg
            text-white/50 hover:text-white hover:bg-white/[0.08]
            transition-colors duration-150
          "
          aria-label="Toggle theme"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5.25V3m0 18v-2.25m6.364-9.114l1.59-.918m-15.908.918l-1.59-.918M18.75 12h2.25M3 12h2.25m12.364 5.864l1.59.918m-15.908-.918l-1.59.918M16.5 12a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
          </svg>
        </button>
      </header>
    );
  }
);

MobileHeader.displayName = 'MobileHeader';
