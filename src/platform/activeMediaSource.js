/**
 * The in-memory identity of the media the app is showing. It is never written to WebView storage:
 * the playback URL carries the media server's private token, and the native active-workspace
 * pointer (mirrored here as `session`) is the only relaunch authority.
 *
 *   - `sourceUrl`      the site URL a download came from, or null for local media;
 *   - `playbackUrl`    the native playback capability currently assigned to the player;
 *   - `session`        the validated `{ assetId, cacheId, projectId }` native pointer mirror.
 */
const MAX_TEXT_CHARACTERS = 8_192;
const FIELDS = Object.freeze(['sourceUrl', 'playbackUrl', 'session']);
const EMPTY = Object.freeze({
  sourceUrl: null,
  playbackUrl: null,
  session: null,
});

let state = EMPTY;
const listeners = new Set();

const optionalText = (value, field) => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_CHARACTERS) {
    throw new TypeError(`A valid active media ${field} is required`);
  }
  return value;
};

const publish = () => {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error('Active media listener failed:', error);
    }
  });
};

export const readActiveMedia = () => state;

/** Replace the named fields. `session` must already be validated by nativeMediaOwnership. */
export const updateActiveMedia = (patch) => {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).some((key) => !FIELDS.includes(key))) {
    throw new TypeError('An active media update names only known fields');
  }
  const next = { ...state };
  for (const [field, value] of Object.entries(patch)) {
    next[field] = field === 'session' ? (value ?? null) : optionalText(value ?? null, field);
  }
  if (FIELDS.every((field) => next[field] === state[field])) return state;
  state = Object.freeze(next);
  publish();
  return state;
};

export const subscribeActiveMedia = (listener) => {
  if (typeof listener !== 'function') throw new TypeError('An active media listener is required');
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Withdraw the visible media's source fields. The native session is owned by its own lifecycle. */
export const clearActiveMediaSource = () => {
  updateActiveMedia({ sourceUrl: null, playbackUrl: null });
};

/** Snapshot the source fields a URL publication overwrites, for an exact rollback. */
export const captureActiveMediaSource = () => Object.freeze({
  sourceUrl: state.sourceUrl,
  playbackUrl: state.playbackUrl,
});

export const restoreActiveMediaSource = (snapshot) => {
  updateActiveMedia({ sourceUrl: snapshot.sourceUrl, playbackUrl: snapshot.playbackUrl });
};

export const resetActiveMediaForTests = () => {
  state = EMPTY;
  listeners.clear();
};

if (typeof window !== 'undefined' && typeof __OSG_E2E_AUTOMATION__ !== 'undefined'
    && __OSG_E2E_AUTOMATION__) {
  window.__OSG_E2E_ACTIVE_MEDIA__ = () => state;
}
