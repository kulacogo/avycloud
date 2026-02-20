import React from 'react';

/* -------------------------------------------------------
   Types
   ------------------------------------------------------- */
export interface TableColumn<T = Record<string, unknown>> {
  key: string;
  label: string;
  width?: string;
  render?: (value: unknown, row: T, index: number) => React.ReactNode;
}

export interface TableProps<T = Record<string, unknown>> {
  columns: TableColumn<T>[];
  data: T[];
  onRowClick?: (row: T, index: number) => void;
  emptyMessage?: string;
  className?: string;
}

/* -------------------------------------------------------
   Table component
   ------------------------------------------------------- */
function TableInner<T extends Record<string, unknown>>({
  columns,
  data,
  onRowClick,
  emptyMessage = 'Keine Daten vorhanden',
  className = '',
}: TableProps<T>) {
  return (
    <div className={`w-full overflow-x-auto ${className}`.trim()}>
      <table className="w-full border-collapse">
        {/* Head */}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className="
                  text-xs font-semibold text-[var(--text-tertiary)]
                  uppercase tracking-wide
                  py-3 px-4 border-b border-[var(--border)]
                  text-left whitespace-nowrap
                "
                style={col.width ? { width: col.width } : undefined}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>

        {/* Body */}
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="py-12 px-4 text-sm text-[var(--text-tertiary)] text-center"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                onClick={onRowClick ? () => onRowClick(row, rowIndex) : undefined}
                className={`
                  border-b border-[var(--border)] last:border-b-0
                  transition-colors duration-100
                  hover:bg-[var(--surface-hover)]
                  ${onRowClick ? 'cursor-pointer' : ''}
                `.trim()}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className="py-3 px-4 text-sm text-[var(--text-primary)]"
                  >
                    {col.render
                      ? col.render(row[col.key], row, rowIndex)
                      : (row[col.key] as React.ReactNode) ?? '\u2014'}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export const Table = React.memo(TableInner) as typeof TableInner;
