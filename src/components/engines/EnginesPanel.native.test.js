import { removeManagedEnginePackage } from '../../platform/managedEngineService';
import { removeNativeEnginePackage } from './EnginesPanel';

vi.mock('../../hooks/useEngineStatus', () => ({
  useEngineStatus: vi.fn(),
}));
vi.mock('../../platform/managedEngineService', () => ({
  removeManagedEnginePackage: vi.fn(),
}));
vi.mock('../../utils/waveColors', () => ({
  useWaveColors: vi.fn(),
}));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('./EngineCard', () => ({ default: () => null }));

afterEach(() => {
  vi.clearAllMocks();
  delete global.fetch;
});

it('waits for a terminal native removal event without contacting a legacy endpoint', async () => {
  let handlers;
  removeManagedEnginePackage.mockImplementation(async (_engine, providedHandlers) => {
    handlers = providedHandlers;
    return { id: 'durable-job' };
  });
  global.fetch = vi.fn();

  const removal = removeNativeEnginePackage('f5tts');
  await Promise.resolve();
  expect(removeManagedEnginePackage).toHaveBeenCalledWith(
    'f5tts',
    expect.objectContaining({
      onCompleted: expect.any(Function),
      onCancelled: expect.any(Function),
      onFailed: expect.any(Function),
      onProtocolError: expect.any(Function),
    })
  );
  let settled = false;
  removal.finally(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);

  handlers.onCompleted();
  await removal;
  expect(settled).toBe(true);
  expect(global.fetch).not.toHaveBeenCalled();
});

it('settles failed-to-start removals so batch cleanup cannot hang', async () => {
  removeManagedEnginePackage.mockRejectedValue(new Error('native boundary unavailable'));

  await expect(removeNativeEnginePackage('parakeet')).resolves.toBeUndefined();
});
