import { handleGroupingToggle } from './subtitleGroupingHandlers';
import { groupSubtitlesForNarration } from '../../../services/gemini/subtitleGroupingService';
import {
  acknowledgeProjectSubtitleGrouping,
  captureProjectSubtitleGrouping,
  clearProjectSubtitleGrouping,
  loadProjectSubtitleGrouping,
  persistProjectSubtitleGrouping,
} from '../../../platform/projectSubtitleGroupingStore';

vi.mock('../../../services/gemini/subtitleGroupingService', () => ({
  groupSubtitlesForNarration: vi.fn(),
}));
vi.mock('../../../platform/projectSubtitleGroupingStore', () => ({
  acknowledgeProjectSubtitleGrouping: vi.fn(),
  captureProjectSubtitleGrouping: vi.fn(),
  clearProjectSubtitleGrouping: vi.fn(),
  loadProjectSubtitleGrouping: vi.fn(),
  persistProjectSubtitleGrouping: vi.fn(),
}));

const SOURCE = [{ id: 1, start: 0, end: 1, text: 'One' }];
const GROUPED = [{
  id: 1,
  subtitle_id: 1,
  start: 0,
  end: 1,
  text: 'One',
  original_ids: [1],
  source_positions: [1],
}];

const params = () => ({
  groupedSubtitles: null,
  subtitleSource: 'original',
  hasTranslatedSubtitles: false,
  translatedSubtitles: null,
  originalSubtitles: SOURCE,
  translatedLanguage: null,
  originalLanguage: { languageCode: 'en' },
  groupingIntensity: 'moderate',
  setUseGroupedSubtitles: vi.fn(),
  setGroupedSubtitles: vi.fn(),
  setIsGroupingSubtitles: vi.fn(),
});

beforeEach(() => {
  delete window.groupedSubtitles;
  delete window.useGroupedSubtitles;
  vi.clearAllMocks();
  loadProjectSubtitleGrouping.mockResolvedValue(null);
  captureProjectSubtitleGrouping.mockResolvedValue({ sourceRows: SOURCE });
  groupSubtitlesForNarration.mockResolvedValue({ groupedSubtitles: GROUPED });
  persistProjectSubtitleGrouping.mockResolvedValue({ kind: 'receipt' });
  acknowledgeProjectSubtitleGrouping.mockResolvedValue({ groupedRows: GROUPED });
  clearProjectSubtitleGrouping.mockResolvedValue(true);
});

it('publishes state only after durable persistence and delivery acknowledgement', async () => {
  const input = params();
  const order = [];
  persistProjectSubtitleGrouping.mockImplementation(async () => {
    order.push('persist');
    expect(input.setGroupedSubtitles).not.toHaveBeenCalled();
    return { kind: 'receipt' };
  });
  acknowledgeProjectSubtitleGrouping.mockImplementation(async () => {
    order.push('ack');
    expect(input.setGroupedSubtitles).not.toHaveBeenCalled();
    return { groupedRows: GROUPED };
  });
  input.setGroupedSubtitles.mockImplementation(() => order.push('publish'));

  await expect(handleGroupingToggle(true, input)).resolves.toBe(true);
  expect(order).toEqual(['persist', 'ack', 'publish']);
  expect(window.groupedSubtitles).toEqual(GROUPED);
  expect(window.useGroupedSubtitles).toBe(true);
});

it.each([
  ['persistence', persistProjectSubtitleGrouping],
  ['acknowledgement', acknowledgeProjectSubtitleGrouping],
])('does not publish when %s fails', async (_label, failingMock) => {
  const input = params();
  failingMock.mockRejectedValueOnce(new Error('failure'));

  await expect(handleGroupingToggle(true, input)).resolves.toBe(false);
  expect(input.setGroupedSubtitles).not.toHaveBeenCalled();
  expect(window.groupedSubtitles).toBeUndefined();
  expect(window.useGroupedSubtitles).toBeUndefined();
});

it('reuses a durable crash-recovery record without calling Gemini', async () => {
  const input = params();
  loadProjectSubtitleGrouping.mockResolvedValueOnce({ groupedSubtitles: GROUPED });

  await expect(handleGroupingToggle(true, input)).resolves.toBe(true);
  expect(groupSubtitlesForNarration).not.toHaveBeenCalled();
  expect(input.setGroupedSubtitles).toHaveBeenCalledWith(GROUPED);
});

it('durably clears grouping before disabling its compatibility projection', async () => {
  const input = params();
  input.groupedSubtitles = GROUPED;
  window.groupedSubtitles = GROUPED;
  window.useGroupedSubtitles = true;

  await expect(handleGroupingToggle(false, input)).resolves.toBe(true);
  expect(clearProjectSubtitleGrouping).toHaveBeenCalledBefore(input.setGroupedSubtitles);
  expect(input.setGroupedSubtitles).toHaveBeenCalledWith(null);
  expect(window.groupedSubtitles).toBeNull();
  expect(window.useGroupedSubtitles).toBe(false);
});
