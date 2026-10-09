export function pickProgress(lines: Array<{ itemId: string; required: number; picked: number }>) {
  return {
    totalItems: lines.length,
    completedItems: lines.filter((line) => line.picked >= line.required).length,
    totalUnits: lines.reduce((sum, line) => sum + line.required, 0),
    pickedUnits: lines.reduce((sum, line) => sum + line.picked, 0),
    complete: lines.length > 0 && lines.every((line) => line.picked === line.required),
  };
}

export function packProgress(keys: string[], verified: Record<string, boolean>) {
  const completed = keys.filter((key) => verified[key]).length;
  return { completed, total: keys.length, complete: keys.length > 0 && completed === keys.length };
}

// A timeout is not evidence the original job stopped. Only terminal jobs
// allow a new, explicitly confirmed copy.
export function mayReprintLabel(status: string | null): boolean {
  return status === 'done' || status === 'failed' || status === 'uncertain';
}
