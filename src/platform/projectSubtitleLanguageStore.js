import { acknowledgeJobResult, claimJobResult } from './jobResultDeliveryService';
import { patchProjectAuxiliary, readProjectAuxiliary } from './projectAuxiliaryStore';
import { getActiveProjectSnapshot } from './projectService';
import {
  loadExactProjectSubtitles,
  resolveProjectForCache,
} from './subtitleProjectStore';
import {
  fingerprintGroupingSource,
  snapshotGroupingSource,
} from '../services/gemini/subtitleGroupingService';
import { getCurrentCacheId } from '../utils/userSubtitlesStore';

const contexts = new WeakSet();
const receipts = new WeakMap();
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_LANGUAGE_NAME = 256;
const MAX_SECONDARY_LANGUAGES = 32;

export class ProjectSubtitleLanguageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectSubtitleLanguageError';
    this.code = code;
  }
}

const failed = (code, message) => new ProjectSubtitleLanguageError(code, message);

const exactDataObject = (value, keys) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every((key) => Object.hasOwn(descriptors, key)
      && Object.hasOwn(descriptors[key], 'value'));
};

export const normalizeProjectLanguageResult = (value) => {
  const keys = ['languageCode', 'languageName', 'isMultiLanguage', 'secondaryLanguages'];
  if (!exactDataObject(value, keys)) {
    throw failed('invalidSubtitleLanguageResult', 'Language detection returned an invalid result');
  }
  const languageCode = value.languageCode.trim();
  const languageName = value.languageName.trim();
  if (!LANGUAGE_TAG.test(languageCode)
      || typeof value.languageName !== 'string'
      || languageName.length === 0 || languageName.length > MAX_LANGUAGE_NAME
      || typeof value.isMultiLanguage !== 'boolean'
      || !Array.isArray(value.secondaryLanguages)
      || value.secondaryLanguages.length > MAX_SECONDARY_LANGUAGES) {
    throw failed('invalidSubtitleLanguageResult', 'Language detection returned an invalid result');
  }
  const secondaryLanguages = value.secondaryLanguages.map((entry) => {
    if (typeof entry !== 'string') {
      throw failed('invalidSubtitleLanguageResult', 'Language detection returned an invalid result');
    }
    const normalized = entry.trim();
    if (!LANGUAGE_TAG.test(normalized)) {
      throw failed('invalidSubtitleLanguageResult', 'Language detection returned an invalid result');
    }
    return normalized;
  });
  if (new Set(secondaryLanguages.map((entry) => entry.toLowerCase())).size
      !== secondaryLanguages.length
      || secondaryLanguages.some((entry) => entry.toLowerCase() === languageCode.toLowerCase())
      || value.isMultiLanguage !== (secondaryLanguages.length > 0)) {
    throw failed('invalidSubtitleLanguageResult', 'Language detection returned an invalid result');
  }
  return Object.freeze({
    languageCode,
    languageName,
    isMultiLanguage: value.isMultiLanguage,
    secondaryLanguages: Object.freeze(secondaryLanguages),
  });
};

const requireSourceType = (value) => {
  if (value !== 'original' && value !== 'translated') {
    throw failed('invalidSubtitleLanguageSource', 'Language detection source is invalid');
  }
  return value;
};

