// Lyrics editor history state helpers: durable-identity row comparison and the entry/byte bounds
// that keep the in-memory undo, redo and checkpoint stacks finite.

export const clone = (value) => JSON.parse(JSON.stringify(value));
const identityKey = (value) => {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
};
const durableRowsIdentity = (rows) => {
  if (!Array.isArray(rows)) return null;
  const ordinalByIdentity = new Map();
  rows.forEach((row, index) => {
    const key = identityKey(row?.id);
    if (key !== null) ordinalByIdentity.set(key, index + 1);
  });
  return rows.map((row) => {
    const source = row?.originalId ?? row?.sourceId ?? null;
    const sourceKey = source === null ? null : identityKey(source);
    return {
      text: row?.text,
      speaker: row?.speaker ?? null,
      startMs: Math.round(Number(row?.start ?? row?.startTime) * 1_000),
      endMs: Math.round(Number(row?.end ?? row?.endTime) * 1_000),
      sourceOrdinal: sourceKey === null
        ? null
        : ordinalByIdentity.get(sourceKey) ?? (Number.isInteger(source) ? source : null),
    };
  });
};
export const same = (left, right) => (
  JSON.stringify(durableRowsIdentity(left)) === JSON.stringify(durableRowsIdentity(right))
);

// Native history retains 256 states, including the current/root state: at most 255 undo targets.
const MAX_LOCAL_LYRICS_HISTORY_ENTRIES = 255;
const MAX_LOCAL_LYRICS_HISTORY_STATE_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_LYRICS_HISTORY_BYTES = 256 * 1024 * 1024;
const MAX_LOCAL_LYRICS_CHECKPOINTS = 4;
const MAX_LOCAL_LYRICS_CHECKPOINT_BYTES = 128 * 1024 * 1024;
const STATE_SIZE_CACHE = new WeakMap();

const utf8ByteLength = (value) => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

const stateByteLength = (value) => {
  if (value == null || typeof value !== 'object') return Number.POSITIVE_INFINITY;
  const cached = STATE_SIZE_CACHE.get(value);
  if (cached !== undefined) return cached;
  let size = Number.POSITIVE_INFINITY;
  try {
    size = utf8ByteLength(JSON.stringify(value));
  } catch {
    // Non-serializable values cannot be retained in editor history.
  }
  STATE_SIZE_CACHE.set(value, size);
  return size;
};

export const pruneLyricsHistoryStacks = (
  history,
  redo,
  {
    maxEntries = MAX_LOCAL_LYRICS_HISTORY_ENTRIES,
    maxStateBytes = MAX_LOCAL_LYRICS_HISTORY_STATE_BYTES,
    maxTotalBytes = MAX_LOCAL_LYRICS_HISTORY_BYTES,
  } = {}
) => {
  const keep = (value) => Array.isArray(value)
    ? value.slice(-maxEntries).filter((state) => stateByteLength(state) <= maxStateBytes)
    : [];
  const nextHistory = keep(history);
  const nextRedo = keep(redo);
  let totalBytes = [...nextHistory, ...nextRedo]
    .reduce((total, state) => total + stateByteLength(state), 0);
  const evictFarthest = () => {
    const fromHistory = nextRedo.length === 0
      || (nextHistory.length > 0
        && stateByteLength(nextHistory[0]) >= stateByteLength(nextRedo[0]));
    const removed = fromHistory ? nextHistory.shift() : nextRedo.shift();
    totalBytes -= stateByteLength(removed);
  };
  while (nextHistory.length + nextRedo.length > maxEntries || totalBytes > maxTotalBytes) {
    evictFarthest();
  }
  return { history: nextHistory, redo: nextRedo };
};

export const pruneLyricsCheckpointHistory = (
  checkpoints,
  {
    maxEntries = MAX_LOCAL_LYRICS_CHECKPOINTS,
    maxStateBytes = MAX_LOCAL_LYRICS_HISTORY_STATE_BYTES,
    maxTotalBytes = MAX_LOCAL_LYRICS_CHECKPOINT_BYTES,
  } = {}
) => pruneLyricsHistoryStacks(checkpoints, [], {
  maxEntries,
  maxStateBytes,
  maxTotalBytes,
}).history;
