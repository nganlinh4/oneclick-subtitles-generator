import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import NativePreviewUnavailable from './NativePreviewUnavailable';
import { FONT_READINESS_EVENT, FONT_READINESS_SCHEMA, FONT_READINESS_STATE } from '../../../services/fontCapability';
import { retryManagedFont } from '../../../services/fontRepair';

vi.mock('../../../services/fontRepair', () => ({ retryManagedFont: vi.fn() }));

// Interpolating rather than returning the raw default, because whether the typed cause actually
// reaches the sentence the user reads is the thing these tests are about.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback, options) => Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.split('{{' + name + '}}').join(String(value)),
      String(fallback),
    ),
  }),
}));

/**
 * The notice used to have one thing to say and no way to say why.
 *
 * `code === null` meant "nothing was asked for", and a font that could not be installed produced
 * exactly that: a grey line claiming the preview was unavailable, forever, with no cause and no
 * action. These assert the states it can now distinguish, and that a late repair reaches a surface
 * that is already on screen.
 */

const record = (state, extra = {}) => ({
  schema: FONT_READINESS_SCHEMA,
  epoch: 1,
  state,
  family: 'Google Sans',
  version: state === FONT_READINESS_STATE.ready ? 'v22-ui4' : null,
  reason: null,
  retryable: false,
  ...extra,
});

const stage = (value) => {
  if (value === undefined) delete window.__OSG_FONT_READINESS__;
  else window.__OSG_FONT_READINESS__ = value;
};

const publish = (value) => {
  window.__OSG_FONT_READINESS__ = value;
  window.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, { detail: value }));
};

afterEach(() => {
  stage(undefined);
  vi.clearAllMocks();
});

describe('while the managed font is still being prepared', () => {
  it('says it is preparing rather than claiming the preview is unavailable', () => {
    stage(record(FONT_READINESS_STATE.resolving));
    render(<NativePreviewUnavailable />);

    expect(screen.getByRole('status').textContent).toMatch(/preparing the subtitle font/i);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says the same while a repair is running', () => {
    stage(record(FONT_READINESS_STATE.repairing));
    render(<NativePreviewUnavailable />);

    expect(screen.getByRole('status').textContent).toMatch(/preparing the subtitle font/i);
  });
});

describe('when the managed font cannot be installed', () => {
  it('states the typed cause and offers a repair when retrying could help', async () => {
    stage(record(FONT_READINESS_STATE.refused, { reason: 'no-usable-source', retryable: true }));
    render(<NativePreviewUnavailable />);

    expect(screen.getByRole('status').textContent).toMatch(/no-usable-source/);

    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(retryManagedFont).toHaveBeenCalledTimes(1));
  });

  it('offers no button when native says retrying cannot help', () => {
    stage(record(FONT_READINESS_STATE.refused, { reason: 'integrity-failed', retryable: false }));
    render(<NativePreviewUnavailable />);

    expect(screen.getByRole('status').textContent).toMatch(/integrity-failed/);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('when a repair lands after the surface is already showing', () => {
  it('stops claiming the font is missing', async () => {
    stage(record(FONT_READINESS_STATE.refused, { reason: 'timed-out', retryable: true, epoch: 3 }));
    render(<NativePreviewUnavailable />);
    expect(screen.getByRole('status').textContent).toMatch(/timed-out/);

    publish(record(FONT_READINESS_STATE.ready, { epoch: 4 }));

    // The font is now installed, so the notice falls back to the generic dormant message: the font
    // is no longer the reason, and this surface never claims to know what is.
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/subtitle preview unavailable/i);
    });
  });
});

describe('the states that have nothing to do with the font', () => {
  it('reports a native refusal code with its own retry', () => {
    stage(record(FONT_READINESS_STATE.ready));
    const onRetry = vi.fn();
    render(<NativePreviewUnavailable code="previewDeviceLost" onRetry={onRetry} />);

    expect(screen.getByRole('status').textContent).toMatch(/previewDeviceLost/);
    fireEvent.click(screen.getByRole('button'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryManagedFont).not.toHaveBeenCalled();
  });

  it('reports dormancy without a retry when the font is fine', () => {
    stage(record(FONT_READINESS_STATE.ready));
    render(<NativePreviewUnavailable />);

    expect(screen.getByRole('status').textContent).toMatch(/subtitle preview unavailable/i);
    expect(screen.queryByRole('button')).toBeNull();
  });

  /**
   * A refusal code must not be hidden behind the font message. The code says work was attempted and
   * declined for a reason of its own, which is more specific than "the font is not ready".
   */
  it('prefers a native refusal code even while the font is still preparing', () => {
    stage(record(FONT_READINESS_STATE.resolving));
    render(<NativePreviewUnavailable code="previewSourceUnreadable" />);

    expect(screen.getByRole('status').textContent).toMatch(/previewSourceUnreadable/);
  });
});
