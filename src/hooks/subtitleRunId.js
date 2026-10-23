// Run identifiers for subtitle generation and retry runs.
export const createSubtitleRunId = () => (
    typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2, 10)
);
