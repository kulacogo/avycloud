import React from "react";
import { Product, ColumnDefinition } from "./types";

interface AdminTableRowProps {
  product: Product;
  visibleColumnDefinitions: ColumnDefinition[];
  isSelected: boolean;
  onSelect: (id: string) => void;
  onSelectProduct: (id: string) => void;
  rowRef: (el: HTMLTableRowElement | null) => void;
}

const AdminTableRow: React.FC<AdminTableRowProps> = ({
  product,
  visibleColumnDefinitions,
  isSelected,
  onSelect,
  onSelectProduct,
  rowRef,
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
          aria-label="Produkt ausw\u00E4hlen"
          checked={isSelected}
          onChange={() => onSelect(product.id)}
          className="bg-app-border border-app-border"
        />
      </td>
      {visibleColumnDefinitions.map((column) => (
        <td
          key={`${product.id}-${column.id}`}
          className="p-3 align-top"
          style={column.id === "thumbnail" ? { width: "80px" } : undefined}
        >
          {column.render({ product, onSelectProduct })}
        </td>
      ))}
    </tr>
  );
};

export default React.memo(AdminTableRow);
