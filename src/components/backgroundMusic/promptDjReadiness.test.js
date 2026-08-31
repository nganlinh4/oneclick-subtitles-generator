import { describe, expect, it, vi } from 'vitest';

import { startPromptDjReadinessBridge } from './promptDjReadiness';

describe('PromptDJ nested readiness bridge', () => {
  it('waits for the real inner application and publishes exactly once', async () => {
    const pending = [];
    let probes = 0;
    const publish = vi.fn();
    startPromptDjReadinessBridge({
      isReady: () => ++probes === 3,
      publish,
      schedule: (callback) => { pending.push(callback); return callback; },
      cancelSchedule: vi.fn(),
    });
    expect(publish).not.toHaveBeenCalled();
    pending.shift()();
    pending.shift()();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending probe without publishing', async () => {
    const pending = [];
    const publish = vi.fn();
    const cancelSchedule = vi.fn();
    const stop = startPromptDjReadinessBridge({
      isReady: () => false,
      publish,
      schedule: (callback) => { pending.push(callback); return callback; },
      cancelSchedule,
    });
    stop();
    pending[0]();
    await Promise.resolve();
    expect(cancelSchedule).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });
});
