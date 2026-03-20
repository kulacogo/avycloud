/**
 * CSV Export utility — generates and triggers download of a CSV file.
 * No external dependencies.
 */

function escapeCell(value: unknown): string {
  const str = String(value ?? "");
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes(";")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportToCsv(filename: string, headers: string[], rows: unknown[][]): void {
  const sep = ";"; // German Excel default
  const bom = "\uFEFF"; // UTF-8 BOM for Excel compatibility
  const headerLine = headers.map(escapeCell).join(sep);
  const dataLines = rows.map((row) => row.map(escapeCell).join(sep));
  const csv = bom + [headerLine, ...dataLines].join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
