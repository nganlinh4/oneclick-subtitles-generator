import { act, renderHook } from '@testing-library/react';

import { EVENTS } from '../../../events/constants';
import useAutoGenerateFlow from './useAutoGenerateFlow';

vi.mock('../../../utils/toastUtils', () => ({
  showInfoToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

describe('useAutoGenerateFlow analysis lifecycle', () => {
  test('rejects a failed analysis instead of polling forever', async () => {
    const { result, unmount } = renderHook(() => useAutoGenerateFlow({}));
    let pending;
    act(() => {
      pending = result.current.waitForAnalysisComplete();
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(EVENTS.VIDEO_ANALYSIS_SETTLED, {
        detail: { success: false },
      }));
    });

    await expect(pending).rejects.toThrow('Video analysis failed');
    unmount();
  });
});
