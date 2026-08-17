import React, { useState, useRef, useEffect } from "react";

import { shouldOpenCellEditor } from "../../utils/cellKeys";

interface EditableCellProps {
  productId: string;
  field: string;
  value: any;
  type: "text" | "number" | "select";
  options?: { value: string; label: string }[];
  isEditMode: boolean;
  isDirty: boolean;
  onCellChange: (productId: string, field: string, value: any, originalValue: any) => void;
  children: React.ReactNode;
}

const EditableCell: React.FC<EditableCellProps> = ({
  productId,
  field,
  value,
  type,
  options,
  isEditMode,
  isDirty,
  onCellChange,
  children,
}) => {
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(String(value ?? ""));
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  // Nach dem Verlassen des Eingabefelds zurueck auf die Zelle — sonst faellt
  // der Fokus an den Seitenanfang und die Tab-Reihenfolge ist verloren.
  const cellRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current instanceof HTMLInputElement) {
        inputRef.current.select();
      }
      return;
    }
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      cellRef.current?.focus();
    }
  }, [editing]);

  // Reset local value when the source value changes (e.g. after save)
  useEffect(() => {
    if (!editing) {
      setLocalValue(String(value ?? ""));
    }
  }, [value, editing]);

  if (!isEditMode) {
    return <>{children}</>;
  }

  const handleClick = () => {
    if (!editing) {
      setLocalValue(String(value ?? ""));
      setEditing(true);
    }
  };

  const handleConfirm = () => {
    setEditing(false);
    returnFocus.current = true;
    const parsed = type === "number" ? (localValue === "" ? "" : parseFloat(localValue)) : localValue;
    onCellChange(productId, field, parsed, value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleConfirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
      returnFocus.current = true;
      setLocalValue(String(value ?? ""));
    } else if (e.key === "Tab") {
      handleConfirm();
      // Let browser handle tab navigation naturally
    }
  };

  if (editing) {
    const baseClass = "w-full rounded-sm border border-accent bg-app-elevated px-1.5 py-0.5 text-sm text-txt-primary outline-none";
    if (type === "select" && options) {
      return (
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={handleConfirm}
          onKeyDown={handleKeyDown}
          className={baseClass}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }
    return (
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type={type}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={handleConfirm}
        onKeyDown={handleKeyDown}
        step={type === "number" ? "0.01" : undefined}
        min={type === "number" ? "0" : undefined}
        className={baseClass}
      />
    );
  }

  return (
    <div
      ref={cellRef}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        // Der Ausloeser war ein reines <div onClick> — im Bearbeiten-Modus kam
        // man nur mit der Maus in eine Zelle. Bei 40 Zeilen Preispflege ist das
        // der Unterschied zwischen zwei und zehn Minuten.
        if (!shouldOpenCellEditor(e)) return;
        e.preventDefault();
        handleClick();
      }}
      className={`cursor-pointer rounded-sm px-1 py-0.5 -mx-1 transition outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:border-accent/40 ${isDirty ? "bg-accent-dim border border-accent/30" : "hover:bg-app-elevated/60 border border-transparent"}`}
      title="Klicken oder Enter zum Bearbeiten"
      aria-label={`${field} bearbeiten`}
    >
      {children}
    </div>
  );
};

export default EditableCell;
