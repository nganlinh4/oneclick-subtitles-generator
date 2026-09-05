/** Provider timestamps are clip-local. Project them once; never infer origin from output values. */
export const projectClipSubtitles = (rows, segment) => {
  if (!Array.isArray(rows)) return [];
  const { start, end } = segment;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('Invalid subtitle projection range.');
  }
  return rows.filter(row => Number.isFinite(row.start) && Number.isFinite(row.end)
    && row.end > row.start && row.end > 0 && row.start < end - start)
    .map(row => ({ ...row, start: Math.max(start, start + row.start), end: Math.min(end, start + row.end) }));
};
