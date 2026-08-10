import { checkNativeNarrationAvailability } from './useAvailabilityCheck';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class Channel {},
  invoke: vi.fn(),
}));

it('probes only installed native speech backends and uses live readiness', async () => {
  const adapter = {
    getStatus: vi.fn().mockResolvedValue({
      backends: [
        { backend: 'f5Tts', installed: true },
        { backend: 'chatterbox', installed: false },
      ],
    }),
    probe: vi.fn().mockResolvedValue({ status: { ready: true } }),
  };

  await expect(checkNativeNarrationAvailability(adapter)).resolves.toEqual({
    f5Status: { available: true },
    chatterboxStatus: { available: false, message: 'SERVICE_UNAVAILABLE' },
  });
  expect(adapter.probe).toHaveBeenCalledTimes(1);
  expect(adapter.probe).toHaveBeenCalledWith('f5Tts');
});

it('fails a backend closed when its bounded native probe rejects', async () => {
  const adapter = {
    getStatus: vi.fn().mockResolvedValue({
      backends: [
        { backend: 'f5Tts', installed: true },
        { backend: 'chatterbox', installed: true },
      ],
    }),
    probe: vi.fn()
      .mockRejectedValueOnce(new Error('worker unavailable'))
      .mockResolvedValueOnce({ status: { ready: false } }),
  };

  await expect(checkNativeNarrationAvailability(adapter)).resolves.toEqual({
    f5Status: { available: false, message: 'SERVICE_UNAVAILABLE' },
    chatterboxStatus: { available: false, message: 'SERVICE_UNAVAILABLE' },
  });
});
