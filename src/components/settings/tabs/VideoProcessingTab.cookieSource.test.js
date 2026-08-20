import { fireEvent, render, screen } from '@testing-library/react';

import VideoProcessingTab from './VideoProcessingTab';

vi.mock('../../common/CustomDropdown', () => ({
  default: ({ value, onChange, options, placeholder }) => (
    <select
      aria-label={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));
vi.mock('../../common/SliderWithValue', () => ({ default: () => null }));
vi.mock('./VideoAnalysisCard', () => ({ default: () => null }));
vi.mock('./ThinkingBudgetCard', () => ({ default: () => null }));
vi.mock('../components/CustomGeminiModelsCard', () => ({ default: () => null }));
vi.mock('../../../utils/geminiEffects', () => ({
  initGeminiButtonEffects: vi.fn(),
  disableGeminiButtonEffects: vi.fn(),
}));

const renderTab = ({ enabled = true, source = 'edge', setSource = vi.fn() } = {}) => render(
  <VideoProcessingTab
    timeFormat="hms"
    setTimeFormat={vi.fn()}
    showWaveformLongVideos={false}
    setShowWaveformLongVideos={vi.fn()}
    videoAnalysisModel="gemini-2.5-flash"
    setVideoAnalysisModel={vi.fn()}
    videoAnalysisTimeout="10"
    setVideoAnalysisTimeout={vi.fn()}
    thinkingBudgets={{}}
    setThinkingBudgets={vi.fn()}
    useCookiesForDownload={enabled}
    setUseCookiesForDownload={vi.fn()}
    downloadCookieSource={source}
    setDownloadCookieSource={setSource}
    enableYoutubeSearch={false}
    setEnableYoutubeSearch={vi.fn()}
    autoImportSiteSubtitles={true}
    setAutoImportSiteSubtitles={vi.fn()}
    customGeminiModels={[]}
    setCustomGeminiModels={vi.fn()}
    enableGeminiEffects={false}
    setEnableGeminiEffects={vi.fn()}
    favoriteMaxSubtitleLength={12}
    setFavoriteMaxSubtitleLength={vi.fn()}
    showFavoriteMaxLength={true}
    setShowFavoriteMaxLength={vi.fn()}
  />
);

it('shows every supported browser when cookies are enabled and updates the shared selection', () => {
  const setSource = vi.fn();
  renderTab({ setSource });

  const select = screen.getByLabelText('Select browser');
  expect(select).toHaveValue('edge');
  expect(Array.from(select.options).map((option) => option.value)).toEqual([
    'chrome', 'chromium', 'edge', 'firefox', 'brave', 'safari', 'vivaldi', 'opera', 'whale',
  ]);

  fireEvent.change(select, { target: { value: 'firefox' } });
  expect(setSource).toHaveBeenCalledWith('firefox');
});

it('hides the browser selector while cookies are disabled', () => {
  renderTab({ enabled: false });
  expect(screen.queryByLabelText('Select browser')).not.toBeInTheDocument();
});