const requireActive = (getActiveSnapshot) => {
  const active = getActiveSnapshot();
  if (!active?.metadata?.id || !Number.isSafeInteger(active.stateVersion)
      || active.stateVersion < 0) {
    throw failed('subtitleLanguageProjectUnavailable', 'No active subtitle project is available');
  }
  return active;
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export const createProjectSubtitleLanguageStore = ({
  getCacheId = getCurrentCacheId,
  getActiveSnapshot = getActiveProjectSnapshot,
  resolveProject = resolveProjectForCache,
  loadOriginalRows = loadExactProjectSubtitles,
  readAuxiliary = readProjectAuxiliary,
  patchAuxiliary = patchProjectAuxiliary,
  claimDelivery = claimJobResult,
  acknowledgeDelivery = acknowledgeJobResult,
} = {}) => {
  const durableRows = async (context) => {
    if (context.sourceType === 'original') {
      return loadOriginalRows(context.cacheId, context.projectId);
    }
    const auxiliary = await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    });
    if (auxiliary?.translation?.status !== 'complete'
        || !Array.isArray(auxiliary.translation.baseSubtitles)) {
      throw failed(
        'subtitleLanguageSourceNotDurable',
        'Translated subtitles must be completely saved before language detection'
      );
    }
    return auxiliary.translation.baseSubtitles;
  };

  const assertCurrent = async (context) => {
    if (!contexts.has(context)) {
      throw failed('invalidSubtitleLanguageContext', 'A captured language context is required');
    }
    const active = requireActive(getActiveSnapshot);
    if (getCacheId() !== context.cacheId || active.metadata.id !== context.projectId
        || active.stateVersion !== context.projectStateVersion) {
      throw failed('subtitleLanguageProjectChanged', 'The active subtitle project changed');
    }
    const resolved = await resolveProject(context.cacheId, { create: false });
    if (resolved?.projectId !== context.projectId) {
      throw failed('subtitleLanguageProjectChanged', 'The subtitle project alias changed');
    }
    const fingerprint = await fingerprintGroupingSource(
      context.sourceType,
      await durableRows(context)
    );
    if (fingerprint !== context.sourceFingerprint) {
      throw failed('subtitleLanguageSourceChanged', 'The subtitle source changed');
    }
    const confirmed = requireActive(getActiveSnapshot);
    if (getCacheId() !== context.cacheId || confirmed.metadata.id !== context.projectId
        || confirmed.stateVersion !== context.projectStateVersion) {
      throw failed('subtitleLanguageProjectChanged', 'The active subtitle project changed');
    }
    return context;
  };

  const capture = async ({ sourceType, subtitles }) => {
    const normalizedSource = requireSourceType(sourceType);
    const cacheId = getCacheId();
    if (typeof cacheId !== 'string' || cacheId.length === 0 || cacheId.length > 8_192) {
      throw failed('subtitleLanguageProjectUnavailable', 'No subtitle cache is active');
    }
    const active = requireActive(getActiveSnapshot);
    const sourceRows = snapshotGroupingSource(subtitles);
    const context = Object.freeze({
      kind: 'project-subtitle-language-context',
      cacheId,
      projectId: active.metadata.id,
      projectStateVersion: active.stateVersion,
      sourceType: normalizedSource,
      sourceFingerprint: await fingerprintGroupingSource(normalizedSource, sourceRows),
    });
    contexts.add(context);
    try {
      await assertCurrent(context);
      return context;
    } catch (error) {
      contexts.delete(context);
      throw error;
    }
  };

  const persist = async (context, provider) => {
    await assertCurrent(context);
    if (typeof provider?.job?.id !== 'string' || typeof provider.deliveryId !== 'string'
        || typeof provider.acknowledge !== 'function') {
      throw failed('invalidSubtitleLanguageDelivery', 'Language delivery is invalid');
    }
    const result = normalizeProjectLanguageResult(provider.result);
    const record = {
      schemaVersion: 1,
      projectId: context.projectId,
      projectStateVersion: context.projectStateVersion,
      sourceType: context.sourceType,
      sourceFingerprint: context.sourceFingerprint,
      providerJobId: provider.job.id,
      deliveryId: provider.deliveryId,
      result,
    };
    const existing = (await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    }))?.languageDetections ?? { original: null, translated: null };
    await patchAuxiliary(context.cacheId, {
      languageDetections: { ...existing, [context.sourceType]: record },
    }, { expectedProjectId: context.projectId });
    await assertCurrent(context);
    const stored = (await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    }))?.languageDetections?.[context.sourceType] ?? null;
    await assertCurrent(context);
    if (!sameJson(stored, record)) {
      throw failed('subtitleLanguagePersistenceMismatch', 'Saved language result changed');
    }
    const receipt = Object.freeze({
      kind: 'project-subtitle-language-receipt',
      projectId: context.projectId,
      sourceType: context.sourceType,
      deliveryId: provider.deliveryId,
    });
    receipts.set(receipt, { context, record: stored, acknowledge: provider.acknowledge });
    return receipt;
  };

  const acknowledge = async (receipt) => {
    const owned = receipts.get(receipt);
    if (!owned) {
      throw failed('invalidSubtitleLanguageReceipt', 'A genuine language receipt is required');
    }
    await assertCurrent(owned.context);
    await owned.acknowledge();
    await assertCurrent(owned.context);
    return owned.record;
  };

  const load = async ({ sourceType, subtitles, acknowledgePending = true }) => {
    const context = await capture({ sourceType, subtitles });
    const record = (await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    }))?.languageDetections?.[context.sourceType] ?? null;
    await assertCurrent(context);
    if (record === null || record.projectId !== context.projectId
        || record.projectStateVersion !== context.projectStateVersion
        || record.sourceFingerprint !== context.sourceFingerprint) return null;
    const result = normalizeProjectLanguageResult(record.result);
    if (acknowledgePending) {
      const pending = await claimDelivery(record.providerJobId);
      await assertCurrent(context);
      if (pending !== null) {
        if (pending.delivery?.jobId !== record.providerJobId
            || pending.delivery?.deliveryId !== record.deliveryId
            || pending.delivery?.projectId !== record.projectId) {
          throw failed('subtitleLanguageDeliveryMismatch', 'Pending language delivery changed');
        }
        await acknowledgeDelivery(record.providerJobId, record.deliveryId);
        await assertCurrent(context);
      }
    }
    return Object.freeze({ context, record, result });
  };

  return Object.freeze({ capture, assertCurrent, persist, acknowledge, load });
};

const store = createProjectSubtitleLanguageStore();

export const captureProjectSubtitleLanguage = store.capture;
export const assertProjectSubtitleLanguageCurrent = store.assertCurrent;
export const persistProjectSubtitleLanguage = store.persist;
export const acknowledgeProjectSubtitleLanguage = store.acknowledge;
export const loadProjectSubtitleLanguage = store.load;
