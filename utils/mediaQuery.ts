export type MediaQueryChangeHandler = (event: MediaQueryListEvent) => void;

export const getMediaQuery = (query?: string): MediaQueryList | null => {
  if (!query || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  try {
    return window.matchMedia(query);
  } catch (error) {
    console.warn(`matchMedia failed for query "${query}":`, error);
    return null;
  }
};

export const getMediaQueryMatches = (query: string, fallback = false): boolean => {
  const mq = getMediaQuery(query);
  if (!mq || typeof mq.matches !== 'boolean') {
    return fallback;
  }
  return mq.matches;
};

const normalizeHandler = (handler: MediaQueryChangeHandler) => {
  return (event: MediaQueryListEvent | MediaQueryList | null) => {
    if (event && 'matches' in (event as MediaQueryListEvent)) {
      handler(event as MediaQueryListEvent);
    } else {
      handler({
        matches: Boolean((event as MediaQueryList)?.matches),
        media: (event as MediaQueryList)?.media ?? '',
      } as MediaQueryListEvent);
    }
  };
};

export const addMediaQueryListener = (
  mq: MediaQueryList | null,
  handler: MediaQueryChangeHandler
): (() => void) => {
  if (!mq || typeof handler !== 'function') {
    return () => undefined;
  }

  const fallbackHandler = normalizeHandler(handler);

  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }

  const legacyMq = mq as MediaQueryList & {
    addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
    removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  };

  if (typeof legacyMq.addListener === 'function') {
    legacyMq.addListener(fallbackHandler);
    return () => {
      if (typeof legacyMq.removeListener === 'function') {
        legacyMq.removeListener(fallbackHandler);
      }
    };
  }

  return () => undefined;
};

