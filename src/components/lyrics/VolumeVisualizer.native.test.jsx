import { act, render, screen, waitFor } from '@testing-library/react';

import {
  resolveActiveNativeMedia,
  refreshActiveNativeMedia,
} from '../../platform/activeNativeMedia';
import { loadNativeWaveform } from './audioProcessing';
import VolumeVisualizer from './VolumeVisualizer';

vi.mock('../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../platform/activeNativeMedia', () => ({
  resolveActiveNativeMedia: vi.fn(),
  refreshActiveNativeMedia: vi.fn(),
}));
vi.mock('./audioProcessing', () => ({
  isMissingAudioFailure: (error) => error?.code === 'mediaMissingAudio',
  loadNativeWaveform: vi.fn(),
}));
vi.mock('./waveformLOD', () => ({
  prepareNativeWaveform: (waveform) => ({
    durationSeconds: waveform.durationUs / 1_000_000,
    peakRootMeanSquare: 1,
    levels: waveform.levels,
  }),
}));
vi.mock('./waveformRendering', () => ({
  renderWaveform: vi.fn(),
  updateVisualization: vi.fn(),
}));

const SOURCE_A = 'http://127.0.0.1:49152/asset/a';
const SOURCE_B = 'http://127.0.0.1:49152/asset/b';
const ASSET_A = '01890f39-7b62-7c4e-8c9a-000000000101';
const ASSET_B = '01890f39-7b62-7c4e-8c9a-000000000102';
const ASSET_C = '01890f39-7b62-7c4e-8c9a-000000000103';
const nativeWaveform = {
  durationUs: 10_000_000,
  levels: [{
    pointsPerSecond: 1,
    points: [{ minimum: -1, maximum: 1, rootMeanSquare: 1 }],
  }],
};

const capability = (assetId) => ({ assetId });

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = (timer) => clearTimeout(timer);
});

beforeEach(() => {
  resolveActiveNativeMedia.mockReset();
  refreshActiveNativeMedia.mockReset();
  loadNativeWaveform.mockReset();
  refreshActiveNativeMedia.mockResolvedValue(undefined);
});

it('runs exactly one request while timeline renders and settles after native completion', async () => {
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  resolveActiveNativeMedia.mockResolvedValue(capability(ASSET_A));
  loadNativeWaveform.mockImplementation(async (options) => {
    const result = await completed;
    await options.revalidate();
    return result;
  });
  const view = render(
    <VolumeVisualizer
      audioSource={SOURCE_A}
      duration={10}
      visibleTimeRange={{ start: 0, end: 10 }}
    />
  );

  await waitFor(() => {
    expect(document.querySelector('[data-osg-waveform-state="processing"]')).not.toBeNull();
  });
  expect(screen.queryByText('Processing audio waveform...')).not.toBeInTheDocument();
  view.rerender(
    <VolumeVisualizer
      audioSource={SOURCE_A}
      duration={10}
      visibleTimeRange={{ start: 2, end: 8 }}
    />
  );
  expect(loadNativeWaveform).toHaveBeenCalledTimes(1);

  await act(async () => finish(nativeWaveform));
  await waitFor(() => expect(document.querySelector('[data-osg-waveform-state="ready"]')).not.toBeNull());
  expect(refreshActiveNativeMedia).toHaveBeenCalledTimes(1);
  expect(loadNativeWaveform).toHaveBeenCalledTimes(1);
});

it('always removes the processing surface when publication ownership is lost', async () => {
  resolveActiveNativeMedia.mockResolvedValue(capability(ASSET_B));
  const changed = new Error('active media changed');
  changed.name = 'ActiveNativeMediaError';
  refreshActiveNativeMedia.mockRejectedValue(changed);
  loadNativeWaveform.mockImplementation(async (options) => {
    await options.revalidate();
    return nativeWaveform;
  });

  render(
    <VolumeVisualizer
      audioSource={SOURCE_B}
      duration={10}
      visibleTimeRange={{ start: 0, end: 10 }}
    />
  );

  await waitFor(() => {
    expect(screen.queryByText('Processing audio waveform...')).not.toBeInTheDocument();
    expect(document.querySelector('[data-osg-waveform-state="processing"]')).toBeNull();
  });
  expect(loadNativeWaveform).toHaveBeenCalledTimes(1);
});

it('aborts obsolete work and publishes only the replacement source', async () => {
  const controllers = [];
  resolveActiveNativeMedia.mockImplementation(async ({ candidate }) => (
    capability(candidate === SOURCE_A ? ASSET_C : ASSET_B)
  ));
  loadNativeWaveform.mockImplementation(async (options) => {
    controllers.push(options.signal);
    if (options.assetId === ASSET_C) {
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    await options.revalidate();
    return nativeWaveform;
  });
  const view = render(
    <VolumeVisualizer
      audioSource={SOURCE_A}
      duration={10}
      visibleTimeRange={{ start: 0, end: 10 }}
    />
  );
  await waitFor(() => expect(loadNativeWaveform).toHaveBeenCalledTimes(1));

  view.rerender(
    <VolumeVisualizer
      audioSource={SOURCE_B}
      duration={10}
      visibleTimeRange={{ start: 0, end: 10 }}
    />
  );

  await waitFor(() => expect(document.querySelector('[data-osg-waveform-state="ready"]')).not.toBeNull());
  expect(controllers[0].aborted).toBe(true);
  expect(loadNativeWaveform.mock.calls.at(-1)[0].assetId).toBe(ASSET_B);
});
