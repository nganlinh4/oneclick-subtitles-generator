import { invokeDesktop } from './desktopRuntime';
import { resolveProjectForCache } from './subtitleProjectStore';
import { cloneTranslationRecord } from '../utils/translationOwnership';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

export const MAX_PROJECT_AUXILIARY_BYTES = 900 * 1024;

const AUXILIARY_SCHEMA_VERSION = 1;
const AUXILIARY_KEY_PREFIX = 'project.legacyAux.v1.';
const ANALYSIS_SCHEMA_VERSION = 1;
const GROUPING_SCHEMA_VERSION = 1;
const LANGUAGE_DETECTION_SCHEMA_VERSION = 1;
const GROUPING_INTENSITIES = new Set([
  'minimal', 'light', 'balanced', 'moderate', 'enhanced', 'aggressive',
]);
const GROUPING_SOURCE_TYPES = new Set(['original', 'translated']);
const ANALYSIS_PRESET_IDS = new Set([
  'general',
  'focus-lyrics',
  'extract-text',
  'describe-video',
  'diarize-speakers',
  'chaptering',
  'translate-directly',
]);
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

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

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const ownDataObject = (value, field) => {
  let descriptors = null;
  try {
    descriptors = value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype
      ? Object.getOwnPropertyDescriptors(value)
      : null;
  } catch {
    descriptors = null;
  }
  if (!descriptors || Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== 'string'
    || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')
  ))) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', `${field} must be a plain data object`
    );
  }
  return descriptors;
};

const ownArrayValues = (value, field, maximum) => {
  let descriptors = null;
  try {
    descriptors = Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
      ? Object.getOwnPropertyDescriptors(value)
      : null;
  } catch {
    descriptors = null;
  }
  const length = descriptors?.length?.value;
  if (!descriptors || !Number.isSafeInteger(length) || length < 1 || length > maximum) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', `${field} must be a bounded plain array`
    );
  }
  const allowed = new Set(['length']);
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowed.add(key);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new ProjectAuxiliaryStoreError(
        'invalidProjectAuxiliaryData', `${field}[${index}] must be an own data value`
      );
    }
    values.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', `${field} has unsupported properties`
    );
  }
  return values;
};

const isGroupingIdentifier = (value) => Number.isSafeInteger(value)
  || (typeof value === 'string' && value.length > 0 && value.length <= 1_024);

const cloneGroupingRecord = (value) => {
  const descriptors = ownDataObject(value, 'grouping');
  const expectedKeys = [
    'schemaVersion', 'projectId', 'projectStateVersion', 'sourceType', 'sourceFingerprint',
    'intensity', 'providerJobId', 'deliveryId', 'groupedRows',
  ];
  const keys = Reflect.ownKeys(descriptors);
  const read = (key) => descriptors[key]?.value;
  if (keys.length !== expectedKeys.length
      || expectedKeys.some((key) => !descriptors[key])
      || read('schemaVersion') !== GROUPING_SCHEMA_VERSION
      || !isUuidV7(read('projectId'))
      || !Number.isSafeInteger(read('projectStateVersion'))
      || read('projectStateVersion') < 0
      || !GROUPING_SOURCE_TYPES.has(read('sourceType'))
      || typeof read('sourceFingerprint') !== 'string'
      || !/^[a-f0-9]{64}$/.test(read('sourceFingerprint'))
      || !GROUPING_INTENSITIES.has(read('intensity'))
      || !isUuidV7(read('providerJobId'))
      || !isUuidV7(read('deliveryId'))) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', 'grouping must be an exact project-owned provider result'
    );
  }

  let nextPosition = 1;
  const groupedRows = ownArrayValues(read('groupedRows'), 'grouping.groupedRows', 100_000)
    .map((row, index) => {
      const rowDescriptors = ownDataObject(row, `grouping.groupedRows[${index}]`);
      const rowKeys = [
        'subtitle_id', 'id', 'start', 'end', 'text', 'original_ids', 'source_positions',
      ];
      const rowRead = (key) => rowDescriptors[key]?.value;
      if (Reflect.ownKeys(rowDescriptors).length !== rowKeys.length
          || rowKeys.some((key) => !rowDescriptors[key])
          || rowRead('id') !== index + 1 || rowRead('subtitle_id') !== index + 1
          || !Number.isFinite(rowRead('start')) || rowRead('start') < 0
          || !Number.isFinite(rowRead('end')) || rowRead('end') <= rowRead('start')
          || typeof rowRead('text') !== 'string' || rowRead('text').trim().length === 0) {
        throw new ProjectAuxiliaryStoreError(
          'invalidProjectAuxiliaryData', 'grouping rows are invalid'
        );
      }
      const positions = ownArrayValues(
        rowRead('source_positions'), `grouping.groupedRows[${index}].source_positions`, 100_000
      );
      const originalIds = ownArrayValues(
        rowRead('original_ids'), `grouping.groupedRows[${index}].original_ids`, 100_000
      );
      if (positions.length !== originalIds.length
          || positions.some((position) => {
            const invalidPosition = !Number.isSafeInteger(position) || position !== nextPosition;
            nextPosition += 1;
            return invalidPosition;
          })
          || originalIds.some((id) => !isGroupingIdentifier(id))) {
        throw new ProjectAuxiliaryStoreError(
          'invalidProjectAuxiliaryData', 'grouping rows must partition their exact source positions'
        );
      }
      return {
        subtitle_id: index + 1,
        id: index + 1,
        start: rowRead('start'),
        end: rowRead('end'),
        text: rowRead('text'),
        original_ids: [...originalIds],
        source_positions: [...positions],
      };
    });
  const record = {
    schemaVersion: GROUPING_SCHEMA_VERSION,
    projectId: read('projectId'),
    projectStateVersion: read('projectStateVersion'),
    sourceType: read('sourceType'),
    sourceFingerprint: read('sourceFingerprint'),
    intensity: read('intensity'),
    providerJobId: read('providerJobId'),
    deliveryId: read('deliveryId'),
    groupedRows,
  };
  if (encodedLength(record) > 800 * 1024) {
    throw new ProjectAuxiliaryStoreError(
      'projectAuxiliaryTooLarge', 'Subtitle grouping data is too large to persist safely'
    );
  }
  return record;
};

