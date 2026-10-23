import { classifyYoutubeError, YOUTUBE_ERROR_KIND, youtubeSearchErrorToast } from './youtubeErrors';

const coded = (code, message = 'The native provider operation could not be completed') => (
  Object.assign(new Error(message), { code })
);

test.each([
  [coded('youtubeQuotaExceeded'), false, YOUTUBE_ERROR_KIND.QUOTA_EXCEEDED],
  [coded('youtubeApiNotEnabled'), true, YOUTUBE_ERROR_KIND.API_NOT_ENABLED],
  [coded('youtubeAuthenticationRequired'), true, YOUTUBE_ERROR_KIND.AUTH_REQUIRED],
  [coded('youtubeAuthenticationRequired'), false, YOUTUBE_ERROR_KIND.OTHER],
  [coded('credentialNotFound'), true, YOUTUBE_ERROR_KIND.AUTH_REQUIRED],
  [coded('credentialNotFound'), false, YOUTUBE_ERROR_KIND.NO_API_KEY],
  // Message wording never classifies: only the native code does.
  [coded('providerNetwork', 'quota exceeded API key'), false, YOUTUBE_ERROR_KIND.OTHER],
  [new Error('quota exceeded'), false, YOUTUBE_ERROR_KIND.OTHER],
  [new Error('Not authenticated with YouTube'), true, YOUTUBE_ERROR_KIND.OTHER],
  [new Error('YouTube API key not found'), false, YOUTUBE_ERROR_KIND.OTHER],
])('classifies %o (oauth=%s) as %s', (error, oauth, kind) => {
  expect(classifyYoutubeError(error, { oauth })).toBe(kind);
});

test('search toasts use the classified message and duration', () => {
  const t = (key) => key;
  expect(youtubeSearchErrorToast(t, coded('youtubeQuotaExceeded'), { oauth: false }))
    .toEqual(['errors.quotaExceeded', 8000]);
  expect(youtubeSearchErrorToast(t, coded('credentialNotFound'), { oauth: false }))
    .toEqual(['youtube.noApiKey', 5000]);
  expect(youtubeSearchErrorToast(t, coded('providerNetwork'), { oauth: true }))
    .toEqual(['youtube.searchError', 5000]);
});
