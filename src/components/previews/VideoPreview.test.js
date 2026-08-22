import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import useNativePreview from './native/useNativePreview';
import VideoPreview from './VideoPreview';

/**
 * The editor's video surface, rendered for real.
 *
 * Nothing rendered this component before — the app-level test mocks it away and everything else here
 * is a hook test or a lab — so the invariant this whole change exists to create was untested where it
 * actually has to hold: THE WEBVIEW COMPOSES NO SUBTITLE APPEARANCE. Three implementations used to
 * feed this surface (a CSS overlay drawn from `subtitleSettings`, an imperative `#fullscreen-subtitle`
 * div styled the same way, and the native frame). Only the native frame is left, and a test that
 * renders the component is the only thing that can say so about the DOM rather than about imports.
 *
 * WHAT IS MOCKED AND WHY. The settings panel is the CONTROL surface, not the drawing surface: its
 * font pickers legitimately paint swatches in the user's font, and they are explicitly out of this
 * change. Mocking it leaves exactly the video surface behind, so an assertion that no node carries
 * subtitle appearance means what it says. The compositor transport is stubbed for the same reason
 * `NativeRenderPreview.test.js` stubs it — it is proven in `native/useNativePreviewFrame.test.js`,
 * and this file is about the surface.
 */

const i18n = vi.hoisted(() => ({
  // ONE `t`, for the whole suite. i18next hands back a stable function, and this surface depends on
  // that: `useVideoSourceLoading` re-runs its source effect whenever `t` changes, and a mock that
  // built a new one per render would reset the load on every render and never finish loading.
  translation: {
    // Interpolates the way i18next does, so an assertion about a reported code is an assertion
    // about what a user would actually read.
    t: (_key, fallback, values = {}) => String(fallback).replace(
      /\{\{(\w+)\}\}/g,
      (whole, name) => (name in values ? String(values[name]) : whole),
    ),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => i18n.translation,
  // `src/i18n/i18n.js` runs as a side effect of this component's module graph and installs this
  // plugin at import time, so the mock has to carry it or the suite never loads.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('../SubtitleSettings', () => ({ default: () => null }));
vi.mock('./VideoTopsideButtons', () => ({ default: () => null }));
vi.mock('./VideoBottomControls', () => ({ default: () => null }));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('./useVideoSourceSwitching', () => ({ default: () => undefined }));
vi.mock('./native/useNativePreview', () => ({ default: vi.fn() }));

const FRAME_URL = 'http://127.0.0.1:49152/frame/3f2504e0-4f89-41d3-9a0c-0305e82c3301/0?token=a&frame_token=b';

/**
 * Every subtitle setting, given a value that exists nowhere else in the tree.
 *
 * The sentinels are what make the assertion honest: "no node carries subtitle appearance" is checked
 * by looking for THESE strings in the rendered DOM, so a rule fed from the user's settings fails on
 * its value and a rule that comes back with hardcoded defaults still fails the property-level check.
 */
const SENTINEL_SETTINGS = Object.freeze({
  fontFamily: 'Sentinel Preview Face',
  fontSize: '77.13',
  fontWeight: '600',
  position: '90.17',
  boxWidth: '73.29',
  backgroundColor: '#123456',
  opacity: '0.3719',
  textColor: '#fedcba',
  showTranslatedSubtitles: false,
  backgroundRadius: '19.41',
  backgroundPadding: '23.57',
  letterSpacing: '7.83',
  lineSpacing: '1.9317',
  textTransform: 'uppercase',
  textAlign: 'right',
  textShadow: true,
  fontVariationSettings: '"ROND" 42',
});

/**
 * The settings whose values are distinctive enough to search the DOM for.
 *
 * `fontWeight`, `textAlign` and `textTransform` are deliberately not here: `600`, `right` and
 * `uppercase` occur in ordinary layout CSS, so searching for them would fail on unrelated rules and
 * teach the next person to weaken the test. Those three are covered by the property scan instead.
 */
const SENTINEL_VALUES = Object.freeze([
  'Sentinel Preview Face', '77.13', '90.17', '73.29', '#123456', '0.3719', '#fedcba',
  '19.41', '23.57', '7.83', '1.9317', 'ROND',
]);

/** The CSS a subtitle's look is made of, whatever the values happen to be. */
const SUBTITLE_APPEARANCE = Object.freeze([
  'font-family',
  'font-size',
  'font-weight',
  'font-variation-settings',
  'text-shadow',
  'background-color',
  'text-stroke',
  'letter-spacing',
  'text-transform',
]);

const ORIGINALS = Object.freeze([
  { id: 1, start: 0, end: 2, text: 'The original line' },
  { id: 2, start: 2, end: 4, text: 'The second original line' },
]);

// Timed only by `originalId`, which is the shape the translation pipeline actually produces and the
// reason the preview must ask the export's own re-timing rather than read `start`/`end`.
const TRANSLATIONS = Object.freeze([
  { id: 11, originalId: 1, text: 'La ligne originale' },
  { id: 12, originalId: 2, text: 'La deuxieme ligne originale' },
]);

const dormant = () => ({
  frame: null,
  status: 'idle',
  error: null,
  onFrameLoadError: vi.fn(),
  releaseSurface: vi.fn(),
  outsideTrim: false,
  owned: false,
});

const showing = (layer = 'composited') => ({
  ...dormant(),
  frame: { url: FRAME_URL, cacheKey: 'k', frameIndex: 0, layer },
  status: 'ready',
  owned: layer === 'composited',
});

const refused = (nativeCode) => ({
  ...dormant(),
  status: 'error',
  error: { code: 'nativePreviewRejected', nativeCode },
});

const mount = (props = {}, settings = SENTINEL_SETTINGS) => {
  localStorage.setItem('subtitle_settings', JSON.stringify(settings));
  const utils = render(
    <VideoPreview
      currentTime={1}
      setCurrentTime={vi.fn()}
      setDuration={vi.fn()}
      videoSource="C:/media/clip.mp4"
      fileType="video"
      onSeek={vi.fn()}
      subtitlesArray={ORIGINALS}
      translatedSubtitles={[]}
      {...props}
    />,
  );
  return { ...utils, video: utils.container.querySelector('video') };
};

/** Bring the `<video>` to the point where the surface may judge the compositor's availability. */
const finishLoading = (video) => {
  Object.defineProperty(video, 'duration', { value: 12, configurable: true });
  fireEvent.loadedMetadata(video);
  fireEvent.canPlay(video);
};

const lastPreviewCall = () => vi.mocked(useNativePreview).mock.calls.at(-1)[0];

beforeEach(() => {
  localStorage.clear();
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
  vi.mocked(useNativePreview).mockReset();
  vi.mocked(useNativePreview).mockReturnValue(dormant());
});

describe('the WebView composes no subtitle appearance', () => {
  const assertNoSubtitleAppearance = (container) => {
    // The values themselves: nothing on screen was styled FROM the user's subtitle settings.
    const markup = container.innerHTML;
    for (const value of SENTINEL_VALUES) {
      expect(markup).not.toContain(value);
    }

    // And the properties, so a rule that comes back with hardcoded values fails too. Both the
    // inline styles and every <style> block the surface injects are checked, because the deleted
    // overlay used one of each.
    for (const node of container.querySelectorAll('*')) {
      const inline = node.getAttribute('style') ?? '';
      for (const property of SUBTITLE_APPEARANCE) {
        expect(inline).not.toContain(property);
      }
    }
    for (const styleBlock of container.querySelectorAll('style')) {
      for (const property of SUBTITLE_APPEARANCE) {
        expect(styleBlock.textContent).not.toContain(property);
      }
    }

    // The two implementations by name, in case one returns under a different mechanism.
    expect(container.querySelector('.custom-subtitle')).toBeNull();
    expect(container.querySelector('#fullscreen-subtitle')).toBeNull();
  };

  it('draws no subtitle style while the compositor is dormant', () => {
    const { container, video } = mount();
    finishLoading(video);

    assertNoSubtitleAppearance(container);
  });

  it('draws no subtitle style once a native frame owns the surface', () => {
    vi.mocked(useNativePreview).mockReturnValue(showing());
    const { container, video } = mount();
    finishLoading(video);
    fireEvent.load(container.querySelector('.native-composited-frame-pending'));

    assertNoSubtitleAppearance(container);
  });

  it('draws no subtitle style while the video is playing', () => {
    vi.mocked(useNativePreview).mockReturnValue(showing('subtitles'));
    const { container, video } = mount();
    finishLoading(video);
    fireEvent.play(video);
    fireEvent.timeUpdate(video);

    assertNoSubtitleAppearance(container);
  });
});

describe('the native frame is the only thing that shows a subtitle', () => {
  it('shows the composited frame once it has decoded, and nothing before', () => {
    vi.mocked(useNativePreview).mockReturnValue(showing());
    const { container, video } = mount();
    finishLoading(video);

    // Returned but not decoded: the surface holds rather than flashing something else in.
    expect(container.querySelector('.native-composited-frame')).toBeNull();

    fireEvent.load(container.querySelector('.native-composited-frame-pending'));

    const shown = container.querySelector('.native-composited-frame');
    expect(shown.getAttribute('src')).toBe(FRAME_URL);
    expect(shown.getAttribute('data-layer')).toBe('composited');
  });

  it('asks for the subtitle layer during playback and the composited frame at rest', () => {
    vi.mocked(useNativePreview).mockReturnValue(showing());
    const { video } = mount();
    finishLoading(video);
    expect(lastPreviewCall().playing).toBe(false);

    fireEvent.play(video);
    expect(lastPreviewCall().playing).toBe(true);

    fireEvent.pause(video);
    expect(lastPreviewCall().playing).toBe(false);
  });
});

describe('preview failures stay outside the picture', () => {
  it('never inserts a dormant-state banner into the video surface', () => {
    const { video, container } = mount();
    finishLoading(video);

    expect(container.querySelector('.video-container .error')).toBeNull();
    expect(screen.queryByText(/Subtitle preview unavailable/)).toBeNull();
  });

  it('reports a typed refusal through the deduplicated toast channel', async () => {
    vi.mocked(useNativePreview).mockReturnValue(refused('previewSceneRefused'));
    const { video, container } = mount();
    finishLoading(video);

    expect(container.querySelector('.video-container .error')).toBeNull();
    await waitFor(() => expect(window.addToast).toHaveBeenCalledWith(
      expect.stringMatching(/previewSceneRefused/),
      'error',
      8000,
      'native-subtitle-preview',
      expect.objectContaining({ text: 'Retry' }),
    ));
  });

  it('the toast retry releases a terminal preview surface', async () => {
    const preview = refused('previewDeviceLost');
    vi.mocked(useNativePreview).mockReturnValue(preview);
    const { video } = mount();
    finishLoading(video);

    await waitFor(() => expect(window.addToast).toHaveBeenCalled());
    const button = window.addToast.mock.calls.at(-1)[4];
    button.onClick();
    expect(preview.releaseSurface).toHaveBeenCalledTimes(1);
  });
});

describe('the cue list the compositor is given', () => {
  it('is the originals while translated subtitles are off', () => {
    mount({ translatedSubtitles: TRANSLATIONS });

    expect(lastPreviewCall().subtitles).toBe(ORIGINALS);
  });

  // The defect this change had to fix first: the native frame was fed the originals unconditionally
  // while the deleted CSS overlay showed the translation, so the two layers of one surface disagreed.
  it('is the translation, re-timed the way the export re-times it, when the setting is on', () => {
    mount(
      { translatedSubtitles: TRANSLATIONS },
      { ...SENTINEL_SETTINGS, showTranslatedSubtitles: true },
    );

    expect(lastPreviewCall().subtitles).toEqual([
      { id: 11, start: 0, end: 2, text: 'La ligne originale' },
      { id: 12, start: 2, end: 4, text: 'La deuxieme ligne originale' },
    ]);
  });

  it('falls back to the originals when the setting is on but nothing is translated', () => {
    mount({ translatedSubtitles: [] }, { ...SENTINEL_SETTINGS, showTranslatedSubtitles: true });

    expect(lastPreviewCall().subtitles).toBe(ORIGINALS);
  });
});

describe('a project that has no subtitles at all', () => {
  /**
   * The state the editor is in for every customer between opening a video and adding subtitles, and
   * the one the surface has the least excuse for getting wrong.
   *
   * `subtitlesArray` is genuinely `null` then, not an empty array. A version of this surface read
   * `.length` from it directly: every existing test passed, because they all supply cues, and the
   * real application crashed the moment a video was opened — the video element never appeared at
   * all, which the real-binary journey caught and this suite did not.
   */
  it('renders an unobstructed video and publishes the empty state', () => {
    const { video, container } = mount({ subtitlesArray: null });
    expect(video).not.toBeNull();

    finishLoading(video);

    expect(container.querySelector('[data-osg-preview="empty"]')).not.toBeNull();
    expect(container.querySelector('.native-preview-empty')).toBeNull();
    expect(container.querySelector('.native-preview-unavailable')).toBeNull();
  });

  it('survives an undefined cue list as well', () => {
    const { video } = mount({ subtitlesArray: undefined });
    expect(video).not.toBeNull();
    finishLoading(video);
  });
});
