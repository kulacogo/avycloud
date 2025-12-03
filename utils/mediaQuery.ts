export type MediaQueryChangeHandler = (event: MediaQueryListEvent) => void;

const normalizeHandler = (handler: MediaQueryChangeHandler) => {
  return (event: MediaQueryListEvent | MediaQueryList) => {
    if (event && 'matches' in event) {
      handler(event as MediaQueryListEvent);
    } else {
      handler({
        matches: (event as MediaQueryList)?.matches ?? false,
        media: (event as MediaQueryList)?.media ?? '',
      } as MediaQueryListEvent);
    }
  };
};

export const addMediaQueryListener = (
  mq: MediaQueryList,
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

