// Shared IDs, snapshot builders and a deferred helper for the projectService test files.

export const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
export const PROJECT_B_ID = '01890f39-7b62-7c4e-8c9a-000000000201';
export const PROJECT_C_ID = '01890f39-7b62-7c4e-8c9a-000000000301';
export const REVISION_ONE = '01890f39-7b62-7c4e-8c9a-000000000102';
export const REVISION_TWO = '01890f39-7b62-7c4e-8c9a-000000000103';
export const REVISION_THREE = '01890f39-7b62-7c4e-8c9a-000000000106';
const TRACK_ID = '01890f39-7b62-7c4e-8c9a-000000000104';
const CUE_ID = '01890f39-7b62-7c4e-8c9a-000000000105';
export const TRACK_SELECTOR = Object.freeze({ label: 'Cached subtitles', origin: 'legacyJson' });

const snapshotFor = (id, stateVersion = 0, name = 'Example') => ({
  metadata: { id, name },
  stateVersion,
  media: [],
  tracks: [],
});
export const snapshot = (stateVersion = 0, name = 'Example') => (
  snapshotFor(PROJECT_ID, stateVersion, name)
);
export const snapshotB = (stateVersion = 0, name = 'Project B') => (
  snapshotFor(PROJECT_B_ID, stateVersion, name)
);
export const track = (text) => ({
  id: TRACK_ID,
  label: TRACK_SELECTOR.label,
  origin: TRACK_SELECTOR.origin,
  cues: [{
    id: CUE_ID,
    ordinal: 1,
    startMs: 0,
    endMs: 1_000,
    text,
    sourceId: null,
  }],
});
export const trackStatus = (stateVersion, historyVersion, undoReason = null, redoReason = null) => ({
  stateVersion,
  historyVersion,
  diverged: false,
  canUndo: undoReason !== null,
  canRedo: redoReason !== null,
  undoReason,
  redoReason,
});

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
