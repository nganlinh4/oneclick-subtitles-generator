import { RealtimeSubtitleProcessor } from './realtimeProcessor';

const row = (text, start = '00m01s000ms') => ({ startTime: start, endTime: '00m03s000ms', text });
afterEach(() => vi.useRealTimers());

it('streams and completes explicit mixed-separator timestamps observed in live Gemini output', () => {
  const updates = [], completed = [];
  const processor = new RealtimeSubtitleProcessor({
    onSubtitleUpdate: update => updates.push(update), onComplete: rows => completed.push(rows),
  });
  const text = JSON.stringify([{ startTime: '00:03s060ms', endTime: '00:06s700ms', text: 'Yeah, yeah.' }]);
  processor.processChunk({ accumulatedText: text.slice(0, -1) });
  expect(updates.at(-1).subtitles[0]).toMatchObject({ start: 3.06, end: 6.7 });
  processor.complete(text);
  expect(completed[0][0]).toMatchObject({ start: 3.06, end: 6.7 });
});

it('publishes a complete cue before the response finishes and never re-emits stale rows after completion', () => {
  vi.useFakeTimers();
  const updates = [];
  const complete = vi.fn();
  const processor = new RealtimeSubtitleProcessor({ onSubtitleUpdate: p => updates.push(p), onComplete: complete });
  const first = JSON.stringify(row('First'));
  const second = JSON.stringify(row('Second', '00m02s000ms'));
  processor.processChunk({ accumulatedText: `[${first},` });
  expect(updates.at(-1).subtitles.map(cue => cue.text)).toEqual(['First']);
  processor.processChunk({ accumulatedText: `[${first},${second}` });
  processor.complete(`[${first},${second}]`);
  const length = updates.length;
  vi.runAllTimers();
  expect(updates).toHaveLength(length);
  expect(updates.at(-1).isStreaming).toBe(false);
  expect(updates.at(-1).subtitles.map(cue => cue.text)).toEqual(['First', 'Second']);
  expect(complete).toHaveBeenCalledOnce();
});

it('cancels pending UI updates on error and does not call partial data a completed result', () => {
  vi.useFakeTimers();
  const updates = vi.fn(), complete = vi.fn(), error = vi.fn();
  const processor = new RealtimeSubtitleProcessor({ onSubtitleUpdate: updates, onComplete: complete, onError: error });
  const first = JSON.stringify(row('First'));
  processor.processChunk({ accumulatedText: `[${first},` });
  processor.processChunk({ accumulatedText: `[${first},${JSON.stringify(row('Second'))}` });
  processor.error(new Error('cancelled'));
  const count = updates.mock.calls.length;
  vi.runAllTimers();
  expect(updates).toHaveBeenCalledTimes(count);
  expect(complete).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
});

it('accepts a valid empty final track', () => {
  const complete = vi.fn(), error = vi.fn();
  const processor = new RealtimeSubtitleProcessor({ onComplete: complete, onError: error });
  processor.complete('[]');
  expect(complete).toHaveBeenCalledWith([]);
  expect(error).not.toHaveBeenCalled();
});

it('keeps split cue IDs unique and identical between incremental and final parsing', () => {
  const processor = new RealtimeSubtitleProcessor({ autoSplitEnabled: true, maxWordsPerSubtitle: 2 });
  const first = JSON.stringify(row('one two three four'));
  const second = JSON.stringify(row('five six seven eight', '00m02s000ms'));
  processor.processChunk({ accumulatedText: `[${first},` });
  processor.processChunk({ accumulatedText: `[${first},${second}` });
  const streamed = processor.currentSubtitles.map(cue => ({ id: cue.id, text: cue.text }));
  expect(new Set(streamed.map(cue => cue.id)).size).toBe(streamed.length);
  processor.complete(`[${first},${second}]`);
  expect(processor.currentSubtitles.map(cue => ({ id: cue.id, text: cue.text }))).toEqual(streamed);
});
