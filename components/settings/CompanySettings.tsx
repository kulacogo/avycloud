import React, { useState, useRef, useEffect, useCallback } from "react";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Button } from "../ui/Button";
import { fetchCompanySettings, saveCompanySettings } from "../../api/client";

const SaveIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

const UploadIcon: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const rechtsformOptions = [
  { value: "gmbh", label: "GmbH" },
  { value: "ug", label: "UG (haftungsbeschränkt)" },
  { value: "gbr", label: "GbR" },
  { value: "einzelunternehmen", label: "Einzelunternehmen" },
  { value: "ag", label: "AG" },
  { value: "kg", label: "KG" },
  { value: "ohg", label: "OHG" },
];

const landOptions = [
  { value: "de", label: "Deutschland" },
  { value: "at", label: "Österreich" },
  { value: "ch", label: "Schweiz" },
];

export const CompanySettings: React.FC = () => {
  const [firmenname, setFirmenname] = useState("");
  const [rechtsform, setRechtsform] = useState("");
  const [ustIdNr, setUstIdNr] = useState("");
  const [steuernummer, setSteuernummer] = useState("");
  const [strasse, setStrasse] = useState("");
  const [plz, setPlz] = useState("");
  const [ort, setOrt] = useState("");
  const [land, setLand] = useState("de");
  const [email, setEmail] = useState("");
  const [telefon, setTelefon] = useState("");
  const [website, setWebsite] = useState("");
  const [iban, setIban] = useState("");
  const [bic, setBic] = useState("");
  const [bank, setBank] = useState("");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoUrl, setLogoUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCompanySettings();
      if (data.firmenname) setFirmenname(data.firmenname);
      if (data.rechtsform) setRechtsform(data.rechtsform);
      if (data.ustIdNr) setUstIdNr(data.ustIdNr);
      if (data.steuernummer) setSteuernummer(data.steuernummer);
      if (data.strasse) setStrasse(data.strasse);
      if (data.plz) setPlz(data.plz);
      if (data.ort) setOrt(data.ort);
      if (data.land) setLand(data.land);
      if (data.email) setEmail(data.email);
      if (data.telefon) setTelefon(data.telefon);
      if (data.website) setWebsite(data.website);
      if (data.iban) setIban(data.iban);
      if (data.bic) setBic(data.bic);
      if (data.bank) setBank(data.bank);
      if (data.logoUrl) setLogoUrl(data.logoUrl);
    } catch (err: any) {
      setError(err.message || "Fehler beim Laden der Firmendaten");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("Logo konnte nicht gelesen werden"));
      reader.readAsDataURL(file);
    });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      // Upload the picked logo (if any) as a base64 data URL — the backend
      // stores it in GCS (tenant-scoped) and returns the public logoUrl.
      const logoBase64 = logoFile ? await readFileAsDataUrl(logoFile) : undefined;
      const saved = await saveCompanySettings({
        firmenname, rechtsform, ustIdNr, steuernummer,
        strasse, plz, ort, land,
        email, telefon, website,
        iban, bic, bank,
        logoUrl,
        ...(logoBase64 ? { logoBase64 } : {}),
      });
      if (saved.logoUrl) setLogoUrl(saved.logoUrl);
      setLogoFile(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || "Fehler beim Speichern");
    } finally {
      setSaving(false);
    }
  };

  const acceptLogo = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Bitte eine Bilddatei wählen (PNG, JPG oder SVG)");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Logo ist größer als 2 MB");
      return;
    }
    setError(null);
    setLogoFile(file);
  };

  const handleLogoDrop = (e: React.DragEvent) => {
    e.preventDefault();
    acceptLogo(e.dataTransfer.files?.[0]);
  };

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptLogo(e.target.files?.[0]);
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-app-surface border border-app-border rounded-xl p-6 h-32" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Error Banner */}
      {error && (
        <div className="bg-danger-dim border border-app-border rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="text-sm text-danger flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-txt-muted hover:text-txt-primary text-sm">
            Schließen
          </button>
        </div>
      )}

      {/* Success Banner */}
      {saveSuccess && (
        <div className="bg-success-dim border border-app-border rounded-xl px-4 py-3 text-sm text-success font-medium">
          Firmendaten erfolgreich gespeichert.
        </div>
      )}

      {/* Firmendaten */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Firmendaten</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="Firmenname" value={firmenname} onChange={(e) => setFirmenname(e.target.value)} />
          <Select label="Rechtsform" options={rechtsformOptions} value={rechtsform} onChange={(v) => setRechtsform(v as string)} />
          <Input label="USt-IdNr." value={ustIdNr} onChange={(e) => setUstIdNr(e.target.value)} placeholder="DE123456789" />
          <Input label="Steuernummer" value={steuernummer} onChange={(e) => setSteuernummer(e.target.value)} />
        </div>
      </Card>

      {/* Adresse */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Adresse</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Input label="Straße" value={strasse} onChange={(e) => setStrasse(e.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-4 sm:col-span-2">
            <Input label="PLZ" value={plz} onChange={(e) => setPlz(e.target.value)} />
            <div className="col-span-2">
              <Input label="Ort" value={ort} onChange={(e) => setOrt(e.target.value)} />
            </div>
          </div>
          <Select label="Land" options={landOptions} value={land} onChange={(v) => setLand(v as string)} />
        </div>
      </Card>

      {/* Kontakt */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Kontakt</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input label="E-Mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Telefon" type="tel" value={telefon} onChange={(e) => setTelefon(e.target.value)} />
          <div className="sm:col-span-2">
            <Input label="Website" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
        </div>
      </Card>

      {/* Bankverbindung */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Bankverbindung</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Input label="IBAN" value={iban} onChange={(e) => setIban(e.target.value)} />
          </div>
          <Input label="BIC" value={bic} onChange={(e) => setBic(e.target.value)} />
          <Input label="Bank" value={bank} onChange={(e) => setBank(e.target.value)} />
        </div>
      </Card>

      {/* Logo */}
      <Card>
        <h3 className="text-sm font-semibold text-txt-primary mb-4">Logo</h3>
        <div
          className="border-2 border-dashed border-app-border rounded-xl p-8 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-accent/40 transition-colors"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleLogoDrop}
        >
          {logoUrl && !logoFile ? (
            <img src={logoUrl} alt="Firmenlogo" className="max-h-20 object-contain" />
          ) : (
            <UploadIcon />
          )}
          <p className="text-sm text-txt-secondary">
            {logoFile ? logoFile.name : logoUrl ? "Logo ersetzen" : "Logo hochladen"}
          </p>
          <p className="text-xs text-txt-muted">PNG, JPG oder SVG, max. 2 MB</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleLogoChange}
          />
        </div>
      </Card>

      {/* Save */}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="lg"
          loading={saving}
          iconLeft={<SaveIcon />}
          onClick={handleSave}
          className="w-full sm:w-auto"
        >
          Änderungen speichern
        </Button>
      </div>
    </div>
  );
};

export default CompanySettings;
