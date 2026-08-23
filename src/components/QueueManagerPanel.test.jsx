import { fireEvent, render, screen } from '@testing-library/react';

import QueueManagerPanel from './QueueManagerPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback) => fallback,
  }),
}));

vi.mock('./common/WavyProgressIndicator', () => ({
  default: () => <div data-testid="render-progress" />,
}));

const queueItem = (status) => ({
  id: 'render-1',
  status,
  settings: { resolution: '1080p', frameRate: 30 },
  timestamp: 1_700_000_000_000,
  progress: 25,
  outputPath: null,
});

describe('render queue cancellation authority', () => {
  test('does not paint a native job cancelled before its owner accepts cancellation', () => {
    const onCancelItem = vi.fn();
    const view = render(
      <QueueManagerPanel
        queue={[queueItem('processing')]}
        currentQueueItem={{ id: 'render-1' }}
        onRemoveItem={vi.fn()}
        onClearQueue={vi.fn()}
        onCancelItem={onCancelItem}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel$/ }));

    expect(onCancelItem).toHaveBeenCalledWith('render-1');
    expect(screen.getByText('processing')).toBeInTheDocument();
    expect(screen.queryByText('Render cancelled')).not.toBeInTheDocument();

    view.rerender(
      <QueueManagerPanel
        queue={[queueItem('cancelling')]}
        currentQueueItem={{ id: 'render-1' }}
        onRemoveItem={vi.fn()}
        onClearQueue={vi.fn()}
        onCancelItem={onCancelItem}
      />,
    );
    expect(screen.getByText('cancelling')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel$/ })).not.toBeInTheDocument();

    view.rerender(
      <QueueManagerPanel
        queue={[queueItem('cancelled')]}
        currentQueueItem={null}
        onRemoveItem={vi.fn()}
        onClearQueue={vi.fn()}
        onCancelItem={onCancelItem}
      />,
    );
    expect(screen.getByText('cancelled')).toBeInTheDocument();
  });
});
