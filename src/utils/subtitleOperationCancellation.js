// A subtitle run the user stopped rejects with an AbortError; callers end it without an error notice.
export const isSubtitleOperationCancellation = (error) => error?.name === 'AbortError';
