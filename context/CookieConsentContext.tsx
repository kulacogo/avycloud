import React, { createContext, useContext, useState, useCallback, useEffect } from "react";

export type ConsentCategories = {
  necessary: true;
  analytics: boolean;
  tracking: boolean;
};

type ConsentState = {
  categories: ConsentCategories;
  decidedAt: string;
};

type CookieConsentContextValue = {
  consent: ConsentCategories | null;
  hasDecided: boolean;
  showBanner: boolean;
  acceptAll: () => void;
  rejectOptional: () => void;
  updateConsent: (categories: Partial<Omit<ConsentCategories, "necessary">>) => void;
  resetConsent: () => void;
};

const STORAGE_KEY = "avycloud:cookie-consent";

const CookieConsentContext = createContext<CookieConsentContextValue | null>(null);

function loadConsent(): ConsentState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.categories?.necessary === true && typeof parsed.decidedAt === "string") {
      return parsed as ConsentState;
    }
    return null;
  } catch {
    return null;
  }
}

function saveConsent(categories: ConsentCategories): void {
  try {
    const state: ConsentState = {
      categories,
      decidedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage might be full or blocked
  }
}

export const CookieConsentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [consent, setConsent] = useState<ConsentCategories | null>(() => {
    const stored = loadConsent();
    return stored?.categories ?? null;
  });

  const hasDecided = consent !== null;
  const showBanner = !hasDecided;

  const acceptAll = useCallback(() => {
    const categories: ConsentCategories = {
      necessary: true,
      analytics: true,
      tracking: true,
    };
    setConsent(categories);
    saveConsent(categories);
  }, []);

  const rejectOptional = useCallback(() => {
    const categories: ConsentCategories = {
      necessary: true,
      analytics: false,
      tracking: false,
    };
    setConsent(categories);
    saveConsent(categories);
  }, []);

  const updateConsent = useCallback(
    (update: Partial<Omit<ConsentCategories, "necessary">>) => {
      const current = consent ?? { necessary: true as const, analytics: false, tracking: false };
      const next: ConsentCategories = {
        necessary: true,
        analytics: update.analytics ?? current.analytics,
        tracking: update.tracking ?? current.tracking,
      };
      setConsent(next);
      saveConsent(next);
    },
    [consent]
  );

  const resetConsent = useCallback(() => {
    setConsent(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }, []);

  const value: CookieConsentContextValue = {
    consent,
    hasDecided,
    showBanner,
    acceptAll,
    rejectOptional,
    updateConsent,
    resetConsent,
  };

  return (
    <CookieConsentContext.Provider value={value}>
      {children}
    </CookieConsentContext.Provider>
  );
};

export const useCookieConsent = (): CookieConsentContextValue => {
  const ctx = useContext(CookieConsentContext);
  if (!ctx) {
    throw new Error("useCookieConsent must be used within <CookieConsentProvider>");
  }
  return ctx;
};
