import {
  flushDurableLyricsHistory,
  registerDurableLyricsHistoryFlusher,
} from './durableLyricsCheckpoint';

it('awaits every mounted durable editor owner and supports exact disposal', async () => {
  const order = [];
  const release = {};
  release.promise = new Promise((resolve) => { release.resolve = resolve; });
  const unregisterFirst = registerDurableLyricsHistoryFlusher(async () => {
    await release.promise;
    order.push('first');
  });
  const unregisterSecond = registerDurableLyricsHistoryFlusher(async () => {
    order.push('second');
  });

  const checkpoint = flushDurableLyricsHistory();
  await Promise.resolve();
  expect(order).toEqual(['second']);
  release.resolve();
  await expect(checkpoint).resolves.toBeUndefined();
  expect(order).toEqual(['second', 'first']);

  unregisterFirst();
  unregisterSecond();
  order.length = 0;
  await expect(flushDurableLyricsHistory()).resolves.toBeUndefined();
  expect(order).toEqual([]);
});

it('rejects the checkpoint when any mounted owner cannot flush', async () => {
  const failure = new Error('durable editor failed');
  const unregister = registerDurableLyricsHistoryFlusher(async () => { throw failure; });
  await expect(flushDurableLyricsHistory()).rejects.toBe(failure);
  unregister();
});
