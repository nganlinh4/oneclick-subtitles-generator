import { subtitleCompletionStatus } from './subtitleCompletionStatus';

const t = (key, fallback) => fallback ?? key;

it('reports a non-empty transcript as successful', () => {
  expect(subtitleCompletionStatus([{ text: 'Hello' }], t)).toEqual({
    message: 'output.generationSuccess',
    type: 'success',
  });
});

it.each([undefined, null, []])(
  'makes an empty transcript visible as a warning (%s)',
  (subtitles) => {
    expect(subtitleCompletionStatus(subtitles, t, { speechOnly: true })).toEqual({
      message: 'No subtitles were returned. The media may contain no detectable speech; otherwise, try again or choose another model.',
      type: 'warning',
    });
  }
);

it('does not reinterpret an empty custom or description result as no-speech success', () => {
  expect(subtitleCompletionStatus([], t, { speechOnly: false })).toEqual({
    message: 'No result was returned for the selected prompt. Try again or choose another model.',
    type: 'error',
  });
});
