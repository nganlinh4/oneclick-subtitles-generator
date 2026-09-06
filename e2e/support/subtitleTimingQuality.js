// Text alignment first, time comparison second. Never pair subtitles by array index.
const tokens = text => String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((sorted.length - 1) * q)];
};
const stats = values => ({
  count: values.length,
  signedMedianMs: quantile(values, 0.5),
  medianAbsoluteMs: quantile(values.map(Math.abs), 0.5),
  p95AbsoluteMs: quantile(values.map(Math.abs), 0.95),
});

export const scoreSubtitleTiming = (reference, cues) => {
  const expected = reference.words.flatMap(word => tokens(word.text).map(token => ({ ...word, token })));
  const actual = cues.flatMap((cue, index) => tokens(cue.text).map(token => ({ token, cue: index })));
  const n = expected.length, m = actual.length;
  if (!n || (n + 1) * (m + 1) > 4_000_000) throw new Error('Timing alignment requires a bounded nonempty reference.');
  const width = m + 1;
  const costs = new Uint32Array((n + 1) * width);
  for (let i = 0; i <= n; i++) costs[i * width] = i;
  for (let j = 0; j <= m; j++) costs[j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const substitution = expected[i - 1].token === actual[j - 1].token ? 0 : 1;
    costs[i * width + j] = Math.min(costs[(i - 1) * width + j] + 1,
      costs[i * width + j - 1] + 1, costs[(i - 1) * width + j - 1] + substitution);
  }
  let i = n, j = m, matches = 0;
  const byCue = new Map();
  while (i || j) {
    const cost = costs[i * width + j];
    if (i && j && expected[i - 1].token === actual[j - 1].token
        && cost === costs[(i - 1) * width + j - 1]) {
      const index = actual[j - 1].cue;
      const group = byCue.get(index) ?? [];
      group.push(expected[i - 1]);
      byCue.set(index, group);
      matches++; i--; j--;
    } else if (i && j && cost === costs[(i - 1) * width + j - 1] + 1) { i--; j--; }
    else if (i && cost === costs[(i - 1) * width + j] + 1) i--;
    else j--;
  }
  const samples = [];
  for (const [index, words] of byCue) {
    // Utterance-only references can establish text accuracy, never invented word timing.
    if (reference.wordTimingVerified === false) continue;
    const cue = cues[index];
    const count = tokens(cue.text).length;
    // Low-overlap cues remain quality failures, not deceptively precise timing samples.
    if (words.length / count < 0.6) continue;
    const start = Number(cue.start ?? cue.start_ms / 1000);
    const end = Number(cue.end ?? cue.end_ms / 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const referenceStart = Math.min(...words.map(word => word.start));
    const referenceEnd = Math.max(...words.map(word => word.end));
    samples.push({ cue: index, referenceStart,
      startShiftMs: Math.round((start - referenceStart) * 1000),
      endShiftMs: Math.round((end - referenceEnd) * 1000), matchedWords: words.length });
  }
  samples.sort((a, b) => a.referenceStart - b.referenceStart);
  return {
    referenceWords: n, generatedWords: m, matchedWords: matches,
    wordErrorRate: costs[n * width + m] / n,
    referenceWordCoverage: matches / n,
    generatedWordPrecision: m ? matches / m : 0,
    totalCues: cues.length, timedCues: samples.length,
    start: stats(samples.map(sample => sample.startShiftMs)),
    end: stats(samples.map(sample => sample.endShiftMs)),
    samples,
    caveat: 'Text-aligned human word boundaries; segmentation style and overlapping speech need human review. Unmatched text is not scored as zero timing error.',
  };
};
