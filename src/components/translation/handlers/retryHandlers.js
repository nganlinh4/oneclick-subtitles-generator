/**
 * Route retry requests into the project-owned revision/CAS path.
 *
 * Bulk results are batch-local presentation data and do not have a durable project revision.
 * Retrying them by preview array index would violate source ownership, so that legacy path is an
 * explicit no-op until batch results gain their own durable revision schema.
 */
export const handleRetrySegment = async (segment, { retryMainTranslation } = {}) => {
  const isBulkRetry = segment?.isFromBulk === true
    && typeof segment.fileId === 'string'
    && segment.fileId !== 'main';
  if (isBulkRetry) {
    return Object.freeze({
      status: 'unsupported',
      code: 'bulkRetryRequiresDurableRevision',
    });
  }
  if (typeof retryMainTranslation !== 'function') {
    return Object.freeze({
      status: 'invalid',
      code: 'translationRetryUnavailable',
    });
  }
  return retryMainTranslation(segment);
};
