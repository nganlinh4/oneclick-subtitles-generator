import { invokeDesktop } from './desktopRuntime';
import { resolveProjectForCache } from './subtitleProjectStore';

export const MAX_PROJECT_AUXILIARY_BYTES = 900 * 1024;

const AUXILIARY_SCHEMA_VERSION = 1;
const AUXILIARY_KEY_PREFIX = 'project.legacyAux.v1.';

export class ProjectAuxiliaryStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectAuxiliaryStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

const cloneJson = (value, field) => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError('value is not representable as JSON');
    }
    return JSON.parse(encoded);
  } catch (cause) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData',
      `${field} must be JSON-serializable`,
      { field, cause }
    );
  }
};

const normalizeValue = (value) => {
  if (!value || value.schemaVersion !== AUXILIARY_SCHEMA_VERSION) {
    return {
      schemaVersion: AUXILIARY_SCHEMA_VERSION,
      userSubtitles: null,
      transcriptionRules: null,
    };
  }

  return {
    schemaVersion: AUXILIARY_SCHEMA_VERSION,
    userSubtitles: typeof value.userSubtitles === 'string' ? value.userSubtitles : null,
    transcriptionRules: value.transcriptionRules == null
      ? null
      : cloneJson(value.transcriptionRules, 'transcriptionRules'),
  };
};

const encodedLength = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const createProjectAuxiliaryStore = ({
  invokeCommand = invokeDesktop,
  resolveProject = resolveProjectForCache,
} = {}) => {
  let operationTail = Promise.resolve();

  const enqueue = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => undefined);
    return result;
  };

  const settingKey = (projectId) => `${AUXILIARY_KEY_PREFIX}${projectId}`;

  const resolve = async (cacheId, create) => {
    const project = await resolveProject(cacheId, { create });
    return project == null ? null : {
      ...project,
      key: settingKey(project.projectId),
    };
  };

  const read = (cacheId) => enqueue(async () => {
    const project = await resolve(cacheId, false);
    if (project === null) return null;
    return normalizeValue(await invokeCommand('setting_get', { key: project.key }));
  });

  const patch = (cacheId, changes) => enqueue(async () => {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      throw new ProjectAuxiliaryStoreError(
        'invalidProjectAuxiliaryData',
        'Project auxiliary changes must be an object'
      );
    }
    const unknown = Object.keys(changes).filter((key) => (
      key !== 'userSubtitles' && key !== 'transcriptionRules'
    ));
    if (unknown.length > 0) {
      throw new ProjectAuxiliaryStoreError(
        'invalidProjectAuxiliaryData',
        `Unsupported project auxiliary field: ${unknown[0]}`
      );
    }

    const project = await resolve(cacheId, true);
    const current = normalizeValue(await invokeCommand('setting_get', { key: project.key }));
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(changes, 'userSubtitles')) {
      const value = changes.userSubtitles;
      if (value !== null && typeof value !== 'string') {
        throw new ProjectAuxiliaryStoreError(
          'invalidProjectAuxiliaryData',
          'userSubtitles must be a string or null'
        );
      }
      next.userSubtitles = value;
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'transcriptionRules')) {
      next.transcriptionRules = changes.transcriptionRules == null
        ? null
        : cloneJson(changes.transcriptionRules, 'transcriptionRules');
    }

    if (next.userSubtitles === null && next.transcriptionRules === null) {
      await invokeCommand('setting_delete', { key: project.key });
      return next;
    }
    if (encodedLength(next) > MAX_PROJECT_AUXILIARY_BYTES) {
      throw new ProjectAuxiliaryStoreError(
        'projectAuxiliaryTooLarge',
        'Project auxiliary data is too large to persist safely'
      );
    }
    await invokeCommand('setting_set', { key: project.key, value: next });
    return next;
  });

  return Object.freeze({ read, patch });
};

const projectAuxiliaryStore = createProjectAuxiliaryStore();

export const readProjectAuxiliary = projectAuxiliaryStore.read;
export const patchProjectAuxiliary = projectAuxiliaryStore.patch;
