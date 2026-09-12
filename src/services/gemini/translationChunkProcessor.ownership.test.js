import {
  PartialTranslationError,
  abortableTranslationDelay,
  translateSubtitlesByChunks,
} from './translationChunkProcessor';

const rows = [
  { id: 1, originalId: 'number:1', sourceOrder: 0, start: 0, end: 1, text: 'one' },
  { id: 2, originalId: 'number:2', sourceOrder: 1, start: 70, end: 71, text: 'two' },
  { id: 3, originalId: 'number:3', sourceOrder: 2, start: 140, end: 141, text: 'three' },
];

const runChunks = (translateChunk, ownership = {}, restTime = 0) => translateSubtitlesByChunks(
  rows,
  'English',
  'model',
  null,
  1,
  false,
  ' ',
  false,
  null,
  [{ id: 1, type: 'language', value: 'English', isOriginal: false }],
  restTime,
  'main',
  translateChunk,
  { publishStatus: vi.fn(), ...ownership }
);

it('reports successful chunks plus exact failed chunk metadata without fake translations', async () => {
  const translateChunk = vi.fn()
    .mockImplementationOnce(async (chunk) => chunk.map((row) => ({ ...row, text: 'ONE' })))
    .mockRejectedValueOnce(Object.assign(new Error('provider failed'), { code: 'providerFailed' }))
    .mockImplementationOnce(async (chunk) => chunk.map((row) => ({ ...row, text: 'THREE' })));

  const error = await runChunks(translateChunk).catch((failure) => failure);
  expect(error).toBeInstanceOf(PartialTranslationError);
  expect(error.completedSubtitles.map((row) => row.text)).toEqual(['ONE', 'THREE']);
  expect(error.completedSubtitles.some((row) => row.text.startsWith('[Translation failed]'))).toBe(false);
  expect(error.failedChunks).toEqual([{
    chunkIndex: 1,
    startOrder: 1,
    endOrder: 1,
    errorCode: 'providerFailed',
  }]);
});

it('starts every chunk concurrently and restores source order regardless of completion order', async () => {
  const releases = [];
  const translateChunk = vi.fn((chunk) => new Promise((resolve) => {
    releases.push(() => resolve(chunk.map((row) => ({ ...row, text: row.text.toUpperCase() }))));
  }));

  const pending = runChunks(translateChunk);
  await vi.waitFor(() => expect(translateChunk).toHaveBeenCalledTimes(3));
  releases[2]();
  releases[0]();
  releases[1]();

  await expect(pending).resolves.toEqual(rows.map((row) => ({
    ...row,
    text: row.text.toUpperCase(),
  })));
});

it('refuses the aggregate when exact project ownership changes', async () => {
  let valid = true;
  const assertOwned = vi.fn(async () => {
    if (!valid) {
      const error = new Error('project changed');
      error.name = 'AbortError';
      throw error;
    }
  });
  const translateChunk = vi.fn(async (chunk) => {
    if (chunk[0].sourceOrder === 0) valid = false;
    return chunk.map((row) => ({ ...row, text: row.text.toUpperCase() }));
  });

  await expect(runChunks(translateChunk, { assertOwned })).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(translateChunk.mock.calls.length).toBeGreaterThanOrEqual(1);
});

it('uses rest time only to stagger starts without serializing provider work', async () => {
  vi.useFakeTimers();
  const pendingResolvers = [];
  const translateChunk = vi.fn((chunk) => new Promise((resolve) => {
    pendingResolvers.push(() => resolve(chunk));
  }));
  const pending = runChunks(translateChunk, {}, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(translateChunk).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(translateChunk).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(translateChunk).toHaveBeenCalledTimes(3);
  pendingResolvers.forEach((resolve) => resolve());
  await expect(pending).resolves.toHaveLength(3);
  vi.useRealTimers();
});

it('aborts an inter-chunk delay promptly without touching an unrelated controller', async () => {
  vi.useFakeTimers();
  const owner = new AbortController();
  const unrelated = new AbortController();
  const pending = abortableTranslationDelay(60_000, owner.signal);
  owner.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(unrelated.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
