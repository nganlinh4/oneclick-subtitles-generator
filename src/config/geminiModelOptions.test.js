import { createInstance } from 'i18next';
import { buildGeminiModelOption, getModelById } from './geminiModels';
import en from '../i18n/locales/en/models.json';
import viLocale from '../i18n/locales/vi/models.json';
import ko from '../i18n/locales/ko/models.json';

test.each([
  ['en', en, '500 requests/day'],
  ['vi', viLocale, '500 lượt/ngày'],
  ['ko', ko, '500회/일'],
])('localizes the same daily request ceiling in %s without polluting the model label', async (lng, models, expected) => {
  const i18n = createInstance();
  await i18n.init({ lng, resources: { [lng]: { translation: { models } } } });
  const option = buildGeminiModelOption(getModelById('gemini-3.5-flash-lite'), i18n.t.bind(i18n));
  expect(option.label).toBe('Gemini 3.5 Flash Lite');
  expect(option.trailingLabel).toBe(expected);
  expect(option.trailingTitle).toBe(models.freeDailyQuotaHelp);
});

test.each([undefined, null, -1, '500', Infinity, NaN])('an unknown/invalid quota %s is never described as unlimited', (requestsPerDay) => {
  const option = buildGeminiModelOption({ id: 'gemini-custom', name: 'Custom', isCustom: true,
    quota: { requestsPerDay } }, (_key, fallback) => fallback);
  expect(option.trailingLabel).toBe('—');
  expect(option.trailingTitle).toContain('not verified');
});
