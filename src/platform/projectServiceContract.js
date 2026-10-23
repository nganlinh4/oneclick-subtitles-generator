// Project command errors and the validators/normalizers for project command arguments and
// desktop-host replies. Pure: no IPC and no service state.
import { isUuidV7, normalizeProjectSnapshot } from './projectSnapshotAdapter';

export const STALE_PROJECT_VERSION = 'staleProjectVersion';
export const PROJECT_COMMAND_OUTCOME_UNCERTAIN = 'projectCommandOutcomeUncertain';

export class ProjectServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectServiceError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class ProjectConflictError extends ProjectServiceError {
  constructor(projectId, authoritativeSnapshot, cause) {
    super(
      STALE_PROJECT_VERSION,
      'The project changed since it was opened. The current project has been reloaded.',
      { projectId, authoritativeSnapshot, cause }
    );
    this.name = 'ProjectConflictError';
  }
}

const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});
const TRACK_ORIGINS = new Set(['legacyJson', 'srt']);
export const TRACK_HISTORY_CONFLICT_CODES = new Set([
  'staleProjectTrackHistory',
  'projectTrackHistoryDiverged',
]);
export const MUTATING_PROJECT_COMMANDS = new Set([
  'project_commit',
  'project_undo',
  'project_redo',
  'project_track_commit',
  'project_track_undo',
  'project_track_redo',
]);

export const validateProjectId = (id) => {
  if (!isUuidV7(id)) {
    throw new ProjectServiceError('invalidProjectId', 'A valid UUIDv7 project ID is required');
  }
  return id;
};

export const validateProjectName = (name) => {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ProjectServiceError('invalidProjectName', 'A project name is required');
  }
  if (Array.from(name.trim()).length > 200 || hasControlCharacter(name)) {
    throw new ProjectServiceError('invalidProjectName', 'The project name is invalid');
  }
  return name;
};

export const validateProjectCreateKey = (idempotencyKey) => {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0
      || idempotencyKey.length > 8_192
      || Array.from(idempotencyKey).some(character => /\p{Cc}/u.test(character))) {
    throw new ProjectServiceError(
      'invalidProjectCreateKey',
      'A bounded stable project create identity is required'
    );
  }
  return idempotencyKey;
};

export const validateReason = (reason) => {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ProjectServiceError('invalidRevisionReason', 'A revision reason is required');
  }
  if (Array.from(reason.trim()).length > 500 || hasControlCharacter(reason)) {
    throw new ProjectServiceError('invalidRevisionReason', 'The revision reason is invalid');
  }
  return reason;
};

export const validateCommit = (commit, expectedVersion) => {
  if (!commit || !isUuidV7(commit.revisionId)
      || !Number.isSafeInteger(commit.stateVersion)
      || commit.stateVersion !== expectedVersion + 1) {
    throw new ProjectServiceError(
      'invalidProjectCommit',
      'The desktop host returned an invalid project commit result'
    );
  }
  return commit;
};

const normalizeHistoryReason = (value, field) => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0
      || Array.from(value).length > 500 || hasControlCharacter(value)) {
    throw new ProjectServiceError(
      'invalidProjectHistoryStatus',
      `The desktop host returned an invalid ${field}`
    );
  }
  return value;
};

export const normalizeHistoryStatus = (status) => {
  if (!status || typeof status !== 'object' || Array.isArray(status)
      || !Number.isSafeInteger(status.stateVersion) || status.stateVersion < 0
      || typeof status.canUndo !== 'boolean' || typeof status.canRedo !== 'boolean') {
    throw new ProjectServiceError(
      'invalidProjectHistoryStatus',
      'The desktop host returned an invalid project history status'
    );
  }
  const undoReason = normalizeHistoryReason(status.undoReason, 'undo reason');
  const redoReason = normalizeHistoryReason(status.redoReason, 'redo reason');
  if (status.canUndo !== (undoReason !== null) || status.canRedo !== (redoReason !== null)) {
    throw new ProjectServiceError(
      'invalidProjectHistoryStatus',
      'The desktop host returned an inconsistent project history status'
    );
  }
  return Object.freeze({
    stateVersion: status.stateVersion,
    canUndo: status.canUndo,
    canRedo: status.canRedo,
    undoReason,
    redoReason,
  });
};

export const normalizeTrackSelector = (selector) => {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)
      || typeof selector.label !== 'string' || selector.label.trim().length === 0
      || Array.from(selector.label.trim()).length > 200
      || hasControlCharacter(selector.label)
      || !TRACK_ORIGINS.has(selector.origin)) {
    throw new ProjectServiceError(
      'invalidProjectTrackSelector',
      'A valid project track selector is required'
    );
  }
  return Object.freeze({ label: selector.label.trim(), origin: selector.origin });
};

export const normalizeStandaloneTrack = (track, projectId) => {
  if (track === null) return null;
  return normalizeProjectSnapshot({
    metadata: { id: projectId, name: 'Track validation' },
    stateVersion: 0,
    media: [],
    tracks: [track],
  }).tracks[0];
};

export const normalizeTrackHistoryStatus = (status) => {
  if (!status || typeof status !== 'object' || Array.isArray(status)
      || !Number.isSafeInteger(status.stateVersion) || status.stateVersion < 0
      || !Number.isSafeInteger(status.historyVersion) || status.historyVersion < 0
      || typeof status.diverged !== 'boolean'
      || typeof status.canUndo !== 'boolean' || typeof status.canRedo !== 'boolean') {
    throw new ProjectServiceError(
      'invalidProjectTrackHistoryStatus',
      'The desktop host returned an invalid project track history status'
    );
  }
  const undoReason = normalizeHistoryReason(status.undoReason, 'track undo reason');
  const redoReason = normalizeHistoryReason(status.redoReason, 'track redo reason');
  if (status.canUndo !== (undoReason !== null) || status.canRedo !== (redoReason !== null)
      || (status.diverged && (status.canUndo || status.canRedo))) {
    throw new ProjectServiceError(
      'invalidProjectTrackHistoryStatus',
      'The desktop host returned an inconsistent project track history status'
    );
  }
  return Object.freeze({
    stateVersion: status.stateVersion,
    historyVersion: status.historyVersion,
    diverged: status.diverged,
    canUndo: status.canUndo,
    canRedo: status.canRedo,
    undoReason,
    redoReason,
  });
};

export const isStaleVersionError = (error) => error?.code === STALE_PROJECT_VERSION;

export const freezeTree = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeTree);
  return Object.freeze(value);
};

export const copySnapshot = (snapshot) => (
  snapshot == null ? null : freezeTree(normalizeProjectSnapshot(snapshot))
);
