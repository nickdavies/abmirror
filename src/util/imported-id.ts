/** Stable cross-budget identity marker stamped on every transaction we create. */
const PREFIX = "ABMirror";

export function formatImportedId(budgetId: string, txId: string): string {
  return `${PREFIX}:${budgetId}:${txId}`;
}

export interface ParsedImportedId {
  budgetId: string;
  txId: string;
}

/**
 * Returns null if the string is not a valid ABMirror imported_id.
 * Budget IDs can contain colons, so we split on the first two colons only.
 */
export function parseImportedId(raw: string): ParsedImportedId | null {
  if (!isABMirrorId(raw)) return null;
  const withoutPrefix = raw.slice(PREFIX.length + 1);
  const colonIdx = withoutPrefix.indexOf(":");
  if (colonIdx === -1) return null;
  return {
    budgetId: withoutPrefix.slice(0, colonIdx),
    txId: withoutPrefix.slice(colonIdx + 1),
  };
}

export function isABMirrorId(raw: string | null | undefined): raw is string {
  return typeof raw === "string" && raw.startsWith(`${PREFIX}:`);
}