const cloneLanguageResult = (value) => {
  const descriptors = ownDataObject(value, 'language result');
  const keys = ['languageCode', 'languageName', 'isMultiLanguage', 'secondaryLanguages'];
  const read = (key) => descriptors[key]?.value;
  if (Reflect.ownKeys(descriptors).length !== keys.length
      || keys.some((key) => !descriptors[key])
      || typeof read('languageCode') !== 'string'
      || !LANGUAGE_TAG.test(read('languageCode'))
      || typeof read('languageName') !== 'string'
      || read('languageName').trim().length === 0
      || read('languageName').length > 256
      || typeof read('isMultiLanguage') !== 'boolean'
      || !Array.isArray(read('secondaryLanguages'))
      || Object.getPrototypeOf(read('secondaryLanguages')) !== Array.prototype
      || read('secondaryLanguages').length > 32
      || read('secondaryLanguages').some((entry) => (
        typeof entry !== 'string' || !LANGUAGE_TAG.test(entry)
      ))) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', 'language detection result is invalid'
    );
  }
  const secondaryLanguages = [...read('secondaryLanguages')];
  if (new Set(secondaryLanguages.map((entry) => entry.toLowerCase())).size
        !== secondaryLanguages.length
      || secondaryLanguages.some((entry) => (
        entry.toLowerCase() === read('languageCode').toLowerCase()
      ))
      || read('isMultiLanguage') !== (secondaryLanguages.length > 0)) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', 'language detection result is inconsistent'
    );
  }
  return {
    languageCode: read('languageCode'),
    languageName: read('languageName').trim(),
    isMultiLanguage: read('isMultiLanguage'),
    secondaryLanguages,
  };
};

const cloneLanguageDetectionRecord = (value, sourceType) => {
  const descriptors = ownDataObject(value, `${sourceType} language detection`);
  const keys = [
    'schemaVersion', 'projectId', 'projectStateVersion', 'sourceType', 'sourceFingerprint',
    'providerJobId', 'deliveryId', 'result',
  ];
  const read = (key) => descriptors[key]?.value;
  if (Reflect.ownKeys(descriptors).length !== keys.length
      || keys.some((key) => !descriptors[key])
      || read('schemaVersion') !== LANGUAGE_DETECTION_SCHEMA_VERSION
      || !isUuidV7(read('projectId'))
      || !Number.isSafeInteger(read('projectStateVersion'))
      || read('projectStateVersion') < 0
      || read('sourceType') !== sourceType
      || typeof read('sourceFingerprint') !== 'string'
      || !/^[a-f0-9]{64}$/.test(read('sourceFingerprint'))
      || !isUuidV7(read('providerJobId'))
      || !isUuidV7(read('deliveryId'))) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', 'language detection record is invalid'
    );
  }
  return {
    schemaVersion: LANGUAGE_DETECTION_SCHEMA_VERSION,
    projectId: read('projectId'),
    projectStateVersion: read('projectStateVersion'),
    sourceType,
    sourceFingerprint: read('sourceFingerprint'),
    providerJobId: read('providerJobId'),
    deliveryId: read('deliveryId'),
    result: cloneLanguageResult(read('result')),
  };
};

