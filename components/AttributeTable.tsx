
import React from 'react';

interface AttributeTableProps {
  attributes: Record<string, string | number | boolean>;
  isEditing?: boolean;
  onChange?: (next: Record<string, string | number | boolean>) => void;
}

const AttributeTable: React.FC<AttributeTableProps> = ({ attributes, isEditing = false, onChange }) => {
  const attributeEntries = Object.entries(attributes || {});

  const updateAttr = (key: string, value: string) => {
    if (!onChange) return;
    const next = { ...(attributes || {}) };
    next[key] = value;
    onChange(next);
  };

  const renameKey = (oldKey: string, newKey: string) => {
    if (!onChange || !newKey) return;
    const next = { ...(attributes || {}) } as Record<string, any>;
    if (oldKey !== newKey) {
      next[newKey] = next[oldKey];
      delete next[oldKey];
      onChange(next);
    }
  };

  const removeKey = (key: string) => {
    if (!onChange) return;
    const next = { ...(attributes || {}) } as Record<string, any>;
    delete next[key];
    onChange(next);
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
    onChange(next);
  };

  if (attributeEntries.length === 0) {
    return (
      <div>
        <p className="text-slate-400">No specific attributes available.</p>
        {isEditing && (
          <button onClick={addRow} className="mt-3 px-3 py-1.5 text-sm bg-slate-600 text-white rounded-md">+ Add Attribute</button>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <tbody className="divide-y divide-slate-700">
          {attributeEntries.map(([key, value]) => (
            <tr key={key}>
              <td className="py-3 pr-4 font-medium text-slate-400 w-1/3">
                {isEditing ? (
                  <input defaultValue={key} onBlur={(e) => renameKey(key, e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-200" />
                ) : key}
              </td>
              <td className="py-3 pl-4 text-slate-200">
                {isEditing ? (
                  <input defaultValue={String(value)} onBlur={(e) => updateAttr(key, e.target.value)} className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-slate-200" />
                ) : String(value)}
              </td>
              {isEditing && (
                <td className="py-3 pl-4 text-right w-24">
                  <button onClick={() => removeKey(key)} className="px-2 py-1 text-xs bg-red-600 text-white rounded-md">Remove</button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {isEditing && (
        <div className="mt-3">
          <button onClick={addRow} className="px-3 py-1.5 text-sm bg-slate-600 text-white rounded-md">+ Add Attribute</button>
        </div>
      )}
    </div>
  );
};

export default AttributeTable;
