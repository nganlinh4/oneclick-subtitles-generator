// Pure helpers for translation runs: run IDs, terminal records and commits.
import {
  assertTranslationPersistenceReceipt,
  persistTranslationForIdentity,
} from '../platform/translationPersistence';
import {
  TRANSLATION_SCHEMA_VERSION,
  assertTranslationTerminalMatchesSource,
  snapshotTranslationSource,
} from '../utils/translationOwnership';

let translationRunSequence = 0;
export const nextRunId = () => {
  translationRunSequence = (translationRunSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `translation-${Date.now().toString(36)}-${translationRunSequence.toString(36)}`;
};

export const callCompletion = (callback, subtitles) => {
  try {
    callback?.(subtitles);
  } catch {
    // Downstream notification failure cannot reverse an acknowledged translation.
  }
};

export const isAbort = (error) => error?.name === 'AbortError'
  || error?.code === 'translationAborted'
  || error?.code === 'projectScopeMismatch';

export const buildTerminal = ({
  sourceFingerprint,
  sourceEntryCount,
  languageChain,
  model,
  status,
  rows,
  failures = [],
}) => ({
  schemaVersion: TRANSLATION_SCHEMA_VERSION,
  sourceFingerprint,
  sourceEntryCount,
  languageChain,
  model,
  status,
  baseSubtitles: rows,
  failedChunks: failures,
});

export const partialRowsForPresentation = (record, sourceSubtitles) => {
  const translatedByOrder = new Map(record.baseSubtitles.map((row) => [row.sourceOrder, row]));
  const failureByOrder = new Map();
  for (const failure of record.failedChunks) {
    for (let order = failure.startOrder; order <= failure.endOrder; order += 1) {
      failureByOrder.set(order, failure.errorCode);
    }
  }
  return sourceSubtitles.map((source, sourceOrder) => translatedByOrder.get(sourceOrder) ?? {
    ...source,
    sourceOrder,
    translationFailed: true,
    translationErrorCode: failureByOrder.get(sourceOrder) ?? 'translationChunkFailed',
  });
};

export const failuresAfterRetry = (record, replacements) => {
  const replacedOrders = new Set(replacements.map((row) => row.sourceOrder));
  const remaining = [];
  for (const failure of record.failedChunks) {
    let rangeStart = null;
    for (let order = failure.startOrder; order <= failure.endOrder + 1; order += 1) {
      const remainsFailed = order <= failure.endOrder && !replacedOrders.has(order);
      if (remainsFailed && rangeStart === null) rangeStart = order;
      if (!remainsFailed && rangeStart !== null) {
        remaining.push({
          chunkIndex: remaining.length,
          startOrder: rangeStart,
          endOrder: order - 1,
          errorCode: failure.errorCode,
        });
        rangeStart = null;
      }
    }
  }
  return remaining;
};

export const requireCompleteTranslationResult = (value) => {
  if (!value || value.status !== 'complete'
      || !Array.isArray(value.rows)
      || !Array.isArray(value.deliveries)
      || value.deliveries.some((delivery) => typeof delivery?.acknowledge !== 'function')) {
    throw new TypeError('Translation returned an invalid owned result');
  }
  return value;
};

export const acknowledgePersistedDeliveries = async (deliveries) => {
  const outcomes = await Promise.allSettled(deliveries.map((delivery) => (
    Promise.resolve().then(() => delivery.acknowledge())
  )));
  return Object.freeze({
    attempted: outcomes.length,
    pending: outcomes.filter((outcome) => outcome.status === 'rejected').length,
  });
};

export const languageOptionsFromChain = (chain) => {
  const languages = chain
    .filter((item) => item.type === 'language' && !item.isOriginal)
    .map((item) => item.value.trim())
    .filter(Boolean);
  const delimiter = chain.find((item) => item.type === 'delimiter') ?? null;
  return {
    languages,
    delimiter: delimiter?.value ?? ' ',
    bracketStyle: delimiter?.style ?? null,
    useParentheses: Boolean(delimiter?.style?.open || delimiter?.style?.close),
  };
};

export const snapshotBulkTranslationSource = (files) => {
  const rows = [];
  files.forEach((file, fileIndex) => {
    const fileRows = snapshotTranslationSource(file?.subtitles);
    const fileName = typeof file?.name === 'string' ? file.name : `file-${fileIndex}`;
    rows.push({
      id: `bulk-file:${fileIndex}`,
      start: 0,
      end: 0,
      text: fileName,
    });
    fileRows.forEach((row) => {
      rows.push({
        id: `bulk:${fileIndex}:${row.originalId}`,
        start: row.start,
        end: row.end,
        text: row.text,
      });
    });
  });
  return snapshotTranslationSource(rows);
};

/**
 * Persist a validated terminal for the run's identity, then acknowledge its provider deliveries.
 * Ownership is re-asserted after every await so a lost run never publishes a receipt.
 */
export const persistOwnedTranslationTerminal = async ({
  context,
  terminal,
  deliveries,
  assertRunOwned,
}) => {
  assertTranslationTerminalMatchesSource(terminal, context.sourceSubtitles);
  await assertRunOwned(context);
  const receipt = await persistTranslationForIdentity(context.identity, terminal);
  await assertRunOwned(context);
  const acknowledged = assertTranslationPersistenceReceipt(receipt, context.identity, {
    sourceFingerprint: context.sourceFingerprint,
    status: terminal.status,
  });
  assertTranslationPersistenceReceipt(receipt, context.identity, {
    revision: acknowledged.record.revision,
    sourceFingerprint: context.sourceFingerprint,
    status: terminal.status,
  });
  await assertRunOwned(context);
  const deliveryAcknowledgement = await acknowledgePersistedDeliveries(deliveries);
  await assertRunOwned(context);
  return { receipt, acknowledged, deliveryAcknowledgement };
};
