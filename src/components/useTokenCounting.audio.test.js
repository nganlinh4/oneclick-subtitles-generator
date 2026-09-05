import useTokenCounting from './useTokenCounting';

it('counts no frame tokens for audio-only input regardless of frame controls', () => {
  const options = {
    selectedSegment: { start: 20, end: 80 }, method: 'new', maxDurationPerRequest: 10,
    fps: 5, mediaResolution: 'medium', resolutionOptions: [{ value: 'medium', tokens: 258 }],
  };
  expect(useTokenCounting({ ...options, audioOnly: true }).displayTokens).toBe(1920);
  expect(useTokenCounting({ ...options, videoFile: { type: 'audio/flac' } }).displayTokens).toBe(1920);
  expect(useTokenCounting(options).displayTokens).toBe(79320);
});

it('matches the evenly balanced production windows for a range just over the maximum', () => {
  expect(useTokenCounting({ selectedSegment: { start: 0, end: 601 }, method: 'new',
    maxDurationPerRequest: 10, audioOnly: true, resolutionOptions: [], fps: 1,
  }).displayTokens).toBe(300.5 * 32);
});
