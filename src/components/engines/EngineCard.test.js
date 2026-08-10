import { fireEvent, render, screen } from '@testing-library/react';
import useEngineInstall from '../../hooks/useEngineInstall';
import EngineCard from './EngineCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) => {
      if (values) return Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, value),
        fallback
      );
      return fallback || key;
    },
  }),
}));
vi.mock('../../hooks/useEngineInstall', () => ({ default: vi.fn() }));
vi.mock('../../utils/waveColors', () => ({
  useWaveColors: () => ({
    isDarkTheme: false,
    waveColor: '#000',
    waveTrackColor: '#ddd',
  }),
}));
vi.mock('../common/LoadingIndicator', () => ({ default: () => <span>loading</span> }));
vi.mock('../common/WavyProgressIndicator', () => ({ default: () => <span>progress</span> }));

const hookState = (overrides = {}) => ({
  install: vi.fn(),
  cancel: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  uninstall: vi.fn(),
  installing: false,
  percent: 0,
  log: [],
  error: null,
  ...overrides,
});

beforeEach(() => {
  useEngineInstall.mockReturnValue(hookState());
});

afterEach(() => vi.clearAllMocks());

it('does not expose a fake download action for an unpublished package', () => {
  render(
    <EngineCard
      id="f5tts"
      name="F5-TTS"
      kind="voice-cloning"
      status={{
        package: {
          state: 'unavailable',
          installed: false,
          installedBytes: 0,
          downloadBytes: 0,
          availableInstalledBytes: 0,
          operation: null,
        },
      }}
    />
  );

  expect(screen.getByText('Not published')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
});

it('keeps an installed engine removable and confirms before invoking native removal', () => {
  const uninstall = vi.fn().mockResolvedValue(undefined);
  useEngineInstall.mockReturnValue(hookState({ uninstall }));
  render(
    <EngineCard
      id="parakeet"
      name="Nvidia Parakeet"
      kind="transcription"
      status={{
        running: false,
        package: {
          state: 'installed',
          installed: true,
          version: '1.0.0',
          installedBytes: 3_221_225_472,
          downloadBytes: 1_000_000_000,
          availableInstalledBytes: 3_221_225_472,
          operation: null,
        },
      }}
    />
  );

  expect(screen.getByText(/v1\.0\.0/)).toBeInTheDocument();
  expect(screen.getByText('3.0 GB disk')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
  expect(uninstall).toHaveBeenCalledTimes(1);
});

it('recovers a durable removal as a cancellable busy row', () => {
  const cancel = vi.fn();
  useEngineInstall.mockReturnValue(hookState({ cancel }));
  render(
    <EngineCard
      id="qwen3-asr-0.6b"
      name="Qwen3-ASR 0.6B"
      kind="transcription"
      status={{
        package: {
          state: 'installed',
          installed: true,
          installedBytes: 10,
          downloadBytes: 10,
          availableInstalledBytes: 10,
          operation: { action: 'remove', basisPoints: 2500, job: { id: 'durable-job-id' } },
        },
      }}
    />
  );

  expect(screen.getByText('Uninstalling…')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancel).toHaveBeenCalledWith('durable-job-id');
});
