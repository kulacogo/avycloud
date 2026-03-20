import React, { useState, useCallback, useRef, useMemo } from "react";
import { Modal, ModalHeader, ModalBody } from "./ui/Modal";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Badge } from "./ui/Badge";
import { Select, SelectOption } from "./ui/Select";
import { useToast } from "../context/ToastContext";
import {
  previewProductsImport,
  executeProductsImport,
  ColumnMapping,
} from "../api/client";

interface ImportModalProps {
  open: boolean;
  onClose: () => void;
  onComplete?: () => void;
}

type Step = "upload" | "mapping" | "preview" | "result";

const IMPORT_FIELDS: SelectOption[] = [
  { value: "", label: "— Ignorieren —" },
  { value: "name", label: "Name" },
  { value: "brand", label: "Marke" },
  { value: "category", label: "Kategorie" },
  { value: "sku", label: "SKU" },
  { value: "ean", label: "EAN / Barcode" },
  { value: "condition", label: "Zustand" },
  { value: "sellPrice", label: "Verkaufspreis" },
  { value: "buyPrice", label: "Einkaufspreis" },
  { value: "description", label: "Beschreibung" },
  { value: "quantity", label: "Bestand" },
  { value: "binCode", label: "Lagerplatz" },
];

const ImportModal: React.FC<ImportModalProps> = ({ open, onClose, onComplete }) => {
  const [step, setStep] = useState<Step>("upload");
  const [csvText, setCsvText] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [delimiter, setDelimiter] = useState(";");
  const [previewData, setPreviewData] = useState<any>(null);
  const [resultData, setResultData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { addToast } = useToast();

  const reset = useCallback(() => {
    setStep("upload");
    setCsvText("");
    setCsvHeaders([]);
    setMapping({});
    setPreviewData(null);
    setResultData(null);
    setLoading(false);
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  // Step 1: File upload
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvText(text);

      // Auto-detect delimiter
      const firstLine = text.split("\n")[0] || "";
      const semiCount = (firstLine.match(/;/g) || []).length;
      const commaCount = (firstLine.match(/,/g) || []).length;
      const det = semiCount >= commaCount ? ";" : ",";
      setDelimiter(det);

      // Parse headers
      const headers = firstLine.split(det).map((h) => h.replace(/^"(.*)"$/, "$1").trim());
      setCsvHeaders(headers);

      // Auto-map by fuzzy label match
      const autoMap: Record<string, string> = {};
      headers.forEach((h) => {
        const lower = h.toLowerCase();
        if (lower.includes("name") || lower.includes("titel") || lower.includes("title")) autoMap[h] = "name";
        else if (lower.includes("marke") || lower.includes("brand")) autoMap[h] = "brand";
        else if (lower.includes("kategori") || lower.includes("category")) autoMap[h] = "category";
        else if (lower === "sku" || lower.includes("artikelnr")) autoMap[h] = "sku";
        else if (lower.includes("ean") || lower.includes("barcode") || lower.includes("gtin")) autoMap[h] = "ean";
        else if (lower.includes("zustand") || lower.includes("condition")) autoMap[h] = "condition";
        else if (lower.includes("verkauf") || lower.includes("vk") || lower.includes("sell")) autoMap[h] = "sellPrice";
        else if (lower.includes("einkauf") || lower.includes("ek") || lower.includes("buy") || lower.includes("cost")) autoMap[h] = "buyPrice";
        else if (lower.includes("beschreib") || lower.includes("descri")) autoMap[h] = "description";
        else if (lower.includes("menge") || lower.includes("bestand") || lower.includes("qty") || lower.includes("quantity")) autoMap[h] = "quantity";
        else if (lower.includes("lager") || lower.includes("bin")) autoMap[h] = "binCode";
      });
      setMapping(autoMap);
      setStep("mapping");
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  }, []);

  // Step 2: Mapping
  const columnMappings: ColumnMapping[] = useMemo(() => {
    return Object.entries(mapping)
      .filter(([, field]) => field)
      .map(([csvColumn, field]) => ({ csvColumn, field }));
  }, [mapping]);

  const hasNameMapping = columnMappings.some((m) => m.field === "name");

  // Step 3: Preview
  const handlePreview = useCallback(async () => {
    setLoading(true);
    try {
      const result = await previewProductsImport(csvText, columnMappings, delimiter);
      if (!result.ok) {
        addToast("error", `Vorschau fehlgeschlagen: ${result.error?.message || "Unbekannter Fehler"}`);
        return;
      }
      setPreviewData(result.data);
      setStep("preview");
    } catch (err: any) {
      addToast("error", `Fehler: ${err?.message || "Unbekannter Fehler"}`);
    } finally {
      setLoading(false);
    }
  }, [csvText, columnMappings, delimiter, addToast]);

  // Step 4: Execute
  const handleExecute = useCallback(async () => {
    setLoading(true);
    try {
      const result = await executeProductsImport(csvText, columnMappings, delimiter);
      if (!result.ok) {
        addToast("error", `Import fehlgeschlagen: ${result.error?.message || "Unbekannter Fehler"}`);
        return;
      }
      setResultData(result.data);
      setStep("result");
      const importMsg = `${result.data?.imported || 0} Produkte importiert` + (result.data?.failed ? `, ${result.data.failed} fehlgeschlagen` : "");
      addToast("success", importMsg);
      onComplete?.();
    } catch (err: any) {
      addToast("error", `Fehler: ${err?.message || "Unbekannter Fehler"}`);
    } finally {
      setLoading(false);
    }
  }, [csvText, columnMappings, delimiter, addToast, onComplete]);

  const lineCount = csvText ? csvText.split("\n").filter((l) => l.trim()).length - 1 : 0;

  return (
    <Modal open={open} onClose={handleClose} size="lg">
      <ModalHeader onClose={handleClose}>Produkte importieren (CSV)</ModalHeader>
      <ModalBody>
      <div className="space-y-4">
        {/* Step indicator */}
        <div className="flex items-center gap-2 text-xs text-txt-muted">
          <Badge variant={step === "upload" ? "accent" : "neutral"} size="sm">1. Datei</Badge>
          <span>→</span>
          <Badge variant={step === "mapping" ? "accent" : "neutral"} size="sm">2. Spalten</Badge>
          <span>→</span>
          <Badge variant={step === "preview" ? "accent" : "neutral"} size="sm">3. Vorschau</Badge>
          <span>→</span>
          <Badge variant={step === "result" ? "accent" : "neutral"} size="sm">4. Ergebnis</Badge>
        </div>

        {/* Step 1: Upload */}
        {step === "upload" && (
          <div className="space-y-4">
            <Card
              padding="lg"
              className="border-dashed border-2 cursor-pointer hover:border-accent/50 transition-colors text-center"
              onClick={() => fileRef.current?.click()}
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto text-txt-muted mb-3">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p className="text-txt-primary font-medium">CSV-Datei auswählen</p>
              <p className="text-xs text-txt-muted mt-1">CSV oder TXT mit Semikolon- oder Komma-Trennung</p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,.tsv"
                className="hidden"
                onChange={handleFileSelect}
              />
            </Card>
          </div>
        )}

        {/* Step 2: Mapping */}
        {step === "mapping" && (
          <div className="space-y-4">
            <p className="text-sm text-txt-secondary">
              {lineCount} Zeilen erkannt · Trennzeichen: <code className="text-accent">{delimiter === ";" ? "Semikolon" : "Komma"}</code>
            </p>
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {csvHeaders.map((header) => (
                <div key={header} className="flex items-center gap-3">
                  <span className="text-sm text-txt-primary w-40 truncate font-mono" title={header}>
                    {header}
                  </span>
                  <span className="text-txt-muted">→</span>
                  <div className="flex-1">
                    <select
                      value={mapping[header] || ""}
                      onChange={(e) => setMapping((prev) => ({ ...prev, [header]: e.target.value }))}
                      className="w-full h-9 px-3 text-sm rounded-lg bg-app-elevated border border-app-border text-txt-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      {IMPORT_FIELDS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
            {!hasNameMapping && (
              <p className="text-xs text-danger">Bitte weise mindestens die Spalte "Name" zu.</p>
            )}
            <div className="flex justify-between pt-2">
              <Button variant="secondary" onClick={() => setStep("upload")}>Zurück</Button>
              <Button onClick={handlePreview} disabled={!hasNameMapping} loading={loading}>
                Vorschau anzeigen
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === "preview" && previewData && (
          <div className="space-y-4">
            <div className="flex gap-3">
              <Badge variant="success">{previewData.validCount} gültig</Badge>
              {previewData.errorCount > 0 && (
                <Badge variant="danger">{previewData.errorCount} fehlerhaft</Badge>
              )}
              <Badge variant="neutral">{previewData.totalRows} Zeilen gesamt</Badge>
            </div>

            {previewData.preview?.length > 0 && (
              <Card padding="none">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-app-border bg-app-bg">
                        <th className="px-3 py-2 text-left text-txt-muted">Name</th>
                        <th className="px-3 py-2 text-left text-txt-muted">Marke</th>
                        <th className="px-3 py-2 text-left text-txt-muted">SKU</th>
                        <th className="px-3 py-2 text-left text-txt-muted">EAN</th>
                        <th className="px-3 py-2 text-right text-txt-muted">Preis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewData.preview.map((row: any, i: number) => (
                        <tr key={i} className="border-b border-app-border/50">
                          <td className="px-3 py-1.5 text-txt-primary truncate max-w-[200px]">{row.name || "—"}</td>
                          <td className="px-3 py-1.5 text-txt-secondary">{row.brand || "—"}</td>
                          <td className="px-3 py-1.5 text-txt-secondary font-mono">{row.sku || "—"}</td>
                          <td className="px-3 py-1.5 text-txt-secondary font-mono">{row.ean || "—"}</td>
                          <td className="px-3 py-1.5 text-right text-txt-primary">
                            {row.sellPrice ? `${Number(row.sellPrice).toFixed(2)} €` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {previewData.errors?.length > 0 && (
              <div className="text-xs text-danger space-y-0.5">
                {previewData.errors.slice(0, 5).map((e: any, i: number) => (
                  <div key={i}>Zeile {e.row}: {e.message}</div>
                ))}
              </div>
            )}

            <div className="flex justify-between pt-2">
              <Button variant="secondary" onClick={() => setStep("mapping")}>Zurück</Button>
              <Button onClick={handleExecute} loading={loading} disabled={previewData.validCount === 0}>
                {previewData.validCount} Produkte importieren
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Result */}
        {step === "result" && resultData && (
          <div className="space-y-4 text-center">
            <div className="w-16 h-16 mx-auto rounded-full bg-success/10 flex items-center justify-center">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-success">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            </div>
            <div>
              <p className="text-lg font-semibold text-txt-primary">Import abgeschlossen</p>
              <p className="text-sm text-txt-muted mt-1">
                {resultData.imported} importiert
                {resultData.failed > 0 ? ` · ${resultData.failed} fehlgeschlagen` : ""}
              </p>
            </div>
            {resultData.importErrors?.length > 0 && (
              <div className="text-xs text-danger text-left space-y-0.5">
                {resultData.importErrors.slice(0, 5).map((e: any, i: number) => (
                  <div key={i}>Zeile {e.row}: {e.message}</div>
                ))}
              </div>
            )}
            <Button onClick={handleClose}>Schließen</Button>
          </div>
        )}
      </div>
      </ModalBody>
    </Modal>
  );
};

export default ImportModal;
