import {
  getNativeNarrationArtifactId,
  isNativeNarrationResult,
} from './nativeNarrationCapabilities';

export const NATIVE_NARRATION_EDIT_COMMIT_EVENT = 'osg:native-narration-edit-commit';

const requests = new WeakMap();

export class NativeNarrationEditCommitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeNarrationEditCommitError';
    this.code = code;
  }
}

const failed = (code, message) => new NativeNarrationEditCommitError(code, message);

/**
 * Deliver one immutable edited artifact to the mounted project owner and await its durable commit.
 * A DOM event is only the rendezvous: the opaque request can be claimed exactly once and the
 * producer does not receive success until the owner's promise resolves.
 */
const prepareEdits = (edits) => {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const previousIds = new Set();
  const replacementIds = new Set();
  const prepared = [];
  for (const edit of edits) {
    const previousArtifactId = getNativeNarrationArtifactId(edit?.previous);
    const replacementArtifactId = getNativeNarrationArtifactId(edit?.replacement);
    if (!previousArtifactId
        || !replacementArtifactId
        || !isNativeNarrationResult(edit.replacement)
        || previousArtifactId === replacementArtifactId
        || previousIds.has(previousArtifactId)
        || replacementIds.has(replacementArtifactId)) return null;
    previousIds.add(previousArtifactId);
    replacementIds.add(replacementArtifactId);
    prepared.push(Object.freeze({
      previousArtifactId,
      replacement: edit.replacement,
    }));
  }
  return Object.freeze(prepared);
};

export const commitNativeNarrationEdits = (edits) => {
  const prepared = prepareEdits(edits);
  if (!prepared) {
    return Promise.reject(failed(
      'invalidNarrationEditCommit',
      'One or more distinct native narration edit results are required'
    ));
  }
  const request = Object.freeze({
    kind: 'native-narration-edit-commit',
    edits: prepared,
  });
  const state = { claimed: false, promise: null };
  requests.set(request, state);
  window.dispatchEvent(new CustomEvent(NATIVE_NARRATION_EDIT_COMMIT_EVENT, { detail: request }));
  if (!state.claimed || state.promise === null) {
    requests.delete(request);
    return Promise.reject(failed(
      'narrationEditOwnerUnavailable',
      'The narration project owner is unavailable'
    ));
  }
  return state.promise.finally(() => requests.delete(request));
};

export const commitNativeNarrationEdit = (previous, replacement) => (
  commitNativeNarrationEdits([{ previous, replacement }])
    .then((replacements) => replacements[0])
);

export const claimNativeNarrationEditCommit = (request, handler) => {
  const state = request && typeof request === 'object' ? requests.get(request) : null;
  if (!state || state.claimed || typeof handler !== 'function') return false;
  state.claimed = true;
  state.promise = Promise.resolve().then(() => handler(request.edits));
  return true;
};
