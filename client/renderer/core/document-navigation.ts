import type { DocumentNavigation } from '../../types/document-view';

export function normalizeDocumentNavigation(input: unknown): DocumentNavigation | null {
  const record = (value: unknown): value is Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
  );
  const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9._:-]{1,180}$/i.test(value);
  const label = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 180;
  if (!record(input) || !id(input.providerId) || !id(input.activeMode) || !label(input.outlineLabel) ||
      !Array.isArray(input.modes) || !Array.isArray(input.rows) ||
      input.modes.length < 1 || input.modes.length > 4 || input.rows.length > 96) return null;
  const ids = new Set<string>();
  const unique = (value: string): boolean => {
    if (ids.has(value)) return false;
    ids.add(value);
    return true;
  };
  const modes: DocumentNavigation['modes'][number][] = [];
  for (const item of input.modes as unknown[]) {
    if (!record(item) || !id(item.id) || !unique(item.id) || !label(item.label)) return null;
    modes.push({ id: item.id, label: item.label });
  }
  if (!ids.has(input.activeMode)) return null;
  const rows: DocumentNavigation['rows'][number][] = [];
  for (const row of input.rows as unknown[]) {
    if (!record(row) || !id(row.id) || !unique(row.id) || !label(row.label) ||
        typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number < 1 ||
        (row.tone !== 'amber' && row.tone !== 'teal' && row.tone !== 'neutral')) return null;
    rows.push({ id: row.id, label: row.label, number: row.number, tone: row.tone });
  }
  return { providerId: input.providerId, activeMode: input.activeMode, outlineLabel: input.outlineLabel, modes, rows };
}
