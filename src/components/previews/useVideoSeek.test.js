import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import useVideoSeek from './useVideoSeek';

const mount = () => {
  const seekTo = vi.fn();
  const videoRef = { current: document.createElement('video') };
  const view = renderHook(
    ({ sourceKey, videoDuration }) => useVideoSeek({
      videoRef,
      videoDuration,
      sourceKey,
      seekTo,
      setVolume: vi.fn(),
      setIsMuted: vi.fn(),
    }),
    { initialProps: { sourceKey: 'media-a', videoDuration: 10 } },
  );
  const timeline = document.createElement('div');
  timeline.getBoundingClientRect = () => ({ left: 10, width: 100 });
  return { ...view, seekTo, timeline, videoRef };
};

const beginMouseDrag = (view, clientX = 35) => {
  act(() => {
    view.result.current.handleTimelineMouseDown({
      clientX,
      currentTarget: view.timeline,
    });
  });
};

const beginTouchDrag = (view, clientX = 40) => {
  act(() => {
    view.result.current.handleTimelineTouchStart({
      preventDefault: vi.fn(),
      touches: [{ clientX }],
      currentTarget: view.timeline,
    });
  });
};

const dispatchTouch = (type, clientX = null) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: clientX === null ? [] : [{ clientX }],
  });
  document.dispatchEvent(event);
};

describe('main preview timeline seek routing', () => {
  it('routes mouse release through the coordinator with the final dragged time', () => {
    const view = mount();
    beginMouseDrag(view);
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 85 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(view.seekTo).toHaveBeenCalledOnce();
    expect(view.seekTo).toHaveBeenCalledWith(7.5, { reason: 'timeline-pointer' });
    expect(view.result.current.isDragging).toBe(false);
  });

  it('routes touch release through the same coordinator without a timer unlock', () => {
    const view = mount();
    beginTouchDrag(view);
    act(() => {
      dispatchTouch('touchmove', 100);
      dispatchTouch('touchend');
    });
    expect(view.seekTo).toHaveBeenCalledOnce();
    expect(view.seekTo).toHaveBeenCalledWith(9, { reason: 'timeline-touch' });
    expect(view.result.current.isDragging).toBe(false);
  });

  it('removes an unfinished mouse drag on unmount without seeking', () => {
    const view = mount();
    beginMouseDrag(view);

    act(() => view.unmount());
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 95 }));
      document.dispatchEvent(new MouseEvent('mouseup'));
    });

    expect(view.seekTo).not.toHaveBeenCalled();
  });

  it('removes an unfinished touch drag on unmount without seeking', () => {
    const view = mount();
    beginTouchDrag(view);

    act(() => view.unmount());
    act(() => {
      dispatchTouch('touchmove', 95);
      dispatchTouch('touchend');
    });

    expect(view.seekTo).not.toHaveBeenCalled();
  });

  it('cancels the old mouse owner on source replacement and only releases the new drag', () => {
    const view = mount();
    beginMouseDrag(view);
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 85 }));
      view.videoRef.current = document.createElement('video');
      view.rerender({ sourceKey: 'media-b', videoDuration: 20 });
    });

    expect(view.result.current.isDragging).toBe(false);
    act(() => document.dispatchEvent(new MouseEvent('mouseup')));
    expect(view.seekTo).not.toHaveBeenCalled();

    beginMouseDrag(view, 60);
    act(() => document.dispatchEvent(new MouseEvent('mouseup')));
    expect(view.seekTo).toHaveBeenCalledOnce();
    expect(view.seekTo).toHaveBeenCalledWith(10, { reason: 'timeline-pointer' });
  });

  it('cancels the old touch owner on source replacement and only releases the new drag', () => {
    const view = mount();
    beginTouchDrag(view);
    act(() => {
      dispatchTouch('touchmove', 85);
      view.videoRef.current = document.createElement('video');
      view.rerender({ sourceKey: 'media-b', videoDuration: 20 });
    });

    expect(view.result.current.isDragging).toBe(false);
    act(() => dispatchTouch('touchend'));
    expect(view.seekTo).not.toHaveBeenCalled();

    beginTouchDrag(view, 60);
    act(() => dispatchTouch('touchend'));
    expect(view.seekTo).toHaveBeenCalledOnce();
    expect(view.seekTo).toHaveBeenCalledWith(10, { reason: 'timeline-touch' });
  });

  it('cancels a touch gesture without seeking when the browser aborts it', () => {
    const view = mount();
    beginTouchDrag(view);
    act(() => dispatchTouch('touchcancel'));

    expect(view.result.current.isDragging).toBe(false);
    expect(view.seekTo).not.toHaveBeenCalled();
  });
});
