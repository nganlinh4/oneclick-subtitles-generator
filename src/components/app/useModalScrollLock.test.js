import { act, renderHook } from '@testing-library/react';

import {
  MODAL_SCROLL_LOCK_ATTRIBUTE,
  syncModalScrollLock,
  useModalScrollLock,
} from './useModalScrollLock';

const flushMutations = () => act(async () => Promise.resolve());

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute(MODAL_SCROLL_LOCK_ATTRIBUTE);
});

it('locks for every whole-page modal vocabulary and releases after the last nested modal', async () => {
  const view = renderHook(() => useModalScrollLock());
  const processing = document.createElement('div');
  processing.className = 'video-processing-modal-overlay';
  document.body.append(processing);
  await flushMutations();
  expect(document.documentElement).toHaveAttribute(MODAL_SCROLL_LOCK_ATTRIBUTE);

  const rules = document.createElement('div');
  rules.className = 'rules-editor-overlay closing';
  document.body.append(rules);
  processing.remove();
  await flushMutations();
  expect(document.documentElement).toHaveAttribute(MODAL_SCROLL_LOCK_ATTRIBUTE);

  rules.remove();
  await flushMutations();
  expect(document.documentElement).not.toHaveAttribute(MODAL_SCROLL_LOCK_ATTRIBUTE);
  view.unmount();
});

it('does not freeze page scrolling for local video and loading overlays', () => {
  for (const className of ['crop-overlay-container', 'narration-refresh-overlay', 'retry-overlay-loading']) {
    const overlay = document.createElement('div');
    overlay.className = className;
    document.body.append(overlay);
  }
  expect(syncModalScrollLock()).toBe(false);
  expect(document.documentElement).not.toHaveAttribute(MODAL_SCROLL_LOCK_ATTRIBUTE);
});

