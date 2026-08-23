import { getActiveProjectSnapshot } from './projectService';
import {
  loadExactProjectSubtitles,
  resolveProjectForCache,
} from './subtitleProjectStore';
import { patchProjectAuxiliary, readProjectAuxiliary } from './projectAuxiliaryStore';
import { getCurrentCacheId } from '../utils/userSubtitlesStore';
import {
  createGroupedSubtitles,
  fingerprintGroupingSource,
  normalizeGroupingIntensity,
  snapshotGroupingSource,
} from '../services/gemini/subtitleGroupingService';
import { acknowledgeJobResult, claimJobResult } from './jobResultDeliveryService';

const contexts = new WeakMap();
const receipts = new WeakMap();

export class ProjectSubtitleGroupingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProjectSubtitleGroupingError';
    this.code = code;
  }
}

const failed = (code, message) => new ProjectSubtitleGroupingError(code, message);

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const normalizeSourceType = (value) => {
  if (value !== 'original' && value !== 'translated') {
    throw failed('invalidSubtitleGroupingSource', 'Subtitle grouping source is invalid');
  }
  return value;
};

const requireActiveSnapshot = (getActiveSnapshot) => {
  const snapshot = getActiveSnapshot();
  if (!snapshot?.metadata?.id || !Number.isSafeInteger(snapshot.stateVersion)
      || snapshot.stateVersion < 0) {
    throw failed(
      'subtitleGroupingProjectUnavailable',
      'No exact active subtitle project is available for grouping'
    );
  }
  return snapshot;
};

