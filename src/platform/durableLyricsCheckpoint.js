const ACTIVE_FLUSHERS = new Set();

/** Register one mounted durable editor owner with the process-wide checkpoint coordinator. */
export const registerDurableLyricsHistoryFlusher = (flusher) => {
  if (typeof flusher !== 'function') throw new TypeError('A durable history flusher is required');
  ACTIVE_FLUSHERS.add(flusher);
  return () => ACTIVE_FLUSHERS.delete(flusher);
};

/** Await every mounted editor owner without depending on React state or DOM event delivery. */
export const flushDurableLyricsHistory = async () => {
  await Promise.all([...ACTIVE_FLUSHERS].map((flusher) => flusher()));
};
