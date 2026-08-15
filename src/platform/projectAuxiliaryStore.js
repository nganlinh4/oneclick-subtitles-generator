import { invokeDesktop } from './desktopRuntime';
import { resolveProjectForCache } from './subtitleProjectStore';
import { cloneTranslationRecord } from '../utils/translationOwnership';

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
  let descriptors = null;
  try {
    descriptors = value && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype
      ? Object.getOwnPropertyDescriptors(value)
      : null;
  } catch {
    descriptors = null;
  }
  const read = (key) => {
    const descriptor = descriptors?.[key];
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  };
  if (!descriptors || read('schemaVersion') !== AUXILIARY_SCHEMA_VERSION) {
    return {
      schemaVersion: AUXILIARY_SCHEMA_VERSION,
      userSubtitles: null,
      transcriptionRules: null,
      translation: null,
    };
  }

  let translation = null;
  try {
    const candidate = read('translation');
    translation = candidate == null ? null : cloneTranslationRecord(candidate);
  } catch {
    // An invalid nested record is ignored as a whole; it must never partially hydrate.
  }

  return {
    schemaVersion: AUXILIARY_SCHEMA_VERSION,
    userSubtitles: typeof read('userSubtitles') === 'string' ? read('userSubtitles') : null,
    transcriptionRules: read('transcriptionRules') == null
      ? null
      : cloneJson(read('transcriptionRules'), 'transcriptionRules'),
    translation,
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

  const resolve = async (cacheId, create, expectedProjectId = null) => {
    const project = await resolveProject(cacheId, { create });
    if (expectedProjectId !== null && project?.projectId !== expectedProjectId) {
      throw new ProjectAuxiliaryStoreError(
        'projectScopeMismatch',
        'The active auxiliary project changed before it could be accessed'
      );
    }
    return project == null ? null : {
      ...project,
      key: settingKey(project.projectId),
    };
  };

  const read = (cacheId, { expectedProjectId = null } = {}) => enqueue(async () => {
    const project = await resolve(cacheId, false, expectedProjectId);
    if (project === null) return null;
    const value = normalizeValue(await invokeCommand('setting_get', { key: project.key }));
    // The native read is an async ownership boundary. Re-resolve the alias before exposing it.
    await resolve(cacheId, false, project.projectId);
    return value;
  });

  const patch = (
    cacheId,
    changes,
    { expectedProjectId = null, expectedTranslationRevision = undefined } = {}
  ) => enqueue(async () => {
    let changeDescriptors = null;
    try {
      changeDescriptors = changes && typeof changes === 'object' && !Array.isArray(changes)
        && Object.getPrototypeOf(changes) === Object.prototype
        ? Object.getOwnPropertyDescriptors(changes)
        : null;
    } catch {
      changeDescriptors = null;
    }
    const changeKeys = changeDescriptors ? Reflect.ownKeys(changeDescriptors) : [];
    if (!changeDescriptors || changeKeys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.hasOwnProperty.call(changeDescriptors[key], 'value')
    ))) {
      throw new ProjectAuxiliaryStoreError(
        'invalidProjectAuxiliaryData',
        'Project auxiliary changes must be a plain data object'
      );
    }
    const readChange = (key) => changeDescriptors[key]?.value;
    const unknown = changeKeys.filter((key) => (
      key !== 'userSubtitles' && key !== 'transcriptionRules' && key !== 'translation'
    ));
    if (unknown.length > 0) {
      throw new ProjectAuxiliaryStoreError(
        'invalidProjectAuxiliaryData',
        `Unsupported project auxiliary field: ${unknown[0]}`
      );
    }

    // The expected ID is checked inside the same queued operation that chooses
    // the native settings key. A caller cannot validate one alias and then
    // accidentally write another project if the alias changes in between.
    const project = await resolve(cacheId, expectedProjectId === null, expectedProjectId);
    const current = normalizeValue(await invokeCommand('setting_get', { key: project.key }));
    if (expectedTranslationRevision !== undefined) {
      const currentRevision = current.translation?.revision ?? null;
      if (currentRevision !== expectedTranslationRevision) {
        throw new ProjectAuxiliaryStoreError(
          'translationRevisionConflict',
          'The durable translation changed before this revision could be saved',
          { currentRevision }
        );
      }
    }
    const next = { ...current };

    if (Object.prototype.hasOwnProperty.call(changeDescriptors, 'userSubtitles')) {
      const value = readChange('userSubtitles');
      if (value !== null && typeof value !== 'string') {
        throw new ProjectAuxiliaryStoreError(
          'invalidProjectAuxiliaryData',
          'userSubtitles must be a string or null'
        );
      }
      next.userSubtitles = value;
    }
    if (Object.prototype.hasOwnProperty.call(changeDescriptors, 'transcriptionRules')) {
      next.transcriptionRules = readChange('transcriptionRules') == null
        ? null
        : cloneJson(readChange('transcriptionRules'), 'transcriptionRules');
    }
    if (Object.prototype.hasOwnProperty.call(changeDescriptors, 'translation')) {
      next.translation = readChange('translation') == null
        ? null
        : cloneTranslationRecord(readChange('translation'));
    }

    if (next.userSubtitles === null && next.transcriptionRules === null
        && next.translation === null) {
      await invokeCommand('setting_delete', { key: project.key });
      await resolve(cacheId, false, project.projectId);
      return next;
    }
    if (encodedLength(next) > MAX_PROJECT_AUXILIARY_BYTES) {
      throw new ProjectAuxiliaryStoreError(
        'projectAuxiliaryTooLarge',
        'Project auxiliary data is too large to persist safely'
      );
    }
    await invokeCommand('setting_set', { key: project.key, value: next });
    // A successful setting write is not an acknowledgement for a remapped alias.
    await resolve(cacheId, false, project.projectId);
    return next;
  });

  return Object.freeze({ read, patch });
};

const projectAuxiliaryStore = createProjectAuxiliaryStore();

export const readProjectAuxiliary = projectAuxiliaryStore.read;
export const patchProjectAuxiliary = projectAuxiliaryStore.patch;
