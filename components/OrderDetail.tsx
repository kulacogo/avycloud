import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  fetchOrderDetail,
  transitionOrderStatus,
  shipOrder,
  generateInvoice,
  generateDeliveryNote,
  updateOrderCustomer,
  updateOrderWeight,
  cancelShippingLabel,
  fetchLabelPdfBlob,
  downloadInvoicePdfBlob,
  assignTracking,
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

/* ─── Tracking URL builder ─── */
const TRACKING_URLS: Record<string, string> = {
  dhl: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=",
  dhl_de: "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=",
  dhl_express: "https://www.dhl.com/de-de/home/tracking/tracking-express.html?submit=1&tracking-id=",
  dpd: "https://tracking.dpd.de/parcelstatus?query=",
  gls: "https://gls-group.eu/DE/de/paketverfolgung?match=",
  hermes: "https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#",
  ups: "https://www.ups.com/track?tracknum=",
};

function buildTrackingUrl(order: Order): string | null {
  if ((order as any).trackingUrl) return (order as any).trackingUrl;
  const carrier = ((order as any).shippingService || "dhl").toLowerCase();
  const base = TRACKING_URLS[carrier] || TRACKING_URLS.dhl;
  return order.trackingNumber ? `${base}${order.trackingNumber}` : null;
}

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
  const [allStatuses, setAllStatuses] = useState<Record<string, { label: string; color: string; sortOrder: number }>>({});
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "items" | "timeline">("details");
  const [editingAddress, setEditingAddress] = useState(false);
  const [addressForm, setAddressForm] = useState({ name: "", street: "", city: "", zip: "", country: "", phone: "", email: "" });
  const [savingAddress, setSavingAddress] = useState(false);
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightInput, setWeightInput] = useState("");
  const [savingWeight, setSavingWeight] = useState(false);
  const [selectedVatRate, setSelectedVatRate] = useState<number>(0.19);
  const [labelFormat, setLabelFormat] = useState<string>(() => localStorage.getItem("avycloud_label_format") || "a6");
  const [showManualTracking, setShowManualTracking] = useState(false);
  const [manualTrackingNumber, setManualTrackingNumber] = useState("");
  const [manualCarrier, setManualCarrier] = useState("");
  const [savingTracking, setSavingTracking] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchOrderDetail(orderId);
      setOrder(data.order);
      setTimeline(data.timeline || []);
      setNextStatuses(data.nextStatuses || []);
      setAllStatuses(data.allStatuses || {});
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

  const handleTransition = useCallback(async (toStatus: string, force = false) => {
    setTransitioning(true);
    setError(null);
    try {
      await transitionOrderStatus(orderId, toStatus, { force });
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
                {order?.marketplaceOrderId || order?.orderId || order?.number || order?.id || "..."}
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
            <div className="px-5 pt-4 pb-2 border-b border-app-border shrink-0">
              <p className="text-xs text-txt-muted mb-2">Nächster Schritt</p>
              <div className="flex flex-wrap gap-2">
                {/* Quick-action buttons for recommended next statuses */}
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
                {/* Dropdown for other valid transitions + force override */}
                {Object.keys(allStatuses).length > 0 && (() => {
                  const validSet = new Set(nextStatuses);
                  const otherValid = Object.entries(allStatuses)
                    .filter(([key]) => key !== omsStatus && !validSet.has(key))
                    .sort(([, a], [, b]) => a.sortOrder - b.sortOrder);
                  const forceTargets = otherValid.filter(([key]) => !validSet.has(key));
                  return (
                    <select
                      value=""
                      disabled={transitioning}
                      onChange={(e) => {
                        if (e.target.value) {
                          const isForce = !validSet.has(e.target.value);
                          handleTransition(e.target.value, isForce);
                        }
                      }}
                      className="h-7 px-2 rounded-lg text-xs bg-app-elevated border border-app-border text-txt-secondary hover:text-txt-primary cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="">Status setzen...</option>
                      {forceTargets.length > 0 && (
                        <optgroup label="Manuell erzwingen">
                          {forceTargets.map(([key, info]) => (
                            <option key={key} value={key}>
                              {info.label}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  );
                })()}
              </div>
            </div>

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
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-txt-primary">Kunde</h3>
                      {!editingAddress && (
                        <button
                          type="button"
                          className="text-xs text-accent hover:text-accent/80 transition-colors"
                          onClick={() => {
                            setAddressForm({
                              name: order.customer?.name || "",
                              street: order.customer?.street || "",
                              city: order.customer?.city || "",
                              zip: order.customer?.zip || "",
                              country: order.customer?.country || "",
                              phone: order.customer?.phone || "",
                              email: order.customer?.email || "",
                            });
                            setEditingAddress(true);
                          }}
                        >
                          Bearbeiten
                        </button>
                      )}
                    </div>
                    {editingAddress ? (
                      <div className="bg-app-bg rounded-lg p-3 space-y-2">
                        {[
                          { key: "name", label: "Name" },
                          { key: "street", label: "Straße" },
                          { key: "zip", label: "PLZ" },
                          { key: "city", label: "Stadt" },
                          { key: "country", label: "Land" },
                          { key: "phone", label: "Telefon" },
                          { key: "email", label: "E-Mail" },
                        ].map(({ key, label }) => (
                          <div key={key}>
                            <label className="block text-xs text-txt-muted mb-0.5">{label}</label>
                            <input
                              type="text"
                              value={(addressForm as any)[key]}
                              onChange={(e) => setAddressForm((prev) => ({ ...prev, [key]: e.target.value }))}
                              className="w-full h-8 px-2.5 text-sm rounded-md bg-app-surface border border-app-border text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                            />
                          </div>
                        ))}
                        {/* Address completeness warning */}
                        {(!addressForm.street || !addressForm.city || !addressForm.zip) && (
                          <div className="text-xs text-warning bg-warning/10 px-2.5 py-1.5 rounded">
                            Adresse unvollständig — Versandlabel kann nicht erstellt werden.
                          </div>
                        )}
                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            className="flex-1 h-8 text-xs rounded-md bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                            disabled={savingAddress}
                            onClick={async () => {
                              setSavingAddress(true);
                              try {
                                await updateOrderCustomer(orderId, addressForm);
                                setEditingAddress(false);
                                loadData();
                              } catch (err: any) {
                                setError(err.message);
                              } finally {
                                setSavingAddress(false);
                              }
                            }}
                          >
                            {savingAddress ? "Speichern..." : "Speichern"}
                          </button>
                          <button
                            type="button"
                            className="h-8 px-3 text-xs rounded-md bg-app-elevated text-txt-secondary hover:text-txt-primary transition-colors"
                            onClick={() => setEditingAddress(false)}
                            disabled={savingAddress}
                          >
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-app-bg rounded-lg p-3 space-y-1.5 text-sm">
                        <div className="font-medium text-txt-primary">{order.customer?.name || "Unbekannt"}</div>
                        {order.customer?.street && <div className="text-txt-secondary">{order.customer.street}</div>}
                        {(order.customer?.zip || order.customer?.city) && (
                          <div className="text-txt-secondary">{[order.customer.zip, order.customer.city].filter(Boolean).join(" ")}</div>
                        )}
                        {order.customer?.country && <div className="text-txt-muted text-xs">{order.customer.country}</div>}
                        {order.customer?.email && <div className="text-txt-muted text-xs">{order.customer.email}</div>}
                        {order.customer?.phone && <div className="text-txt-muted text-xs">{order.customer.phone}</div>}
                        {/* Address incomplete warning */}
                        {(!order.customer?.street || !order.customer?.city || !order.customer?.zip) && (
                          <div className="text-xs text-warning mt-1">
                            Adresse unvollständig
                          </div>
                        )}
                      </div>
                    )}
                  </section>

                  {/* Order Info */}
                  <section>
                    <h3 className="text-sm font-medium text-txt-primary mb-2">Auftragsdaten</h3>
                    <div className="bg-app-bg rounded-lg p-3 space-y-2 text-sm">
                      <Row label="Betrag" value={order.totalAmount != null ? `${order.totalAmount.toFixed(2)} ${order.currency || "EUR"}` : "—"} />
                      <Row label="Erstellt" value={order.createdAt ? new Date(order.createdAt).toLocaleString("de-DE") : "—"} />
                      <Row label="Zahlung" value={
                        order.paymentStatus === "NoPaymentFailure" ? "Bezahlt" :
                        order.paymentStatus === "PaymentComplete" ? "Bezahlt" :
                        order.paymentStatus || "—"
                      } />
                      <Row label="Versand" value={order.shippingService || "—"} />
                      {/* Editable Weight */}
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-txt-muted shrink-0">Gewicht</span>
                        {editingWeight ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={weightInput}
                              onChange={(e) => setWeightInput(e.target.value)}
                              className="w-20 h-6 px-1.5 text-sm text-right rounded bg-app-surface border border-app-border text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Escape") setEditingWeight(false);
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  const w = parseFloat(weightInput);
                                  if (!isNaN(w) && w >= 0) {
                                    setSavingWeight(true);
                                    updateOrderWeight(orderId, w)
                                      .then(() => { setEditingWeight(false); loadData(); })
                                      .catch((err: any) => setError(err.message))
                                      .finally(() => setSavingWeight(false));
                                  }
                                }
                              }}
                            />
                            <span className="text-xs text-txt-muted">kg</span>
                            <button
                              type="button"
                              disabled={savingWeight}
                              className="text-xs text-accent hover:text-accent/80"
                              onClick={() => {
                                const w = parseFloat(weightInput);
                                if (!isNaN(w) && w >= 0) {
                                  setSavingWeight(true);
                                  updateOrderWeight(orderId, w)
                                    .then(() => { setEditingWeight(false); loadData(); })
                                    .catch((err: any) => setError(err.message))
                                    .finally(() => setSavingWeight(false));
                                }
                              }}
                            >
                              {savingWeight ? "..." : "✓"}
                            </button>
                            <button type="button" className="text-xs text-txt-muted hover:text-txt-primary" onClick={() => setEditingWeight(false)}>✕</button>
                          </div>
                        ) : (
                          <span
                            className="text-txt-primary text-right cursor-pointer hover:text-accent transition-colors"
                            title="Klicken zum Bearbeiten"
                            onClick={() => {
                              setWeightInput(String(order.weight || ""));
                              setEditingWeight(true);
                            }}
                          >
                            {order.weight ? `${order.weight} kg` : <span className="text-warning">nicht angegeben ✎</span>}
                          </span>
                        )}
                      </div>
                      {order.trackingNumber && (
                        <Row label="Tracking" value={
                          (() => {
                            const url = buildTrackingUrl(order);
                            return url ? (
                              <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline font-mono text-xs">
                                {order.trackingNumber}
                              </a>
                            ) : order.trackingNumber;
                          })()
                        } />
                      )}
                      {order.buyerNote && <Row label="Kundennotiz" value={order.buyerNote} />}
                    </div>
                  </section>

                  {/* Timestamps — only show if status has actually reached that stage */}
                  <section>
                    <h3 className="text-sm font-medium text-txt-primary mb-2">Zeitstempel</h3>
                    <div className="bg-app-bg rounded-lg p-3 space-y-2 text-sm">
                      {order.pickedAt && ["picked", "packed", "shipped", "delivered", "completed"].includes(omsStatus) && (
                        <Row label="Kommissioniert" value={new Date(order.pickedAt).toLocaleString("de-DE")} />
                      )}
                      {order.packedAt && ["packed", "shipped", "delivered", "completed"].includes(omsStatus) && (
                        <Row label="Verpackt" value={new Date(order.packedAt).toLocaleString("de-DE")} />
                      )}
                      {order.shippedAt && ["shipped", "delivered", "completed"].includes(omsStatus) && (
                        <Row label="Versendet" value={new Date(order.shippedAt).toLocaleString("de-DE")} />
                      )}
                      {order.deliveredAt && ["delivered", "completed"].includes(omsStatus) && (
                        <Row label="Zugestellt" value={new Date(order.deliveredAt).toLocaleString("de-DE")} />
                      )}
                    </div>
                  </section>

                  {/* Actions */}
                  <section>
                    <h3 className="text-sm font-medium text-txt-primary mb-2">Aktionen</h3>
                    <div className="flex flex-wrap gap-2">
                      {(omsStatus === "packed" || omsStatus === "picked") && !order.trackingNumber && (
                        order.customer?.street && order.customer?.city && order.customer?.zip ? (
                          <>
                            <select
                              value={labelFormat}
                              onChange={(e) => {
                                setLabelFormat(e.target.value);
                                localStorage.setItem("avycloud_label_format", e.target.value);
                              }}
                              className="rounded-md border border-app-border bg-app-surface text-txt-primary text-xs px-2 py-1.5 self-center"
                              title="Label-Format"
                            >
                              <option value="a6">A6 / Thermal</option>
                              <option value="a4">A4</option>
                            </select>
                            <ActionButton
                              label="Versandlabel erstellen"
                              icon="📦"
                              onClick={async () => {
                                await shipOrder(orderId, {
                                  ...(order.weight ? { weight: order.weight } : {}),
                                  labelFormat,
                                });
                                await loadData();
                                onStatusChange?.();
                              }}
                            />
                          </>
                        ) : (
                          <div className="text-xs text-warning bg-warning/10 px-3 py-2 rounded-lg">
                            Versandlabel nicht möglich — Adresse unvollständig. Bitte oben bearbeiten.
                          </div>
                        )
                      )}
                      {/* Manual tracking input */}
                      {!order.trackingNumber && (
                        showManualTracking ? (
                          <div className="flex flex-wrap items-center gap-2 w-full">
                            <input
                              type="text"
                              placeholder="Tracking-Nummer"
                              value={manualTrackingNumber}
                              onChange={(e) => setManualTrackingNumber(e.target.value)}
                              className="rounded-md border border-app-border bg-app-surface text-txt-primary text-xs px-2 py-1.5 w-48"
                            />
                            <select
                              value={manualCarrier}
                              onChange={(e) => setManualCarrier(e.target.value)}
                              className="rounded-md border border-app-border bg-app-surface text-txt-primary text-xs px-2 py-1.5"
                            >
                              <option value="">Carrier</option>
                              <option value="dhl">DHL</option>
                              <option value="dpd">DPD</option>
                              <option value="gls">GLS</option>
                              <option value="hermes">Hermes</option>
                              <option value="ups">UPS</option>
                            </select>
                            <ActionButton
                              label="Speichern"
                              icon="✓"
                              disabled={!manualTrackingNumber.trim() || savingTracking}
                              onClick={async () => {
                                setSavingTracking(true);
                                try {
                                  await assignTracking(orderId, {
                                    trackingNumber: manualTrackingNumber.trim(),
                                    carrier: manualCarrier || undefined,
                                  });
                                  setShowManualTracking(false);
                                  setManualTrackingNumber("");
                                  setManualCarrier("");
                                  await loadData();
                                  onStatusChange?.();
                                } finally {
                                  setSavingTracking(false);
                                }
                              }}
                            />
                            <ActionButton
                              label="Abbrechen"
                              icon="✕"
                              onClick={() => { setShowManualTracking(false); setManualTrackingNumber(""); }}
                            />
                          </div>
                        ) : (
                          <ActionButton
                            label="Tracking manuell"
                            icon="✎"
                            onClick={() => setShowManualTracking(true)}
                          />
                        )
                      )}
                      {order.trackingNumber && (
                        <>
                          <select
                            value={labelFormat}
                            onChange={(e) => {
                              setLabelFormat(e.target.value);
                              localStorage.setItem("avycloud_label_format", e.target.value);
                            }}
                            className="rounded-md border border-app-border bg-app-surface text-txt-primary text-xs px-2 py-1.5 self-center"
                            title="Label-Format"
                          >
                            <option value="a6">A6 / Thermal</option>
                            <option value="a4">A4</option>
                          </select>
                          <ActionButton
                            label="Label drucken"
                            icon="🖨"
                            onClick={async () => {
                              const blob = await fetchLabelPdfBlob(orderId, { labelFormat });
                              const blobUrl = URL.createObjectURL(blob);
                              const printWindow = window.open(blobUrl, '_blank');
                              if (printWindow) {
                                printWindow.addEventListener('load', () => {
                                  printWindow.print();
                                });
                                setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
                              } else {
                                // Fallback: download if popup blocked
                                const a = document.createElement('a');
                                a.href = blobUrl;
                                a.download = `label-${orderId}.pdf`;
                                a.click();
                                setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
                              }
                            }}
                          />
                        </>
                      )}
                      {order.trackingNumber && (
                        <ActionButton
                          label="Label stornieren"
                          icon="✕"
                          onClick={async () => {
                            await cancelShippingLabel(orderId);
                            await loadData();
                            onStatusChange?.();
                          }}
                        />
                      )}
                      {!order.invoiceNumber && (
                        <>
                          <select
                            value={selectedVatRate}
                            onChange={(e) => setSelectedVatRate(parseFloat(e.target.value))}
                            className="rounded-md border border-app-border bg-app-surface text-txt-primary text-xs px-2 py-1.5 self-center"
                            title="MwSt.-Satz"
                          >
                            <option value={0.19}>19% MwSt.</option>
                            <option value={0.07}>7% MwSt.</option>
                            <option value={0}>0% Steuerfrei</option>
                          </select>
                          <ActionButton
                            label="Rechnung erstellen"
                            icon="📄"
                            onClick={async () => {
                              await generateInvoice(orderId, { vatRate: selectedVatRate });
                              await loadData();
                            }}
                          />
                        </>
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
                        <span className="text-xs text-txt-muted self-center inline-flex items-center gap-1.5">
                          Rechnung: {order.invoiceNumber}
                          <span className="rounded bg-app-elevated px-1.5 py-0.5 text-[10px] font-medium text-txt-secondary">
                            {Math.round((order.vatRate ?? 0.19) * 100)}% MwSt.
                          </span>
                          {order.invoiceId && (
                            <button
                              type="button"
                              title="Rechnungs-PDF herunterladen"
                              className="inline-flex items-center gap-1 rounded bg-accent-dim px-1.5 py-0.5 text-[11px] font-semibold text-accent hover:opacity-80 transition"
                              onClick={async () => {
                                try {
                                  const blob = await downloadInvoicePdfBlob(order.invoiceId!);
                                  const blobUrl = URL.createObjectURL(blob);
                                  const printWindow = window.open(blobUrl, "_blank");
                                  if (!printWindow) {
                                    const a = document.createElement("a");
                                    a.href = blobUrl;
                                    a.download = `Rechnung-${order.invoiceNumber}.pdf`;
                                    a.click();
                                    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
                                  } else {
                                    setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
                                  }
                                } catch (err: any) {
                                  console.error("[OrderDetail] Invoice PDF download failed:", err);
                                }
                              }}
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              PDF
                            </button>
                          )}
                        </span>
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
