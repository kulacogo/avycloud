import React, { useEffect, useRef, useState } from "react";
import type { OrderItem } from "../../types";

export type OpenOrderProduct = (item: OrderItem) => Promise<void>;

export function OrderProductButton({ item, onOpen, className = "text-xs" }: { item: OrderItem; onOpen?: OpenOrderProduct; className?: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const identifiable = Boolean(item.productId || item.pickHint?.productId || item.sku || item.pickHint?.sku || item.ean);
  return (
    <div className="min-w-0" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`group max-w-full text-left font-medium text-txt-primary hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded-sm disabled:hover:text-txt-primary ${className}`}
        aria-busy={pending}
        disabled={!onOpen || !identifiable || pending}
        title={!onOpen ? "Keine Berechtigung für Produktdaten" : !identifiable ? "Keine Produktzuordnung vorhanden" : `Produktdatenblatt: ${item.name}`}
        onClick={async (event) => {
          event.stopPropagation();
          if (!onOpen || pending) return;
          setPending(true);
          setError(null);
          try { await onOpen(item); }
          catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Produkt konnte nicht geöffnet werden."); }
          finally { if (mounted.current) setPending(false); }
        }}
      >
        <span className="line-clamp-2 group-hover:underline decoration-accent/50 underline-offset-2">{item.name || item.sku || "Artikel"}</span>
        {pending && <span className="sr-only">Produkt wird geladen…</span>}
      </button>
      {error && <p role="alert" className="text-xs text-danger max-w-sm whitespace-normal">{error}</p>}
    </div>
  );
}
