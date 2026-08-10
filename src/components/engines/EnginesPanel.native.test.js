import { removeManagedEnginePackage } from '../../platform/managedEngineService';
import { mapManagedPackageInventory, removeNativeEnginePackage } from './EnginesPanel';

vi.mock('../../hooks/useEngineStatus', () => ({
  useEngineStatus: vi.fn(),
}));
vi.mock('../../platform/managedEngineService', () => ({
  removeManagedEnginePackage: vi.fn(),
}));
vi.mock('../../platform/enginePackageService', () => ({
  getEnginePackagesStatus: vi.fn(),
}));
vi.mock('../../platform/speechPackageService', () => ({
  getSpeechPackagesStatus: vi.fn(),
}));
vi.mock('../../utils/waveColors', () => ({
  useWaveColors: vi.fn(),
}));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('./EngineCard', () => ({ default: () => null }));
vi.mock('./NativeToolsList', () => ({ default: () => null }));

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

it('merges the ASR and speech package catalogs under the visible engine identifiers', () => {
  const parakeet = Object.freeze({ id: 'parakeet', deliveryAvailable: false });
  const f5 = Object.freeze({ id: 'f5-tts', deliveryAvailable: false });
  const chatterbox = Object.freeze({ id: 'chatterbox', deliveryAvailable: false });

  const inventory = mapManagedPackageInventory(
    { engines: [parakeet] },
    { packages: [f5, chatterbox] }
  );

  expect([...inventory.keys()]).toEqual(['parakeet', 'f5tts', 'chatterbox']);
  expect(inventory.get('f5tts')).toBe(f5);
  expect(inventory.get('chatterbox')).toBe(chatterbox);
});
