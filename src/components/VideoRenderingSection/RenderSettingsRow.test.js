import { fireEvent, render, screen } from '@testing-library/react';

import RenderSettingsRow from './RenderSettingsRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('../common/CustomDropdown', () => ({
  default: ({ value }) => <span>{value}</span>,
}));

const renderRow = (overrides = {}) => {
  const onRender = vi.fn();
  render(<RenderSettingsRow
    renderSettings={{ resolution: '1080p', frameRate: 30 }}
    setRenderSettings={vi.fn()}
    selectedVideoFile={{ assetId: 'selected' }}
    hasSubtitles
    isRendering={false}
    currentQueueItem={null}
    onRender={onRender}
    onCancelRender={vi.fn()}
    {...overrides}
  />);
  return onRender;
};

test('blocks rendering until both video and subtitles are present', () => {
  renderRow({ hasSubtitles: false });
  const button = screen.getByRole('button', { name: /Render/i });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('title', 'Add or generate subtitles before rendering.');
});

test('starts rendering when both prerequisites are present', () => {
  const onRender = renderRow();
  fireEvent.click(screen.getByRole('button', { name: /Render/i }));
  expect(onRender).toHaveBeenCalledTimes(1);
});
