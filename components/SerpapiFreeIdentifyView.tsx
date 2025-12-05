import React, { useState } from 'react';
import { ProductEnrichmentRecord, SerpapiFreeMeta } from '../types';
import { useSerpapiFreePipeline } from '../hooks/useSerpapiFreePipeline';
import { buildImageProxyUrl } from '../api/client';

const FieldRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col">
    <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
    <span className="text-sm text-slate-100">{value}</span>
  </div>
);

const TextBlock: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col">
    <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
    <p className="text-sm text-slate-100 whitespace-pre-line">{value}</p>
  </div>
);

const AttributeList: React.FC<{ title: string; items: { key: string; value: string }[] }> = ({
  title,
  items,
}) => {
  if (!items?.length) return null;
  return (
    <div className="bg-slate-900/70 border border-white/5 rounded-3xl p-4 sm:p-6 shadow-xl shadow-black/40">
      <h3 className="text-base font-semibold text-white mb-3">{title}</h3>
      <dl className="divide-y divide-white/5">
        {items.map((item) => (
          <div key={`${title}-${item.key}-${item.value}`} className="flex justify-between py-2">
            <dt className="text-sm text-slate-400 pr-4">{item.key}</dt>
            <dd className="text-sm text-slate-100 text-right">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
};

const MetaPanel: React.FC<{ meta: SerpapiFreeMeta }> = ({ meta }) => {
  if (!meta) return null;
  const ocrLines = meta.ocr?.textSnippets?.slice(0, 25) || [];
  return (
    <div className="bg-slate-900/70 border border-white/5 rounded-3xl p-4 sm:p-6 shadow-xl shadow-black/40">
      <h3 className="text-base font-semibold text-white mb-3">Analyse & Quellen</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <FieldRow label="Sprache" value={meta.locale} />
        <FieldRow label="LLM" value={meta.llm?.model || 'unbekannt'} />
        <FieldRow
          label="LLM aktiv"
          value={meta.llm?.applied ? 'ja' : 'nein'}
        />
        <FieldRow
          label="Barcodes"
          value={meta.barcodes && meta.barcodes.length ? meta.barcodes.join(', ') : 'keine'}
        />
      </div>
      {!!ocrLines.length && (
        <div>
          <span className="text-xs uppercase tracking-wide text-slate-500 block mb-2">OCR Vorschau</span>
          <pre className="bg-slate-950/60 border border-white/5 rounded-2xl p-3 text-xs text-slate-200 max-h-64 overflow-y-auto whitespace-pre-wrap">
            {ocrLines.join('\n')}
          </pre>
        </div>
      )}
    </div>
  );
};

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
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {entries.map(([label, value]) => (
          <FieldRow key={label} label={label} value={value} />
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <TextBlock label="eBay Beschreibung" value={record.description_ebay} />
        <TextBlock label="Kaufland Beschreibung" value={record.description_kaufland} />
      </div>
    </>
  );
};

const SerpapiFreeIdentifyView: React.FC = () => {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [barcodes, setBarcodes] = useState('');
  const [locale, setLocale] = useState<'de-DE' | 'en-US'>('de-DE');
  const { isLoading, error, record, meta, run, reset } = useSerpapiFreePipeline();

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
          <AttributeList title="eBay Item Specifics" items={record.item_specifics} />
          <AttributeList title="Kaufland Attribute" items={record.attributes_kaufland} />
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
          {meta && <MetaPanel meta={meta} />}
        </div>
      )}
    </div>
  );
};

export default SerpapiFreeIdentifyView;

