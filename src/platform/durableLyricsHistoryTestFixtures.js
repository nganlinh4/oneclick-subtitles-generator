// Shared row, status and deferred helpers for the durableLyricsHistory tests.

export const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

export const rows = (text) => [{ id: 1, start: 0, end: 1, text }];
export const editorStatus = (
  undoReason = null,
  redoReason = null,
  stateVersion = 1,
  historyVersion = stateVersion
) => ({
  stateVersion,
  historyVersion,
  diverged: false,
  canUndo: undoReason !== null,
  canRedo: redoReason !== null,
  undoReason,
  redoReason,
});
