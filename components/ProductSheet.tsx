
import React, { useState, useEffect, useCallback } from 'react';
import { Product, DatasheetChange, ProductImage } from '../types';
import {
  saveProduct,
  syncToBaseLinker,
  generateImages,
  openSkuLabelWindow,
  assignProductToBinApi,
  removeProductFromBinApi,
} from '../api/client';
import { EditIcon, SaveIcon, SyncIcon, GenerateIcon, PrintIcon } from './icons/Icons';
import { Spinner } from './Spinner';
import ImageGallery from './ImageGallery';
import AttributeTable from './AttributeTable';
import PricingInfo from './PricingInfo';
import AssistantChat from './GeminiChat';

interface ProductSheetProps {
  product: Product;
  onUpdate: (updatedProduct: Product) => void;
}

const ProductSheet: React.FC<ProductSheetProps> = ({ product, onUpdate }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [localProduct, setLocalProduct] = useState(product);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [autoGenDone, setAutoGenDone] = useState(false);
  const [isPrintingLabel, setIsPrintingLabel] = useState(false);
  const [binCodeInput, setBinCodeInput] = useState(product.storage?.binCode || '');
  const [binQuantity, setBinQuantity] = useState<number>(product.inventory?.quantity || 1);
  const [isAssigningBin, setIsAssigningBin] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');

  useEffect(() => {
    setLocalProduct(product);
    setIsEditing(false);
    // New products should be marked as dirty so they can be saved immediately
    setIsDirty(!product.ops?.last_saved_iso);
    setAutoGenDone(false);
    setBinCodeInput(product.storage?.binCode || '');
    setBinQuantity(product.inventory?.quantity || 1);
    setNewImageUrl('');
  }, [product]);

  const updateImages = useCallback((mutator: (images: ProductImage[]) => ProductImage[]) => {
    setLocalProduct(prev => {
      const currentImages = prev.details?.images || [];
      const nextImages = mutator([...currentImages]);
      return {
        ...prev,
        details: {
          ...prev.details,
          images: nextImages,
        },
      };
    });
    setIsDirty(true);
  }, []);

  const handleReorderImages = useCallback(
    (fromIndex: number, toIndex: number) => {
      updateImages((images) => {
        const boundedFrom = Math.max(0, Math.min(images.length - 1, fromIndex));
        const boundedTo = Math.max(0, Math.min(images.length - 1, toIndex));
        if (boundedFrom === boundedTo) return images;
        const [moved] = images.splice(boundedFrom, 1);
        images.splice(boundedTo, 0, moved);
        return images;
      });
    },
    [updateImages]
  );

  const handleDeleteImage = useCallback(
    (index: number) => {
      updateImages((images) => {
        images.splice(index, 1);
        return images;
      });
    },
    [updateImages]
  );

  const handleAddImageFromUrl = useCallback(() => {
    const url = newImageUrl.trim();
    if (!url) return;
    updateImages((images) => [
      ...images,
      { source: 'web', variant: 'other', url_or_base64: url, notes: 'Manuell hinzugefügt' },
    ]);
    setNewImageUrl('');
  }, [newImageUrl, updateImages]);

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const handleUploadImage = useCallback(
    async (file: File | null) => {
      if (!file) return;
      try {
        const base64 = await fileToBase64(file);
        updateImages((images) => [
          ...images,
          { source: 'upload', variant: 'other', url_or_base64: base64, notes: file.name || 'Upload' },
        ]);
      } catch (error) {
        console.error('Failed to read image file', error);
      }
    },
    [updateImages]
  );

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  // NO AUTO-GENERATION - user must click "Generate Images" button manually

  const handleSave = async () => {
    setIsSaving(true);
    const result = await saveProduct(localProduct);
    if (result.ok && result.data) {
      const assignedSku = result.data.sku || localProduct.identification.sku || localProduct.details.identifiers?.sku || null;
      const updatedProduct: Product = {
        ...localProduct,
        identification: {
            ...localProduct.identification,
            sku: assignedSku || localProduct.identification.sku,
        },
        details: {
            ...localProduct.details,
            identifiers: {
                ...(localProduct.details.identifiers || {}),
                sku: assignedSku || localProduct.details.identifiers?.sku || undefined,
            },
        },
        ops: {
          ...localProduct.ops,
          revision: result.data.revision,
          last_saved_iso: new Date().toISOString(),
        },
      };
      onUpdate(updatedProduct);
      setIsEditing(false);
      setIsDirty(false);
      showNotification('success', 'Product saved successfully!');
    } else {
      showNotification('error', result.error?.message || 'Failed to save product.');
    }
    setIsSaving(false);
  };
  const handlePrintLabel = async () => {
    if (!localProduct?.id) return;
    setIsPrintingLabel(true);
    const result = openSkuLabelWindow(localProduct.id);
    if (!result.ok) {
      showNotification('error', result.error?.message || 'Konnte Etikett nicht laden.');
    } else {
      showNotification('success', 'Etikett geöffnet.');
    }
    setIsPrintingLabel(false);
  };

  const handleAssignBin = async () => {
    if (!binCodeInput) {
      showNotification('error', 'Bitte einen BIN-Code angeben.');
      return;
    }
    setIsAssigningBin(true);
    const result = await assignProductToBinApi(binCodeInput.toUpperCase(), localProduct.id, Number(binQuantity) || 1);
    if (result.ok && result.data?.product) {
      setLocalProduct(result.data.product);
      onUpdate(result.data.product);
      setBinCodeInput(result.data.product.storage?.binCode || '');
      setBinQuantity(result.data.product.storage?.quantity || 1);
      showNotification('success', 'Produkt wurde eingelagert.');
    } else {
      showNotification('error', result.error?.message || 'Einlagerung fehlgeschlagen.');
    }
    setIsAssigningBin(false);
  };

  const handleRemoveBin = async () => {
    if (!localProduct.storage?.binCode) return;
    const response = await removeProductFromBinApi(localProduct.storage.binCode, localProduct.id);
    if (!response.ok) {
      showNotification('error', response.error?.message || 'Entfernen fehlgeschlagen.');
      return;
    }
    const updated = { ...localProduct, storage: null };
    setLocalProduct(updated);
    onUpdate(updated);
    setBinCodeInput('');
    setBinQuantity(1);
    showNotification('success', 'Produkt aus BIN entfernt.');
  };

  const applyAssistantChange = (change: DatasheetChange) => {
    setLocalProduct(prev => {
      const next = JSON.parse(JSON.stringify(prev)) as Product;
      if (change.short_description) {
        next.details.short_description = change.short_description;
      }
      if (Array.isArray(change.key_features) && change.key_features.length > 0) {
        next.details.key_features = change.key_features;
      }
      if (change.attributes && Object.keys(change.attributes).length > 0) {
        next.details.attributes = {
          ...next.details.attributes,
          ...change.attributes,
        };
      }
      if (change.pricing) {
        next.details.pricing = {
          ...next.details.pricing,
          ...change.pricing,
          lowest_price: {
            ...next.details.pricing.lowest_price,
            ...change.pricing.lowest_price,
          },
        };
      }
      if (change.notes) {
        next.notes = {
          unsure: change.notes.unsure || next.notes?.unsure || [],
          warnings: change.notes.warnings || next.notes?.warnings || [],
        };
      }
      return next;
    });
    setIsDirty(true);
    showNotification('success', 'Vorgeschlagene Änderung übernommen.');
  };

  const applyAssistantImages = (images: ProductImage[]) => {
    if (!images || images.length === 0) return;
    setLocalProduct(prev => ({
      ...prev,
      details: { ...prev.details, images: [...prev.details.images, ...images] },
    }));
    setIsDirty(true);
    showNotification('success', `${images.length} Bild(er) hinzugefügt.`);
  };

  const handleSync = async () => {
    setIsSyncing(true);
    const result = await syncToBaseLinker(localProduct);
    const syncResult = result.results?.find((entry) => entry.id === localProduct.id);

    if (syncResult?.status === 'synced') {
      const updatedProduct = {
        ...localProduct,
        ops: {
          ...localProduct.ops,
          sync_status: 'synced' as const,
          last_synced_iso: new Date().toISOString(),
        },
      };
      onUpdate(updatedProduct);
      showNotification('success', 'Sync mit BaseLinker erfolgreich.');
    } else {
      const updatedProduct = {
        ...localProduct,
        ops: {
          ...localProduct.ops,
          sync_status: 'failed' as const,
        },
      };
      onUpdate(updatedProduct);
      const errorMessage = syncResult?.message || result.error?.message || 'Sync fehlgeschlagen.';
      showNotification('error', errorMessage);
    }
    setIsSyncing(false);
  };

  const handleGenerateImages = async () => {
    setIsGenerating(true);
    const result = await generateImages(localProduct.id);
    if (result.ok && result.data) {
      const newImages = result.data.images.map(img => ({
        source: 'generated' as const,
        variant: img.variant as any,
        url_or_base64: img.url,
        notes: 'AI Generated Image'
      }));
      const updatedProduct = { ...localProduct, details: { ...localProduct.details, images: [...localProduct.details.images, ...newImages] } };
      onUpdate(updatedProduct);
      showNotification('success', 'New images generated!');
    } else {
      // Fallback: show placeholder images so UI bleibt funktionsfähig
      const placeholders = [
        `https://placehold.co/600x600?text=${encodeURIComponent(localProduct.identification.name)}`,
        `https://placehold.co/600x600/334155/FFFFFF?text=${encodeURIComponent(localProduct.identification.brand || 'AI Image')}`
      ].map((url, idx) => ({
        source: 'generated' as const,
        variant: (idx === 0 ? 'front' : 'angle') as any,
        url_or_base64: url,
        notes: 'Placeholder (image-gen not available)'
      }));
      const updatedProduct = { ...localProduct, details: { ...localProduct.details, images: [...localProduct.details.images, ...placeholders] } };
      onUpdate(updatedProduct);
      showNotification('error', result.error?.message || 'Image generation not available. Added placeholders.');
    }
    setIsGenerating(false);
  };

  const handleFieldChange = (field: string, value: string) => {
    const keys = field.split('.');
    setLocalProduct(prev => {
        const newProd = JSON.parse(JSON.stringify(prev)); // Deep copy
        let current = newProd;
        for (let i = 0; i < keys.length - 1; i++) {
            current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = value;
        return newProd;
    });
    setIsDirty(true);
  };

  return (
    <section id="product-sheet" className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-screen-2xl mx-auto relative">
      {notification && (
        <div className={`fixed top-20 right-8 p-4 rounded-lg shadow-lg z-50 ${notification.type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white`}>
          {notification.message}
        </div>
      )}
      
      <div className="lg:col-span-2 space-y-8">
        <header className="p-6 bg-slate-800 rounded-lg shadow-lg">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <textarea
                  id="p-name"
                  value={localProduct.identification.name}
                  onChange={(e) => handleFieldChange('identification.name', e.target.value)}
                  className="w-full text-2xl sm:text-3xl font-bold bg-transparent outline-none border-b border-sky-500 resize-y min-h-[3.5rem] leading-tight"
                  rows={2}
                  style={{ wordBreak: 'break-word' }}
                />
              ) : (
                <h1 className="text-2xl sm:text-3xl font-bold break-words leading-tight" style={{ wordBreak: 'break-word' }}>
                  {localProduct.identification.name}
                </h1>
              )}
              <p id="p-brand-cat" className="text-slate-400 mt-1">
                <input
                  value={localProduct.identification.brand}
                  onChange={(e) => handleFieldChange('identification.brand', e.target.value)}
                  readOnly={!isEditing}
                  className={`bg-transparent inline-block outline-none ${isEditing ? 'border-b border-sky-500' : ''}`}
                />
                {' · '}
                <span className="text-sky-400">{localProduct.identification.category}</span>
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-2">
                <span>
                  SKU:{' '}
                  {localProduct.identification.sku || localProduct.details.identifiers?.sku || 'wird beim Speichern vergeben'}
                </span>
                <button
                  id="btn-print-label"
                  onClick={handlePrintLabel}
                  disabled={!localProduct.identification.sku || isPrintingLabel}
                  className="flex items-center px-3 py-1.5 bg-slate-700 text-white rounded-full hover:bg-slate-600 disabled:opacity-40"
                  title="Label drucken (57x25 mm)"
                >
                  <PrintIcon />
                  <span className="ml-1">Label</span>
                </button>
                {localProduct.storage?.binCode && (
                  <span className="text-emerald-300">
                    BIN {localProduct.storage.binCode} · Menge {localProduct.storage.quantity}
                  </span>
                )}
              </div>
              <p id="p-barcodes" className="text-xs text-slate-500 mt-1">
                Barcodes: {localProduct.identification.barcodes?.join(', ') || 'N/A'}
              </p>
            </div>
            <div className="actions flex flex-col sm:flex-row flex-wrap gap-3 w-full sm:w-auto justify-end">
              <button
                id="btn-edit"
                onClick={() => setIsEditing(v => !v)}
                className={`flex items-center justify-center px-4 py-2 font-semibold rounded-lg transition-colors w-full sm:w-auto ${
                  isEditing ? 'bg-slate-600 text-white hover:bg-slate-500' : 'bg-sky-600 text-white hover:bg-sky-500'
                }`}
              >
                <EditIcon /><span className="ml-2">{isEditing ? 'Editing...' : 'Edit'}</span>
              </button>
              <button
                id="btn-save"
                onClick={handleSave}
                disabled={isSaving}
                className="flex items-center justify-center px-4 py-2 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-500 transition-colors disabled:bg-green-800 disabled:cursor-not-allowed w-full sm:w-auto"
              >
                <SaveIcon /><span className="ml-2">{isSaving ? 'Saving...' : 'Save'}</span>
              </button>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-8">
          <div id="media-gallery" className="md:col-span-2">
            <ImageGallery
              images={localProduct.details.images}
              isEditing={isEditing}
              onDeleteImage={isEditing ? handleDeleteImage : undefined}
              onReorder={isEditing ? handleReorderImages : undefined}
            />
            {isEditing && (
              <div className="mt-4 space-y-3">
                <div className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="text"
                    placeholder="Bild-URL einfügen (https://...)"
                    className="flex-1 bg-slate-700 border border-slate-600 rounded-lg p-2 text-slate-200"
                    value={newImageUrl}
                    onChange={(e) => setNewImageUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddImageFromUrl();
                      }
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleAddImageFromUrl}
                    className="px-4 py-2 bg-slate-600 rounded-lg text-white font-semibold hover:bg-slate-500 transition-colors disabled:opacity-50"
                    disabled={!newImageUrl.trim()}
                  >
                    URL hinzufügen
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <label className="px-4 py-2 bg-slate-700 text-slate-200 rounded-lg border border-slate-600 cursor-pointer w-full sm:w-auto text-center">
                    Datei hochladen
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0] || null;
                        handleUploadImage(file);
                        if (e.target) {
                          e.target.value = '';
                        }
                      }}
                    />
                  </label>
                  <p className="text-xs text-slate-400 text-center sm:text-left">
                    Unterstützt JPG, PNG oder WebP · optimale Breite ≥ 1200px
                  </p>
                </div>
              </div>
            )}
          </div>
          <section id="highlights" className="md:col-span-3 p-6 bg-slate-800 rounded-lg shadow-lg">
            <h3 className="text-xl font-semibold mb-3 text-white">Highlights</h3>
            <ul className="space-y-2 list-disc list-inside text-slate-300">
              {localProduct.details.key_features.map((feature, index) => (
                <li key={index}>{feature}</li>
              ))}
            </ul>
          </section>
        </div>

        <section id="description" className="p-6 bg-slate-800 rounded-lg shadow-lg">
          <h3 className="text-xl font-semibold mb-3 text-white">Beschreibung</h3>
          {isEditing ? (
            <textarea
              defaultValue={localProduct.details.short_description}
              onBlur={(e) => handleFieldChange('details.short_description', e.target.value)}
              className="w-full min-h-[120px] bg-slate-700 border border-slate-600 rounded-lg p-3 text-slate-200"
            />
          ) : (
            <p className="text-slate-300 leading-relaxed">{localProduct.details.short_description}</p>
          )}
        </section>

        <section id="attributes" className="p-6 bg-slate-800 rounded-lg shadow-lg">
          <h3 className="text-xl font-semibold mb-4 text-white">Attributes</h3>
          {/* Key Features editor */}
          <div className="mb-6">
            <h4 className="text-slate-300 font-semibold mb-2">Key Features</h4>
            {isEditing ? (
              <textarea
                defaultValue={(localProduct.details.key_features || []).join('\n')}
                onBlur={(e) => {
                  const lines = e.target.value.split('\n').map(l => l.trim()).filter(Boolean);
                  setLocalProduct(prev => ({ ...prev, details: { ...prev.details, key_features: lines } }));
                  setIsDirty(true);
                }}
                placeholder="Eine Eigenschaft pro Zeile"
                className="w-full min-h-[100px] bg-slate-700 border border-slate-600 rounded-lg p-3 text-slate-200"
              />
            ) : (
              <ul className="list-disc list-inside text-slate-300">
                {localProduct.details.key_features.map((f, i) => <li key={i}>{f}</li>)}
              </ul>
            )}
          </div>

          <AttributeTable
            attributes={localProduct.details.attributes}
            isEditing={isEditing}
            onChange={(next) => {
              setLocalProduct(prev => ({ ...prev, details: { ...prev.details, attributes: next } }));
              setIsDirty(true);
            }}
          />
        </section>

        <section id="pricing" className="p-6 bg-slate-800 rounded-lg shadow-lg">
          <h3 className="text-xl font-semibold mb-4 text-white">Pricing</h3>
          <PricingInfo
            pricing={localProduct.details.pricing}
            isEditing={isEditing}
            onChange={(next) => {
              setLocalProduct(prev => ({ ...prev, details: { ...prev.details, pricing: next } }));
              setIsDirty(true);
            }}
          />
        </section>

        <section id="storage" className="p-6 bg-slate-800 rounded-lg shadow-lg">
          <h3 className="text-xl font-semibold mb-4 text-white">Lagerplatz</h3>
          {localProduct.storage ? (
            <p className="text-slate-300 text-sm mb-3">
              Eingelagert in <span className="font-semibold">{localProduct.storage.binCode}</span> (Zone{' '}
              {localProduct.storage.zone}, Etage {localProduct.storage.etage}, Gang {localProduct.storage.gang}, Regal{' '}
              {localProduct.storage.regal}, Ebene {localProduct.storage.ebene}) – Menge {localProduct.storage.quantity}
            </p>
          ) : (
            <p className="text-slate-400 text-sm mb-3">Aktuell keinem BIN zugeordnet.</p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">BIN-Code</label>
              <input
                value={binCodeInput}
                onChange={(e) => setBinCodeInput(e.target.value.toUpperCase())}
                placeholder="z.B. XGA0101A"
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Menge</label>
              <input
                type="number"
                min={1}
                value={binQuantity}
                onChange={(e) => setBinQuantity(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3 mt-4">
            <button
              onClick={handleAssignBin}
              disabled={isAssigningBin}
              className="px-4 py-2 bg-sky-600 text-white rounded hover:bg-sky-500 disabled:opacity-40"
            >
              {isAssigningBin ? 'Übernehme...' : 'In BIN einlagern'}
            </button>
            {localProduct.storage?.binCode && (
              <button
                onClick={handleRemoveBin}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-500"
              >
                BIN-Zuordnung entfernen
              </button>
            )}
          </div>
        </section>
        
        <div className="p-6 bg-slate-800 rounded-lg shadow-lg">
            <h3 className="text-xl font-semibold mb-4 text-white">Actions</h3>
            <div className="actions flex flex-wrap gap-4">
                <button id="btn-sync" onClick={handleSync} disabled={isSyncing} className="flex items-center justify-center px-4 py-2 bg-slate-700 text-slate-200 font-semibold rounded-lg hover:bg-slate-600 transition-colors disabled:bg-slate-500 disabled:cursor-wait">
                    {isSyncing ? <Spinner className="w-5 h-5" /> : <SyncIcon />}<span className="ml-2">Sync</span>
                </button>
                <button id="btn-genimg" onClick={handleGenerateImages} disabled={isGenerating} className="flex items-center justify-center px-4 py-2 bg-slate-700 text-slate-200 font-semibold rounded-lg hover:bg-slate-600 transition-colors disabled:bg-slate-500 disabled:cursor-wait">
                    {isGenerating ? <Spinner className="w-5 h-5" /> : <GenerateIcon />}<span className="ml-2">Generate Images</span>
                </button>
            </div>
        </div>
      </div>

      <aside id="gemini-chat" className="lg:col-span-1 lg:sticky lg:top-24 h-fit">
        <AssistantChat
          product={localProduct}
          onApplyDatasheetChange={applyAssistantChange}
          onAddImages={applyAssistantImages}
        />
      </aside>
    </section>
  );
};

export default ProductSheet;
