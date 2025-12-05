import React, { useState } from 'react';
import { ProductEnrichmentRecord } from '../types';
import { useSerpapiFreePipeline } from '../hooks/useSerpapiFreePipeline';
import { buildImageProxyUrl } from '../api/client';

const FieldRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col">
    <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
    <span className="text-sm text-slate-100">{value}</span>
  </div>
);

const renderRecord = (record: ProductEnrichmentRecord) => {
  const entries: Array<[string, string]> = [
    ['Input Mode', record.input_mode],
    ['Brand', record.brand],
    ['Model', record.model],
    ['SKU', record.sku],
    ['GTIN', record.gtin],
    ['EAN', record.ean],
    ['UPC', record.upc],
    ['Color', record.color],
    ['Size', record.size],
    ['Material', record.material],
    ['Condition', record.condition],
    ['Internal Category', record.internalCategory],
    ['eBay Category', `${record.ebayCategoryId} (${record.ebayCategoryPath})`],
    ['Kaufland Category', `${record.kauflandCategoryId} (${record.kauflandCategoryPath})`],
    ['eBay Title', record.title_ebay],
    ['Kaufland Title', record.title_kaufland],
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {entries.map(([label, value]) => (
        <FieldRow key={label} label={label} value={value} />
      ))}
    </div>
  );
};

const SerpapiFreeIdentifyView: React.FC = () => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [barcodes, setBarcodes] = useState('');
  const [locale, setLocale] = useState<'de-DE' | 'en-US'>('de-DE');
  const { isLoading, error, record, run, reset } = useSerpapiFreePipeline();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files) {
      setSelectedFiles([]);
      return;
    }
    setSelectedFiles(Array.from(files));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(selectedFiles, barcodes, locale);
  };

  const handleReset = () => {
    setSelectedFiles([]);
    setBarcodes('');
    reset();
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="bg-slate-900/70 border border-white/5 rounded-3xl p-4 sm:p-6 shadow-xl shadow-black/40">
        <h1 className="text-xl font-semibold text-white mb-1">SerpAPI-freie Identifikation</h1>
        <p className="text-sm text-slate-400 mb-4">
          Lade Produktfotos oder Labels hoch und erhalte sofort einen Product Datasheet-Entwurf ohne SerpAPI.
        </p>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="text-xs uppercase tracking-wide text-slate-400 block mb-1">
              Bilder (Produkt oder Label)
            </label>
            <input
              type="file"
              multiple
              accept="image/*"
              onChange={handleFileChange}
              className="block w-full text-sm text-slate-200 bg-slate-800 rounded-xl border border-slate-700 p-2"
            />
            {selectedFiles.length > 0 && (
              <p className="text-xs text-slate-500 mt-2">{selectedFiles.length} Datei(en) ausgewählt</p>
            )}
          </div>

          <div>
            <label className="text-xs uppercase tracking-wide text-slate-400 block mb-1">
              Barcodes (optional)
            </label>
            <textarea
              value={barcodes}
              onChange={(e) => setBarcodes(e.target.value)}
              rows={3}
              className="w-full bg-slate-800 border border-slate-700 rounded-2xl p-3 text-sm text-white placeholder:text-slate-500"
              placeholder="EANs, GTINs oder UPCs – getrennt durch Komma, Zeilenumbruch oder Semikolon"
            />
          </div>

          <div>
            <label className="text-xs uppercase tracking-wide text-slate-400 block mb-1">
              Sprache
            </label>
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as 'de-DE' | 'en-US')}
              className="bg-slate-800 border border-slate-700 rounded-2xl p-2 text-sm text-white"
            >
              <option value="de-DE">Deutsch (Deutschland)</option>
              <option value="en-US">Englisch (USA)</option>
            </select>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center gap-2 bg-sky-600 text-white rounded-2xl px-5 py-2 text-sm font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isLoading ? 'Enrichment läuft…' : 'Pipeline starten'}
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-2 bg-slate-800 text-slate-200 rounded-2xl px-4 py-2 text-sm"
            >
              Zurücksetzen
            </button>
          </div>

          {error && <p className="text-sm text-rose-400">{error}</p>}
        </form>
      </div>

      {record && (
        <div className="space-y-4">
          <div className="bg-slate-900/70 border border-white/5 rounded-3xl p-4 sm:p-6 shadow-xl shadow-black/40">
            <h2 className="text-lg font-semibold text-white mb-3">Ergebnis</h2>
            {renderRecord(record)}
          </div>
          {record.heroImageUrl && (
            <div className="bg-slate-900/70 border border-white/5 rounded-3xl p-4 sm:p-6 shadow-xl shadow-black/40">
              <h3 className="text-base font-semibold text-white mb-3">Hero Image</h3>
              <img
                src={buildImageProxyUrl(record.heroImageUrl)}
                alt="Hero"
                className="max-h-[360px] rounded-2xl object-contain border border-white/10"
              />
            </div>
          )}
          {record.galleryImageUrls.length > 1 && (
            <div className="bg-slate-900/70 border border-white/5 rounded-3xl p-4 sm:p-6 shadow-xl shadow-black/40">
              <h3 className="text-base font-semibold text-white mb-3">Gallery</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {record.galleryImageUrls.map((url) => (
                  <img
                    key={url}
                    src={buildImageProxyUrl(url)}
                    alt="Gallery"
                    className="rounded-xl object-cover border border-white/10 aspect-square"
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SerpapiFreeIdentifyView;

