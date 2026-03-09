import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchOrderDetail,
  transitionOrderStatus,
  shipOrder,
  generateInvoice,
  generateDeliveryNote,
} from "../api/client";
import type { Order, OrderTimelineEvent, OmsStatus } from "../types";

/* ─── OMS Status Colors ─── */
const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  pending:    { bg: "bg-info-dim",    text: "text-info",    dot: "bg-info" },
  confirmed:  { bg: "bg-info-dim",    text: "text-info",    dot: "bg-info" },
  picking:    { bg: "bg-warning-dim", text: "text-warning", dot: "bg-warning" },
  picked:     { bg: "bg-accent-dim",  text: "text-accent",  dot: "bg-accent" },
  packing:    { bg: "bg-warning-dim", text: "text-warning", dot: "bg-warning" },
  packed:     { bg: "bg-success-dim", text: "text-success", dot: "bg-success" },
  shipped:    { bg: "bg-success-dim", text: "text-success", dot: "bg-success" },
  delivered:  { bg: "bg-success-dim", text: "text-success", dot: "bg-success" },
  completed:  { bg: "bg-app-elevated", text: "text-txt-secondary", dot: "bg-txt-muted" },
  cancelled:  { bg: "bg-danger-dim",  text: "text-danger",  dot: "bg-danger" },
  returned:   { bg: "bg-danger-dim",  text: "text-danger",  dot: "bg-danger" },
  on_hold:    { bg: "bg-warning-dim", text: "text-warning", dot: "bg-warning" },
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Neu", confirmed: "Bestätigt", picking: "Kommissionierung",
  picked: "Kommissioniert", packing: "Verpackung", packed: "Verpackt",
  shipped: "Versendet", delivered: "Zugestellt", completed: "Abgeschlossen",
  cancelled: "Storniert", returned: "Retourniert", on_hold: "Zurückgestellt",
};

/* ─── Props ─── */
interface OrderDetailProps {
  orderId: string;
  onClose: () => void;
  onStatusChange?: () => void;
}

