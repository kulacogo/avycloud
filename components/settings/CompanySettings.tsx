import React, { useState, useRef } from "react";
import { Card } from "../ui/Card";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Button } from "../ui/Button";

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
  { value: "ug", label: "UG (haftungsbeschrankt)" },
  { value: "gbr", label: "GbR" },
  { value: "einzelunternehmen", label: "Einzelunternehmen" },
  { value: "ag", label: "AG" },
  { value: "kg", label: "KG" },
  { value: "ohg", label: "OHG" },
];

const landOptions = [
  { value: "de", label: "Deutschland" },
  { value: "at", label: "Osterreich" },
  { value: "ch", label: "Schweiz" },
];

export const CompanySettings: React.FC = () => {
  const [firmenname, setFirmenname] = useState("Muster GmbH");
  const [rechtsform, setRechtsform] = useState("gmbh");
  const [ustIdNr, setUstIdNr] = useState("DE298745123");
  const [steuernummer, setSteuernummer] = useState("123/456/78901");
  const [strasse, setStrasse] = useState("Musterstrasse 42");
  const [plz, setPlz] = useState("10115");
  const [ort, setOrt] = useState("Berlin");
  const [land, setLand] = useState("de");
  const [email, setEmail] = useState("info@muster-gmbh.de");
  const [telefon, setTelefon] = useState("+49 30 12345678");
  const [website, setWebsite] = useState("https://www.muster-gmbh.de");
  const [iban, setIban] = useState("DE89 3704 0044 0532 0130 00");
  const [bic, setBic] = useState("COBADEFFXXX");
  const [bank, setBank] = useState("Commerzbank AG");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSave = async () => {
    setSaving(true);
    // TODO: API call to save company settings (POST /api/settings/company)
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
  };

  const handleLogoDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) setLogoFile(file);
  };

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setLogoFile(file);
  };

  return (
    <div className="space-y-6">
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
            <Input label="Strasse" value={strasse} onChange={(e) => setStrasse(e.target.value)} />
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
          <UploadIcon />
          <p className="text-sm text-txt-secondary">
            {logoFile ? logoFile.name : "Logo hochladen"}
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
          Anderungen speichern
        </Button>
      </div>
    </div>
  );
};

export default CompanySettings;
