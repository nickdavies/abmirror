/**
 * Parses hashtags from transaction notes. Tags are any #word sequence,
 * including slashes (e.g. #50/50), matched case-insensitively.
 */

// Matches # followed by any non-whitespace non-# characters
const TAG_REGEX = /#[^\s#]+/g;

export interface ParsedTags {
  /** Lowercased tags extracted from notes */
  tags: string[];
  /** Notes with tags stripped and whitespace collapsed */
  cleanNotes: string;
}

export function parseTags(notes: string | null | undefined): ParsedTags {
  if (!notes) return { tags: [], cleanNotes: "" };
  const raw = notes.match(TAG_REGEX) ?? [];
  const tags = raw.map((t) => t.toLowerCase());
  const cleanNotes = notes
    .replace(TAG_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
  return { tags, cleanNotes };
}

/** Returns true if notes contain ALL of the required tags (AND logic). */
export function hasTags(
  notes: string | null | undefined,
  required: string[]
): boolean {
  if (required.length === 0) return true;
  const { tags } = parseTags(notes);
  const tagSet = new Set(tags);
  return required.every((req) => tagSet.has(req.toLowerCase()));
}
