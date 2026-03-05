
import React from 'react';

interface AttributeTableProps {
  attributes: Record<string, any>;
  isEditing?: boolean;
  onChange?: (next: Record<string, any>) => void;
  highlightKeys?: Set<string> | string[];
}

const AttributeTable: React.FC<AttributeTableProps> = ({ attributes, isEditing = false, onChange, highlightKeys }) => {
  const formatValue = (value: any) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  };

  const ATTRIBUTE_ORDER = [
    'Marke',
    'Hersteller',
    'Produktart',
    'Produkttyp',
    'Artikeltyp',
    'Gerätetyp',
    'Bauteil',
    'Herstellernummer',
    'Referenznummer(n) OEM',
    'Referenznummer',
    'OEM-Referenznummer',
    'Modell',
    'Fahrzeugmarke',
    'Fahrzeugmodell',
    'Baureihe',
    'Einbauposition',
    'K-Typ',
    'Abteilung',
    'Geschlecht',
    'Größe',
    'EU-Schuhgröße',
    'Schuhgröße',
    'Farbe',
    'Material',
    'weight',
    'Zustand',
    'Kategorie',
  ].map((k) => k.toLowerCase());

  const normalizeKeyForSort = (key: string) => {
    const lower = String(key || '').trim().toLowerCase();
    if (!lower) return '';
    // Group common weight variants together (e.g. "Gewicht(kg)", "Gewicht", internal "weight")
    if (lower === 'weight' || lower.startsWith('gewicht')) return 'weight';
    return lower;
  };

  const formatKeyLabel = (key: string) => {
    const lower = String(key || '').trim().toLowerCase();
    if (lower === 'weight') return 'Gewicht';
    return key;
  };

  const normalizeLabelForSort = (key: string) => {
    const label = String(formatKeyLabel(key) || '').trim().toLowerCase();
    if (!label) return normalizeKeyForSort(key);
    // Ensure "Gewicht" is sorted in the 'G' section even though the internal key is "weight"
    if (label === 'gewicht') return 'gewicht';
    return label;
  };

  const rankKey = (key: string) => {
    const normalized = normalizeKeyForSort(key);
    const idx = ATTRIBUTE_ORDER.indexOf(normalized);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  const sortAttributes = (input: Record<string, any>) => {
    const entries = Object.entries(input || {}).sort((a, b) => {
      const aRank = rankKey(a[0] || '');
      const bRank = rankKey(b[0] || '');
      if (aRank !== bRank) return aRank - bRank;
      const aKey = normalizeLabelForSort(a[0] || '');
      const bKey = normalizeLabelForSort(b[0] || '');
      return aKey.localeCompare(bKey, 'de', { sensitivity: 'base' });
    });
    return entries.reduce((acc: Record<string, any>, [k, v]) => {
      acc[k] = v;
      return acc;
    }, {});
  };

  const attributeEntries = Object.entries(attributes || {}).sort((a, b) => {
    const aRank = rankKey(a[0] || '');
    const bRank = rankKey(b[0] || '');
    if (aRank !== bRank) return aRank - bRank;
    const aKey = normalizeLabelForSort(a[0] || '');
    const bKey = normalizeLabelForSort(b[0] || '');
    return aKey.localeCompare(bKey, 'de', { sensitivity: 'base' });
  });
  // Note: some fields are edited elsewhere in the product sheet (SKU/EAN/Barcodes),
  // or are special-cased with dedicated UI (K-Typ).
  const EXCLUDED_KEYS = [
    'ean',
    'sku',
    'k-typ',
    'ktyp',
    'k typ',
    'lowest_price',
    'lowest_price.amount',
    'lowest_price.currency',
    'lowest_price.amount',
    'lowest_price.currency',
  ];
  const ALWAYS_HIDE_KEYS = ['k-typ', 'ktyp', 'k typ'];
  const MAX_VALUE_LENGTH = 160;
  const highlightSet = (() => {
    if (!highlightKeys) return new Set<string>();
    if (highlightKeys instanceof Set) return new Set(Array.from(highlightKeys).map((k) => String(k || '').toLowerCase()));
    if (Array.isArray(highlightKeys)) return new Set(highlightKeys.map((k) => String(k || '').toLowerCase()));
    return new Set<string>();
  })();
  const displayEntries = isEditing
    ? attributeEntries.filter(([key]) => !ALWAYS_HIDE_KEYS.includes((key || '').toLowerCase()))
    : attributeEntries.filter(([key, value]) => {
        if (value === null || value === undefined || value === '') return false;
        const normalizedKey = key.toLowerCase();
        if (EXCLUDED_KEYS.includes(normalizedKey) || normalizedKey.startsWith('lowest_price')) return false;
        const textValue = formatValue(value).trim();
        if (!textValue) return false;
        if (textValue.length > MAX_VALUE_LENGTH) return false;
        return true;
      });

  const updateAttr = (key: string, value: string) => {
    if (!onChange) return;
    const next = { ...(attributes || {}) };
    next[key] = value;
    onChange(sortAttributes(next));
  };

  const renameKey = (oldKey: string, newKey: string) => {
    if (!onChange || !newKey) return;
    const next = { ...(attributes || {}) } as Record<string, any>;
    if (oldKey !== newKey) {
      next[newKey] = next[oldKey];
      delete next[oldKey];
      onChange(sortAttributes(next));
    }
  };

  const removeKey = (key: string) => {
    if (!onChange) return;
    const next = { ...(attributes || {}) } as Record<string, any>;
    delete next[key];
    onChange(sortAttributes(next));
  };

  const addRow = () => {
    if (!onChange) return;
    const next = { ...(attributes || {}) } as Record<string, any>;
    let base = 'Neues Feld';
    let idx = 1;
    let newKey = base;
    while (next[newKey] !== undefined) {
      newKey = `${base} ${idx++}`;
    }
    next[newKey] = '';
    onChange(sortAttributes(next));
  };

  if (displayEntries.length === 0) {
    return (
      <div>
        <p className="text-txt-muted">No specific attributes available.</p>
        {isEditing && (
          <button onClick={addRow} className="mt-3 px-3 py-1.5 text-sm bg-app-border text-txt-primary rounded-md">+ Add Attribute</button>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <tbody className="divide-y divide-app-border">
          {displayEntries.map(([key, value]) => (
            <tr key={key} className={highlightSet.has(String(key || '').toLowerCase()) ? 'bg-amber-500/10' : ''}>
              <td
                className={`py-3 pr-4 font-medium w-1/3 ${highlightSet.has(String(key || '').toLowerCase()) ? 'text-amber-200' : 'text-txt-muted'
                  }`}
              >
                {isEditing ? (
                  <input
                    defaultValue={formatKeyLabel(key)}
                    onBlur={(e) => {
                      const nextKey = e.target.value;
                      // Keep internal storage key stable ("weight"), but never show "weight" in UI.
                      if (String(key || '').trim().toLowerCase() === 'weight' && String(nextKey || '').trim().toLowerCase() === 'gewicht') {
                        return;
                      }
                      renameKey(key, nextKey);
                    }}
                    className={`w-full bg-app-elevated border rounded px-2 py-1 text-txt-secondary ${highlightSet.has(String(key || '').toLowerCase()) ? 'border-amber-400' : 'border-app-border'
                      }`}
                  />
                ) : formatKeyLabel(key)}
              </td>
              <td className="py-3 pl-4 text-txt-secondary">
                {isEditing ? (
                  <input
                    defaultValue={formatValue(value)}
                    onBlur={(e) => updateAttr(key, e.target.value)}
                    className={`w-full bg-app-elevated border rounded px-2 py-1 text-txt-secondary ${highlightSet.has(String(key || '').toLowerCase()) ? 'border-amber-400' : 'border-app-border'
                      }`}
                  />
                ) : formatValue(value)}
              </td>
              {isEditing && (
                <td className="py-3 pl-4 text-right w-24">
                  <button onClick={() => removeKey(key)} className="px-2 py-1 text-xs bg-danger text-txt-primary rounded-md">Remove</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isEditing && (
        <div className="mt-3">
          <button onClick={addRow} className="px-3 py-1.5 text-sm bg-app-border text-txt-primary rounded-md">+ Add Attribute</button>
        </div>
      )}
    </div>
  );
};

export default AttributeTable;
