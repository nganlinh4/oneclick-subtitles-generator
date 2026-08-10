import { render } from '@testing-library/react';
import { ClearOfflineSegmentsButton } from './timelineOverlays';

const t = (key, def) => def || key;
const noop = () => {};
const canvasRef = () => ({ current: document.createElement('canvas') });

describe('ClearOfflineSegmentsButton (render guards)', () => {
  test('renders nothing when there are no offline segments', () => {
    const { container } = render(
      <ClearOfflineSegmentsButton
        offlineSegments={[]} retryingOfflineKeys={[]} clearInfoVisible={false}
        handleClearOfflineSegments={noop} t={t} timelineRef={canvasRef()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders nothing while offline retries are in flight', () => {
    const { container } = render(
      <ClearOfflineSegmentsButton
        offlineSegments={[{}]} retryingOfflineKeys={[{}]} clearInfoVisible={false}
        handleClearOfflineSegments={noop} t={t} timelineRef={canvasRef()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders nothing when the timeline canvas is not mounted', () => {
    const { container } = render(
      <ClearOfflineSegmentsButton
        offlineSegments={[{}]} retryingOfflineKeys={[]} clearInfoVisible={false}
        handleClearOfflineSegments={noop} t={t} timelineRef={{ current: null }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