/* ─── Component ─── */
export const OrderDetail: React.FC<OrderDetailProps> = ({ orderId, onClose, onStatusChange }) => {
  const [order, setOrder] = useState<Order | null>(null);
  const [timeline, setTimeline] = useState<OrderTimelineEvent[]>([]);
  const [nextStatuses, setNextStatuses] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "items" | "timeline">("details");
  const backdropRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrderDetail(orderId);
      setOrder(data.order);
      setTimeline(data.timeline || []);
      setNextStatuses(data.nextStatuses || []);
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden");
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose();
  }, [onClose]);

  const handleTransition = useCallback(async (toStatus: string) => {
    setTransitioning(true);
    setError(null);
    try {
      await transitionOrderStatus(orderId, toStatus);
      await loadData();
      onStatusChange?.();
    } catch (err: any) {
      setError(err.message || "Statusübergang fehlgeschlagen");
    } finally {
      setTransitioning(false);
    }
  }, [orderId, loadData, onStatusChange]);

  const omsStatus = order?.omsStatus || order?.status || "pending";
  const statusColor = STATUS_COLORS[omsStatus] || STATUS_COLORS.pending;

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
    >
      <div className="w-full max-w-2xl bg-app-surface border-l border-app-border shadow-2xl flex flex-col h-full animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center gap-3 p-5 border-b border-app-border shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-txt-primary truncate">
                {order?.orderId || order?.number || order?.id || "..."}
              </h2>
              {omsStatus && (
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium ${statusColor.bg} ${statusColor.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${statusColor.dot}`} />
                  {STATUS_LABELS[omsStatus] || omsStatus}
                </span>
              )}
            </div>
            {order?.marketplace && (
              <p className="text-xs text-txt-muted mt-0.5">
                {order.marketplace === "ebay" ? "eBay" : order.marketplace === "kaufland" ? "Kaufland" : order.marketplace}
                {order.marketplaceOrderId ? ` · ${order.marketplaceOrderId}` : ""}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-app-elevated text-txt-muted hover:text-txt-primary transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Loading / Error */}
        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-pulse text-txt-muted">Lade Auftragsdaten...</div>
          </div>
        )}

        {error && (
          <div className="mx-5 mt-4 bg-danger-dim rounded-lg p-3">
            <p className="text-sm text-danger">{error}</p>
          </div>
        )}

        {!loading && order && (
          <>
            {/* Status Actions */}
            {nextStatuses.length > 0 && (
              <div className="px-5 pt-4 pb-2 border-b border-app-border shrink-0">
                <p className="text-xs text-txt-muted mb-2">Nächster Schritt</p>
                <div className="flex flex-wrap gap-2">
                  {nextStatuses.map((status) => {
                    const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
                    const isCancelOrReturn = status === "cancelled" || status === "returned" || status === "on_hold";
                    return (
                      <button
                        key={status}
                        onClick={() => handleTransition(status)}
                        disabled={transitioning}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                          isCancelOrReturn
                            ? "border border-danger/30 text-danger hover:bg-danger-dim"
                            : `${color.bg} ${color.text} hover:opacity-80`
                        }`}
                      >
                        {transitioning ? "..." : `→ ${STATUS_LABELS[status] || status}`}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tab Navigation */}
            <div className="px-5 pt-3 border-b border-app-border shrink-0">
              <div className="flex gap-4">
                {(["details", "items", "timeline"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === tab
                        ? "border-accent text-accent"
                        : "border-transparent text-txt-muted hover:text-txt-primary"
                    }`}
                  >
                    {tab === "details" ? "Details" : tab === "items" ? `Positionen (${order.items?.length || 0})` : `Verlauf (${timeline.length})`}
                  </button>
                ))}
              </div>
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {activeTab === "details" && (
                <>
                  {/* Customer */}
                  <section>
                    <h3 className="text-sm font-medium text-txt-primary mb-2">Kunde</h3>
                    <div className="bg-app-bg rounded-lg p-3 space-y-1.5 text-sm">
                      <div className="font-medium text-txt-primary">{order.customer?.name || "Unbekannt"}</div>
                      {order.customer?.street && <div className="text-txt-secondary">{order.customer.street}</div>}
                      {(order.customer?.zip || order.customer?.city) && (
                        <div className="text-txt-secondary">{[order.customer.zip, order.customer.city].filter(Boolean).join(" ")}</div>
                      )}
                      {order.customer?.country && <div className="text-txt-muted text-xs">{order.customer.country}</div>}
                      {order.customer?.email && <div className="text-txt-muted text-xs">{order.customer.email}</div>}
                      {order.customer?.phone && <div className="text-txt-muted text-xs">{order.customer.phone}</div>}
                    </div>
                  </section>

                  {/* Order Info */}
                  <section>
                    <h3 className="text-sm font-medium text-txt-primary mb-2">Auftragsdaten</h3>
                    <div className="bg-app-bg rounded-lg p-3 space-y-2 text-sm">
                      <Row label="Betrag" value={order.totalAmount != null ? `${order.totalAmount.toFixed(2)} ${order.currency || "EUR"}` : "—"} />
                      <Row label="Erstellt" value={order.createdAt ? new Date(order.createdAt).toLocaleString("de-DE") : "—"} />
                      <Row label="Zahlung" value={order.paymentStatus || "—"} />
                      <Row label="Versand" value={order.shippingService || "—"} />
                      {order.trackingNumber && <Row label="Tracking" value={order.trackingNumber} />}
                      {order.buyerNote && <Row label="Kundennotiz" value={order.buyerNote} />}
                    </div>
                  </section>

                  {/* Timestamps */}
                  <section>
                    <h3 className="text-sm font-medium text-txt-primary mb-2">Zeitstempel</h3>
                    <div className="bg-app-bg rounded-lg p-3 space-y-2 text-sm">
                      {order.pickedAt && <Row label="Kommissioniert" value={new Date(order.pickedAt).toLocaleString("de-DE")} />}
                      {order.packedAt && <Row label="Verpackt" value={new Date(order.packedAt).toLocaleString("de-DE")} />}
                      {order.shippedAt && <Row label="Versendet" value={new Date(order.shippedAt).toLocaleString("de-DE")} />}
                      {order.deliveredAt && <Row label="Zugestellt" value={new Date(order.deliveredAt).toLocaleString("de-DE")} />}
                    </div>
                  </section>

                  {/* Actions */}
                  <section>
                    <h3 className="text-sm font-medium text-txt-primary mb-2">Aktionen</h3>
                    <div className="flex flex-wrap gap-2">
                      {(omsStatus === "packed" || omsStatus === "picked") && !order.trackingNumber && (
                        <ActionButton
                          label="Versandlabel erstellen"
                          icon="📦"
                          onClick={async () => {
                            await shipOrder(orderId);
                            await loadData();
                            onStatusChange?.();
                          }}
                        />
                      )}
                      {!order.invoiceNumber && (
                        <ActionButton
                          label="Rechnung erstellen"
                          icon="📄"
                          onClick={async () => {
                            await generateInvoice(orderId);
                            await loadData();
                          }}
                        />
                      )}
                      {!order.deliveryNoteNumber && (
                        <ActionButton
                          label="Lieferschein erstellen"
                          icon="📋"
                          onClick={async () => {
                            await generateDeliveryNote(orderId);
                            await loadData();
                          }}
                        />
                      )}
                      {order.invoiceNumber && (
                        <span className="text-xs text-txt-muted self-center">Rechnung: {order.invoiceNumber}</span>
                      )}
                      {order.deliveryNoteNumber && (
                        <span className="text-xs text-txt-muted self-center">Lieferschein: {order.deliveryNoteNumber}</span>
                      )}
                    </div>
                  </section>
                </>
              )}

              {activeTab === "items" && (
                <div className="space-y-3">
                  {order.items?.map((item, idx) => (
                    <div key={item.id || idx} className="bg-app-bg rounded-lg p-3 flex items-start gap-3">
                      <div className="w-8 h-8 rounded-md bg-app-elevated flex items-center justify-center text-xs text-txt-muted font-bold shrink-0">
                        {item.quantity}x
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-txt-primary truncate">{item.name}</p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-txt-muted">
                          {item.sku && <span>SKU: {item.sku}</span>}
                          {item.ean && <span>EAN: {item.ean}</span>}
                        </div>
                        {item.pickHint?.binCode && (
                          <div className="mt-1 text-xs text-accent">
                            Lagerplatz: {item.pickHint.binCode}
                            {item.pickHint.quantityAvailable != null && ` (${item.pickHint.quantityAvailable} verfügbar)`}
                          </div>
                        )}
                      </div>
                      <div className="text-sm font-semibold text-txt-primary whitespace-nowrap">
                        {item.priceBrutto != null ? `${(item.priceBrutto * item.quantity).toFixed(2)} €` : "—"}
                      </div>
                    </div>
                  )) || (
                    <div className="text-center text-txt-muted text-sm py-8">Keine Positionen</div>
                  )}

                  {/* Total */}
                  <div className="flex items-center justify-between pt-2 border-t border-app-border">
                    <span className="text-sm font-medium text-txt-primary">Gesamt</span>
                    <span className="text-lg font-bold text-txt-primary">
                      {order.totalAmount != null ? `${order.totalAmount.toFixed(2)} €` : "—"}
                    </span>
                  </div>
                </div>
              )}

              {activeTab === "timeline" && (
                <div className="space-y-0">
                  {timeline.length === 0 ? (
                    <div className="text-center text-txt-muted text-sm py-8">Noch keine Einträge</div>
                  ) : (
                    timeline.map((event, idx) => {
                      const toColor = STATUS_COLORS[event.toStatus] || STATUS_COLORS.pending;
                      return (
                        <div key={event.id} className="flex gap-3">
                          {/* Timeline Line */}
                          <div className="flex flex-col items-center">
                            <div className={`w-2.5 h-2.5 rounded-full mt-1.5 ${toColor.dot}`} />
                            {idx < timeline.length - 1 && <div className="w-px flex-1 bg-app-border" />}
                          </div>
                          {/* Event Content */}
                          <div className="pb-4 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-txt-primary">
                                {event.fromStatusLabel} → {event.toStatusLabel}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {event.actor?.email && (
                                <span className="text-xs text-txt-muted">{event.actor.email}</span>
                              )}
                              {event.timestamp && (
                                <span className="text-xs text-txt-muted">
                                  {new Date(event.timestamp).toLocaleString("de-DE")}
                                </span>
                              )}
                            </div>
                            {event.note && (
                              <p className="text-xs text-txt-secondary mt-1">{event.note}</p>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/* Helper: Action Button */
const ActionButton: React.FC<{ label: string; icon: string; onClick: () => Promise<void> }> = ({ label, icon, onClick }) => {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const handleClick = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onClick();
    } catch (e: any) {
      setErr(e.message || "Fehler");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col">
      <button
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-app-elevated rounded-lg text-xs font-medium text-txt-primary hover:bg-app-border transition-colors disabled:opacity-50"
      >
        <span>{icon}</span>
        {busy ? "..." : label}
      </button>
      {err && <span className="text-[10px] text-danger mt-0.5">{err}</span>}
    </div>
  );
};

/* Helper: Key-Value Row */
const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-start justify-between gap-4">
    <span className="text-txt-muted shrink-0">{label}</span>
    <span className="text-txt-primary text-right">{value}</span>
  </div>
);

export default OrderDetail;
