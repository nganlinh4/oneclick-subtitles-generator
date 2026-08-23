import {
  isDurableSubtitleCheckpointReceipt,
  isSuccessfulSubtitleCacheSaveReceipt,
} from '../subtitleCache';

const deliveriesByRows = new WeakMap();
const pendingAcknowledgements = new Map();

const deliveryKey = ({ jobId, deliveryId }) => `${jobId}\u0000${deliveryId}`;

const normalizeDelivery = (value) => {
  if (!value || typeof value !== 'object'
      || typeof value.jobId !== 'string' || value.jobId.length === 0
      || typeof value.deliveryId !== 'string' || value.deliveryId.length === 0
      || typeof value.acknowledge !== 'function') {
    throw new TypeError('Native Gemini transcription returned invalid delivery ownership');
  }
  return Object.freeze({
    jobId: value.jobId,
    deliveryId: value.deliveryId,
    acknowledge: value.acknowledge,
  });
};

const uniqueDeliveries = (values) => {
  const unique = new Map();
  for (const value of values) {
    const delivery = normalizeDelivery(value);
    unique.set(deliveryKey(delivery), delivery);
  }
  return Object.freeze([...unique.values()]);
};

/**
 * Provider delivery capabilities live beside an array in a WeakMap. They are never properties of
 * subtitle rows, so JSON serialization and native project persistence cannot copy closures or job
 * capabilities into the user's subtitle track.
 */
export const bindGeminiTranscriptionDeliveries = (rows, ...sources) => {
  if (!Array.isArray(rows)) {
    throw new TypeError('Gemini transcription subtitles must be an array');
  }
  const deliveries = uniqueDeliveries(sources.flatMap((source) => (
    Array.isArray(source)
      ? (deliveriesByRows.get(source) ?? [])
      : source === null || source === undefined
        ? []
        : [source]
  )));
  if (deliveries.length > 0) deliveriesByRows.set(rows, deliveries);
  return rows;
};

export const getGeminiTranscriptionDeliveries = (rows) => (
  Array.isArray(rows) ? (deliveriesByRows.get(rows) ?? Object.freeze([])) : Object.freeze([])
);

export const bindNativeGeminiTranscriptionDelivery = (rows, nativeResult) => {
  if (typeof nativeResult?.job?.id !== 'string' || nativeResult.job.id.length === 0) {
    // Job and delivery identifiers are intentionally different; both are retained exactly.
    throw new TypeError('Native Gemini transcription returned invalid delivery ownership');
  }
  return bindGeminiTranscriptionDeliveries(rows, {
    jobId: nativeResult.job.id,
    deliveryId: nativeResult.deliveryId,
    acknowledge: nativeResult.acknowledge,
  });
};

const checkpointMatches = ({ receipt, context, subtitleCount }) => {
  if (!Number.isSafeInteger(subtitleCount) || subtitleCount < 0) return false;
  if (context !== null && isDurableSubtitleCheckpointReceipt(receipt, context)) {
    return receipt.subtitleCount === subtitleCount;
  }
  return isSuccessfulSubtitleCacheSaveReceipt(receipt)
    && receipt.subtitleCount === subtitleCount
    && receipt.cacheId === context?.cacheId
    && receipt.projectId === context?.projectId;
};

const publicPending = (entry) => Object.freeze({
  jobId: entry.delivery.jobId,
  deliveryId: entry.delivery.deliveryId,
  cacheId: entry.context.cacheId,
  projectId: entry.context.projectId,
});

/**
 * Consume native provider results only after an authentic native subtitle checkpoint. A transport
 * failure leaves the exact capability in memory and the native outbox remains unacknowledged, so a
 * retry cannot cause a second provider call in this session.
 */
export const acknowledgeGeminiTranscriptionDeliveries = async ({
  rows,
  receipt,
  context,
  validateOwnership,
}) => {
  const deliveries = getGeminiTranscriptionDeliveries(rows);
  if (deliveries.length === 0) {
    return Object.freeze({ acknowledged: true, pending: Object.freeze([]) });
  }
  if (!context || typeof context.cacheId !== 'string' || typeof context.projectId !== 'string'
      || typeof validateOwnership !== 'function'
      || !checkpointMatches({ receipt, context, subtitleCount: rows.length })) {
    throw new TypeError('Gemini transcription cannot be acknowledged without its exact checkpoint');
  }

  for (const delivery of deliveries) {
    pendingAcknowledgements.set(deliveryKey(delivery), { delivery, receipt, context });
  }

  const failed = [];
  for (const delivery of deliveries) {
    try {
      await validateOwnership(context);
      if (!checkpointMatches({ receipt, context, subtitleCount: rows.length })) {
        throw new TypeError('Gemini transcription checkpoint ownership was lost');
      }
      await delivery.acknowledge();
      pendingAcknowledgements.delete(deliveryKey(delivery));
    } catch {
      failed.push(publicPending({ delivery, context }));
    }
  }
  return Object.freeze({
    acknowledged: failed.length === 0,
    pending: Object.freeze(failed),
  });
};

export const listPendingGeminiTranscriptionDeliveries = () => Object.freeze(
  [...pendingAcknowledgements.values()].map(publicPending)
);

export const retryPendingGeminiTranscriptionDeliveries = async ({
  cacheId,
  projectId,
  validateOwnership,
}) => {
  if (typeof validateOwnership !== 'function') {
    throw new TypeError('Gemini transcription acknowledgement retry requires project validation');
  }
  const matching = [...pendingAcknowledgements.values()].filter(({ context }) => (
    context.cacheId === cacheId && context.projectId === projectId
  ));
  const failed = [];
  for (const entry of matching) {
    try {
      await validateOwnership(entry.context);
      await entry.delivery.acknowledge();
      pendingAcknowledgements.delete(deliveryKey(entry.delivery));
    } catch {
      failed.push(publicPending(entry));
    }
  }
  return Object.freeze({
    acknowledged: failed.length === 0,
    pending: Object.freeze(failed),
  });
};
