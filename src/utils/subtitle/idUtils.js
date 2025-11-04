// Shared helpers to derive stable subtitle IDs and compare them reliably

// Simple stable hash from a string (djb2 variant)
const hashStable = (str) => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // Return as hex string
  return (hash >>> 0).toString(16);
};

/**
 * Derive a stable ID for a subtitle item with multiple fallbacks.
 * Priority:
 * 1) subtitle.id
 * 2) subtitle.subtitle_id
 * 3) subtitle.original_ids (joined)
 * 4) hash of start|end|text
 * 5) fallback to `idx-${index}`
 */
export const deriveSubtitleId = (subtitle, index = 0) => {
  if (!subtitle || typeof subtitle !== 'object') return `idx-${index}`;

  // 1) Explicit id
  if (subtitle.id !== undefined && subtitle.id !== null) return subtitle.id;

  // 2) Legacy subtitle_id
  if (subtitle.subtitle_id !== undefined && subtitle.subtitle_id !== null) return subtitle.subtitle_id;

  // 3) Lineage from original_ids
  if (Array.isArray(subtitle.original_ids) && subtitle.original_ids.length > 0) {
    return `orig-${subtitle.original_ids.join('-')}`;
  }

  // 4) Deterministic hash based on timing + text (best-effort if edited)
  const start = subtitle.start ?? '';
  const end = subtitle.end ?? '';
  const text = typeof subtitle.text === 'string' ? subtitle.text : '';
  const basis = `${start}|${end}|${text}`;
  if (basis !== '||') {
    return `h-${hashStable(basis)}`;
  }

  // 5) Last resort (avoid plain numeric index to reduce collisions)
  return `idx-${index}`;
};

/** Compare two subtitle IDs safely (string-compare to avoid type drift) */
export const idsEqual = (a, b) => String(a) === String(b);