const cloneLanguageDetections = (value) => {
  const descriptors = ownDataObject(value, 'language detections');
  if (Reflect.ownKeys(descriptors).length !== 2
      || !descriptors.original || !descriptors.translated) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData', 'language detections must name both sources'
    );
  }
  const clone = (sourceType) => {
    const candidate = descriptors[sourceType].value;
    return candidate === null ? null : cloneLanguageDetectionRecord(candidate, sourceType);
  };
  return { original: clone('original'), translated: clone('translated') };
};

const cloneAnalysisRecord = (value) => {
  const record = cloneJson(value, 'analysis');
  const keys = record && typeof record === 'object' && !Array.isArray(record)
    ? Object.keys(record)
    : [];
  const expectedKeys = [
    'schemaVersion',
    'sourceIdentity',
    'providerJobId',
    'deliveryId',
    'recommendedPresetId',
    'transcriptionRules',
  ];
  if (keys.length !== expectedKeys.length
      || !expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
      || record.schemaVersion !== ANALYSIS_SCHEMA_VERSION
      || typeof record.sourceIdentity !== 'string'
      || record.sourceIdentity.length === 0
      || record.sourceIdentity.length > 1_024
      || !isUuidV7(record.providerJobId)
      || !isUuidV7(record.deliveryId)
      || !ANALYSIS_PRESET_IDS.has(record.recommendedPresetId)
      || record.transcriptionRules === null
      || typeof record.transcriptionRules !== 'object'
      || Array.isArray(record.transcriptionRules)) {
    throw new ProjectAuxiliaryStoreError(
      'invalidProjectAuxiliaryData',
      'analysis must be an exact accepted provider result'
    );
  }
  return record;
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
      analysis: null,
      grouping: null,
      languageDetections: { original: null, translated: null },
    };
  }

  let translation = null;
  try {
    const candidate = read('translation');
    translation = candidate == null ? null : cloneTranslationRecord(candidate);
  } catch {
    // An invalid nested record is ignored as a whole; it must never partially hydrate.
  }

  let analysis = null;
  try {
    const candidate = read('analysis');
    analysis = candidate == null ? null : cloneAnalysisRecord(candidate);
  } catch {
    // An invalid accepted-analysis record is ignored as a whole; it never authorizes an ack.
  }

  let grouping = null;
  try {
    const candidate = read('grouping');
    grouping = candidate == null ? null : cloneGroupingRecord(candidate);
  } catch {
    // A malformed grouping cannot hydrate or authorize consumption of its provider delivery.
  }

  let languageDetections = { original: null, translated: null };
  try {
    const candidate = read('languageDetections');
    languageDetections = candidate == null
      ? languageDetections
      : cloneLanguageDetections(candidate);
  } catch {
    // A malformed language result cannot hydrate or authorize provider acknowledgement.
  }

  return {
    schemaVersion: AUXILIARY_SCHEMA_VERSION,
    userSubtitles: typeof read('userSubtitles') === 'string' ? read('userSubtitles') : null,
    transcriptionRules: read('transcriptionRules') == null
      ? null
      : cloneJson(read('transcriptionRules'), 'transcriptionRules'),
    translation,
    analysis,
    grouping,
    languageDetections,
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
      && key !== 'analysis' && key !== 'grouping' && key !== 'languageDetections'
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
    if (Object.prototype.hasOwnProperty.call(changeDescriptors, 'analysis')) {
      next.analysis = readChange('analysis') == null
        ? null
        : cloneAnalysisRecord(readChange('analysis'));
    }
    if (Object.prototype.hasOwnProperty.call(changeDescriptors, 'grouping')) {
      next.grouping = readChange('grouping') == null
        ? null
        : cloneGroupingRecord(readChange('grouping'));
    }
    if (Object.prototype.hasOwnProperty.call(changeDescriptors, 'languageDetections')) {
      next.languageDetections = cloneLanguageDetections(readChange('languageDetections'));
    }

    if (next.userSubtitles === null && next.transcriptionRules === null
        && next.translation === null && next.analysis === null && next.grouping === null
        && next.languageDetections.original === null
        && next.languageDetections.translated === null) {
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
