const mocks = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  publishSaveBeforeUpdate: vi.fn(() => {
    throw new Error('C:\\private\\native-secret.txt');
  }),
}));

vi.mock('../events/bus', () => ({
  publishSaveAfterStreaming: vi.fn(),
  publishSaveBeforeUpdate: mocks.publishSaveBeforeUpdate,
  subscribe: vi.fn(() => mocks.unsubscribe),
}));

import { checkpointBeforeUpdate } from './lifecycleOrchestrator';

it('cleans up and returns a sanitized failure when checkpoint publication throws', async () => {
  const checkpoint = checkpointBeforeUpdate({ source: 'video-processing-complete' }, 100);

  await expect(checkpoint).rejects.toMatchObject({
    code: 'checkpointSaveFailed',
    message: 'The subtitle checkpoint could not be saved',
  });
  await checkpoint.catch((error) => {
    expect(String(error)).not.toContain('private');
    expect(String(error)).not.toContain('native-secret');
  });
  expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
});
