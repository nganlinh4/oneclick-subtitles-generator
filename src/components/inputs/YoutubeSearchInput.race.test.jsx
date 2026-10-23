import { act, fireEvent, render } from '@testing-library/react';
import YoutubeSearchInput from './YoutubeSearchInput';

const mocks = vi.hoisted(() => ({
  searches: [],
  t: (_key, fallback) => fallback,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

vi.mock('../../platform/desktopYoutubeService', () => ({
  isOAuthEnabled: () => false,
  searchYouTubeVideos: (query) => new Promise((resolve, reject) => {
    mocks.searches.push({ query, resolve, reject });
  }),
}));

vi.mock('../../utils/historyUtils', () => ({
  addSearchQueryToHistory: vi.fn(),
  getSearchQueryHistory: () => [],
  clearSearchQueryHistory: vi.fn(),
  formatTimestamp: () => '',
}));

const video = (id) => ({ id, title: `title ${id}`, channel: 'channel', thumbnail: '' });

const renderSearch = () => render(
  <YoutubeSearchInput
    apiKeysSet={{ youtube: true }}
    selectedVideo={null}
    setSelectedVideo={vi.fn()}
  />
);

const typeAndSettle = async (input, value) => {
  fireEvent.change(input, { target: { value } });
  await act(async () => { vi.advanceTimersByTime(500); });
};

const titles = (container) => [...container.querySelectorAll('.search-result-title')]
  .map((node) => node.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.searches.length = 0;
  window.addToast = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  delete window.addToast;
});

test('an older search finishing last cannot overwrite the newer query', async () => {
  const { container } = renderSearch();
  const input = container.querySelector('#youtube-search-input');
  await typeAndSettle(input, 'first query');
  await typeAndSettle(input, 'second query');
  expect(mocks.searches.map(({ query }) => query)).toEqual(['first query', 'second query']);

  await act(async () => { mocks.searches[1].resolve([video('new')]); });
  await act(async () => { mocks.searches[0].resolve([video('old')]); });

  expect(titles(container)).toEqual(['title new']);
  expect(container.querySelector('.searching-indicator')).toBeNull();
});

test('a stale search failure raises no toast', async () => {
  const { container } = renderSearch();
  const input = container.querySelector('#youtube-search-input');
  await typeAndSettle(input, 'first query');
  await typeAndSettle(input, 'second query');

  await act(async () => { mocks.searches[0].reject(new Error('boom')); });
  expect(window.addToast).not.toHaveBeenCalled();
  expect(container.querySelector('.searching-indicator')).not.toBeNull();
});

test('clearing the box cancels the search in flight', async () => {
  const { container } = renderSearch();
  const input = container.querySelector('#youtube-search-input');
  await typeAndSettle(input, 'first query');
  expect(container.querySelector('.searching-indicator')).not.toBeNull();

  fireEvent.click(container.querySelector('.clear-search-btn'));
  expect(container.querySelector('.searching-indicator')).toBeNull();
  await act(async () => { mocks.searches[0].resolve([video('old')]); });
  await act(async () => { vi.advanceTimersByTime(500); });

  expect(titles(container)).toEqual([]);
  expect(window.addToast).not.toHaveBeenCalled();
});
