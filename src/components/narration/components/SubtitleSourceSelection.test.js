import {
  F5_V1_BASE_SUPPORTED_LANGS,
  nativeF5ModelsForStatus,
} from './SubtitleSourceSelection';

test('advertises the managed F5 v1 Base checkpoint only for English and Chinese', () => {
  expect(F5_V1_BASE_SUPPORTED_LANGS).toEqual(['en', 'zh']);
  expect(nativeF5ModelsForStatus({ backend: 'f5Tts', installed: true })).toEqual([{
    id: 'f5tts-v1-base',
    languages: ['en', 'zh'],
  }]);
});

test('does not advertise F5 when the exact managed backend is absent or not installed', () => {
  expect(nativeF5ModelsForStatus({ backend: 'f5Tts', installed: false })).toEqual([]);
  expect(nativeF5ModelsForStatus({ backend: 'chatterbox', installed: true })).toEqual([]);
  expect(nativeF5ModelsForStatus(null)).toEqual([]);
});