export const createProjectSubtitleGroupingStore = ({
  getCacheId = getCurrentCacheId,
  getActiveSnapshot = getActiveProjectSnapshot,
  resolveProject = resolveProjectForCache,
  loadOriginalRows = loadExactProjectSubtitles,
  readAuxiliary = readProjectAuxiliary,
  patchAuxiliary = patchProjectAuxiliary,
  claimDelivery = claimJobResult,
  acknowledgeDelivery = acknowledgeJobResult,
} = {}) => {
  const resolveDurableRows = async (context) => {
    if (context.sourceType === 'original') {
      return loadOriginalRows(context.cacheId, context.projectId);
    }
    const auxiliary = await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    });
    const translation = auxiliary?.translation;
    if (translation?.status !== 'complete' || !Array.isArray(translation.baseSubtitles)) {
      throw failed(
        'subtitleGroupingSourceNotDurable',
        'Translated subtitles must be completely saved before grouping'
      );
    }
    return translation.baseSubtitles;
  };

  const assertIdentity = async (context, { verifySource = true } = {}) => {
    if (!contexts.has(context)) {
      throw failed('invalidSubtitleGroupingContext', 'A captured grouping context is required');
    }
    if (getCacheId() !== context.cacheId) {
      throw failed('subtitleGroupingProjectChanged', 'The active subtitle project changed');
    }
    const active = requireActiveSnapshot(getActiveSnapshot);
    if (active.metadata.id !== context.projectId || active.stateVersion !== context.projectStateVersion) {
      throw failed('subtitleGroupingProjectChanged', 'The active subtitle project changed');
    }
    const resolved = await resolveProject(context.cacheId, { create: false });
    if (resolved?.projectId !== context.projectId) {
      throw failed('subtitleGroupingProjectChanged', 'The subtitle project alias changed');
    }
    if (verifySource) {
      const durableRows = await resolveDurableRows(context);
      const fingerprint = await fingerprintGroupingSource(context.sourceType, durableRows);
      if (fingerprint !== context.sourceFingerprint) {
        throw failed('subtitleGroupingSourceChanged', 'The subtitle source changed during grouping');
      }
    }
    if (getCacheId() !== context.cacheId) {
      throw failed('subtitleGroupingProjectChanged', 'The active subtitle project changed');
    }
    const confirmed = requireActiveSnapshot(getActiveSnapshot);
    if (confirmed.metadata.id !== context.projectId
        || confirmed.stateVersion !== context.projectStateVersion) {
      throw failed('subtitleGroupingProjectChanged', 'The active subtitle project changed');
    }
    return context;
  };

  const capture = async ({ sourceType, subtitles, intensity }) => {
    const normalizedSourceType = normalizeSourceType(sourceType);
    const normalizedIntensity = normalizeGroupingIntensity(intensity);
    const cacheId = getCacheId();
    if (typeof cacheId !== 'string' || cacheId.length === 0 || cacheId.length > 8_192) {
      throw failed(
        'subtitleGroupingProjectUnavailable',
        'No exact subtitle cache is active for grouping'
      );
    }
    const active = requireActiveSnapshot(getActiveSnapshot);
    const sourceRows = snapshotGroupingSource(subtitles);
    const sourceFingerprint = await fingerprintGroupingSource(normalizedSourceType, sourceRows);
    const context = Object.freeze({
      kind: 'project-subtitle-grouping-context',
      cacheId,
      projectId: active.metadata.id,
      projectStateVersion: active.stateVersion,
      sourceType: normalizedSourceType,
      sourceFingerprint,
      intensity: normalizedIntensity,
      sourceRows,
    });
    contexts.set(context, true);
    try {
      await assertIdentity(context);
      return context;
    } catch (error) {
      contexts.delete(context);
      throw error;
    }
  };

  const normalizeResultRows = (context, result) => {
    if (!result || result.success !== true || !Array.isArray(result.groupedSubtitles)) {
      throw failed('invalidSubtitleGroupingResult', 'A complete provider grouping is required');
    }
    const positions = [];
    for (const row of result.groupedSubtitles) {
      if (!Array.isArray(row?.source_positions) || row.source_positions.length === 0) {
        throw failed('invalidSubtitleGroupingResult', 'Grouping source positions are missing');
      }
      positions.push(Object.freeze([...row.source_positions]));
    }
    let expectedPosition = 1;
    for (const group of positions) {
      for (const position of group) {
        if (!Number.isSafeInteger(position) || position !== expectedPosition) {
          throw failed(
            'invalidSubtitleGroupingResult',
            'Grouping is not an exact ordered source partition'
          );
        }
        expectedPosition += 1;
      }
    }
    if (expectedPosition !== context.sourceRows.length + 1) {
      throw failed('invalidSubtitleGroupingResult', 'Grouping omitted source subtitles');
    }
    const expectedRows = createGroupedSubtitles(context.sourceRows, positions);
    if (!sameJson(expectedRows, result.groupedSubtitles)) {
      throw failed(
        'invalidSubtitleGroupingResult',
        'Grouping rows do not match their exact source text and timing'
      );
    }
    return expectedRows;
  };

  const makeReceipt = (context, record, acknowledge) => {
    const receipt = Object.freeze({
      kind: 'subtitle-grouping-persistence-receipt',
      projectId: context.projectId,
      sourceFingerprint: context.sourceFingerprint,
      deliveryId: record.deliveryId,
    });
    receipts.set(receipt, Object.freeze({ context, record, acknowledge }));
    return receipt;
  };

  const persist = async (context, result) => {
    await assertIdentity(context);
    if (typeof result?.acknowledge !== 'function') {
      throw failed('invalidSubtitleGroupingDelivery', 'Grouping delivery cannot be acknowledged');
    }
    const groupedRows = normalizeResultRows(context, result);
    const record = {
      schemaVersion: 1,
      projectId: context.projectId,
      projectStateVersion: context.projectStateVersion,
      sourceType: context.sourceType,
      sourceFingerprint: context.sourceFingerprint,
      intensity: context.intensity,
      providerJobId: result.providerJobId,
      deliveryId: result.deliveryId,
      groupedRows,
    };
    await patchAuxiliary(
      context.cacheId,
      { grouping: record },
      { expectedProjectId: context.projectId }
    );
    await assertIdentity(context);
    const persisted = (await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    }))?.grouping;
    await assertIdentity(context);
    if (!sameJson(persisted, record)) {
      throw failed(
        'subtitleGroupingPersistenceMismatch',
        'Durable grouping does not match the accepted provider result'
      );
    }
    return makeReceipt(context, persisted, result.acknowledge);
  };

  const acknowledge = async (receipt) => {
    const owned = receipts.get(receipt);
    if (!owned) {
      throw failed(
        'invalidSubtitleGroupingPersistenceReceipt',
        'A genuine grouping persistence receipt is required'
      );
    }
    await assertIdentity(owned.context);
    await owned.acknowledge();
    await assertIdentity(owned.context);
    return owned.record;
  };

  const load = async ({ sourceType, subtitles, intensity, acknowledgePending = true }) => {
    const context = await capture({ sourceType, subtitles, intensity });
    const record = (await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    }))?.grouping ?? null;
    await assertIdentity(context);
    if (record === null || record.projectId !== context.projectId
        || record.sourceType !== context.sourceType
        || record.sourceFingerprint !== context.sourceFingerprint
        || record.intensity !== context.intensity) return null;
    const expectedRows = normalizeResultRows(context, {
      success: true,
      groupedSubtitles: record.groupedRows,
    });
    if (acknowledgePending) {
      const claimed = await claimDelivery(record.providerJobId);
      await assertIdentity(context);
      if (claimed !== null) {
        if (claimed.delivery?.deliveryId !== record.deliveryId
            || claimed.delivery?.jobId !== record.providerJobId
            || claimed.delivery?.projectId !== record.projectId) {
          throw failed(
            'subtitleGroupingDeliveryMismatch',
            'Pending grouping delivery does not match its durable record'
          );
        }
        await acknowledgeDelivery(record.providerJobId, record.deliveryId);
        await assertIdentity(context);
      }
    }
    return Object.freeze({ context, groupedSubtitles: expectedRows, record });
  };

  const clear = async ({ sourceType, subtitles, intensity }) => {
    const context = await capture({ sourceType, subtitles, intensity });
    await patchAuxiliary(
      context.cacheId,
      { grouping: null },
      { expectedProjectId: context.projectId }
    );
    await assertIdentity(context);
    const persisted = await readAuxiliary(context.cacheId, {
      expectedProjectId: context.projectId,
    });
    await assertIdentity(context);
    if (persisted?.grouping !== null) {
      throw failed('subtitleGroupingPersistenceMismatch', 'Grouping was not durably cleared');
    }
    return true;
  };

  return Object.freeze({ capture, assertIdentity, persist, acknowledge, load, clear });
};

const projectSubtitleGroupingStore = createProjectSubtitleGroupingStore();

export const captureProjectSubtitleGrouping = projectSubtitleGroupingStore.capture;
export const assertProjectSubtitleGroupingCurrent = projectSubtitleGroupingStore.assertIdentity;
export const persistProjectSubtitleGrouping = projectSubtitleGroupingStore.persist;
export const acknowledgeProjectSubtitleGrouping = projectSubtitleGroupingStore.acknowledge;
export const loadProjectSubtitleGrouping = projectSubtitleGroupingStore.load;
export const clearProjectSubtitleGrouping = projectSubtitleGroupingStore.clear;
