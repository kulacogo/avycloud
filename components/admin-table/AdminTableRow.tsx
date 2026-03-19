import React from "react";
import { Product, ColumnDefinition } from "./types";
import EditableCell from "./EditableCell";

// Columns that support inline editing and their field paths
const EDITABLE_COLUMN_MAP: Record<string, { field: string; type: "text" | "number" | "select"; options?: { value: string; label: string }[] }> = {
  nameBrand: { field: "identification.name", type: "text" },
  category: { field: "identification.category", type: "text" },
  price: { field: "details.pricing.sellPrice", type: "number" },
  inventory: { field: "details.pricing.buyPrice", type: "number" },
};

function getNestedValue(obj: any, path: string): any {
  const keys = path.split(".");
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

interface AdminTableRowProps {
  product: Product;
  visibleColumnDefinitions: ColumnDefinition[];
  isSelected: boolean;
  onSelect: (id: string) => void;
  onSelectProduct: (id: string) => void;
  rowRef: (el: HTMLTableRowElement | null) => void;
  isEditMode?: boolean;
  dirtyFields?: Record<string, any>;
  onCellChange?: (productId: string, field: string, value: any, originalValue: any) => void;
}

const AdminTableRow: React.FC<AdminTableRowProps> = ({
  product,
  visibleColumnDefinitions,
  isSelected,
  onSelect,
  onSelectProduct,
  rowRef,
  isEditMode = false,
  dirtyFields,
  onCellChange,
}) => {
  return (
    <tr
      ref={rowRef}
      data-product-row={product.id}
      className="border-b border-app-border hover:bg-app-elevated/50 transition-colors"
    >
      <td className="p-3">
        <input
          type="checkbox"
          name={`select-product-${product.id}`}
          aria-label="Produkt auswählen"
          checked={isSelected}
          onChange={() => onSelect(product.id)}
          className="bg-app-border border-app-border"
        />
      </td>
      {visibleColumnDefinitions.map((column) => {
        const editConfig = EDITABLE_COLUMN_MAP[column.id];
        const cellContent = column.render({ product, onSelectProduct });

        if (editConfig && isEditMode && onCellChange) {
          const originalValue = getNestedValue(product, editConfig.field);
          const isDirty = dirtyFields ? editConfig.field in dirtyFields : false;

          return (
            <td
              key={`${product.id}-${column.id}`}
              className="p-3 align-top"
            >
              <EditableCell
                productId={product.id}
                field={editConfig.field}
                value={originalValue}
                type={editConfig.type}
                options={editConfig.options}
                isEditMode={isEditMode}
                isDirty={isDirty}
                onCellChange={onCellChange}
              >
                {cellContent}
              </EditableCell>
            </td>
          );
        }

        return (
          <td
            key={`${product.id}-${column.id}`}
            className="p-3 align-top"
            style={column.id === "thumbnail" ? { width: "80px" } : undefined}
          >
            {cellContent}
          </td>
        );
      })}
    </tr>
  );
};

export default React.memo(AdminTableRow);
