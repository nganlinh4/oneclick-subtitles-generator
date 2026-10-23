// Bounded waits for the Settings surface journey: toasts, paint stability and restored media.
/* global browser, document, getComputedStyle */

export const waitForRestoredMedia = async () => {
  let playback = null;
  await waitUntilWithFreshDiagnostic(async () => {
    playback = await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      return {
        present: video !== null,
        duration: video?.duration ?? null,
        readyState: video?.readyState ?? null,
        source: video?.currentSrc ? 'assigned' : 'missing',
      };
    });
    return playback.present
      && Number.isFinite(playback.duration)
      && playback.duration > 0
      && playback.readyState >= 1
      && playback.source === 'assigned';
  }, {
    timeout: 180_000,
    interval: 500,
    diagnostic: () => `factory reset did not hydrate the exact active media: ${JSON.stringify(playback)}`,
  });
};

export const waitForLiveToastsToDismiss = async () => {
  let liveToasts = [];
  await waitUntilWithFreshDiagnostic(async () => {
    liveToasts = await browser.execute(() => [...document.querySelectorAll('.toast-item.live')]
      .map((toast) => toast.textContent?.trim() ?? ''));
    return liveToasts.length === 0;
  }, {
    timeout: 15_000,
    interval: 100,
    diagnostic: () => `A completed action toast did not auto-dismiss: ${JSON.stringify(liveToasts)}`,
  });
};

export const waitForSettingsPaintStable = async () => {
  let priorSignature = null;
  let stableSamples = 0;
  let lastPaint = null;
  await waitUntilWithFreshDiagnostic(async () => {
    lastPaint = await browser.execute(() => {
      const modal = document.querySelector('.settings-modal');
      const active = document.querySelector('.settings-tab-content.active');
      const footer = document.querySelector('.settings-footer');
      const heading = document.querySelector('.settings-header h2');
      const tabs = document.querySelector('.settings-tabs');
      const pill = tabs?.querySelector('.goo-blob') ?? null;
      if (modal === null || active === null || footer === null || heading === null) return null;
      const finiteAnimations = [document.documentElement, document.body, modal]
        .flatMap((node) => node.getAnimations({ subtree: true }))
        .filter((animation, index, animations) => animations.indexOf(animation) === index)
        .filter((animation) => Number.isFinite(Number(animation.effect?.getTiming().iterations ?? 1)))
        .map((animation) => ({
          playState: animation.playState,
          currentTime: Number(animation.currentTime ?? 0),
        }));
      const styleOf = (node) => {
        const style = getComputedStyle(node);
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          fontFamily: style.fontFamily,
          opacity: style.opacity,
          transform: style.transform,
        };
      };
      return {
        theme: document.documentElement.getAttribute('data-theme'),
        primaryFont: getComputedStyle(document.documentElement).getPropertyValue('--font-primary'),
        modal: styleOf(modal),
        active: styleOf(active),
        footer: styleOf(footer),
        heading: styleOf(heading),
        activePanels: document.querySelectorAll('.settings-tab-content.active').length,
        finiteAnimations,
        dropdownOpen: document.querySelector('.custom-dropdown-clipper') !== null,
        dropdownAnimating: document.querySelector('.custom-dropdown.is-animating-selection') !== null,
        motion: {
          tabsScrollLeft: tabs?.scrollLeft ?? null,
          pillLeft: pill?.style.left ?? null,
          pillWidth: pill?.style.width ?? null,
          pillTransform: pill?.style.transform ?? null,
        },
      };
    });
    const identityTransform = lastPaint?.active?.transform === 'none'
      || lastPaint?.active?.transform === 'matrix(1, 0, 0, 1, 0, 0)';
    if (lastPaint === null
        || lastPaint.dropdownOpen
        || lastPaint.dropdownAnimating
        || lastPaint.activePanels !== 1
        || lastPaint.active.opacity !== '1'
        || !identityTransform) {
      stableSamples = 0;
      priorSignature = null;
      return false;
    }
    if (lastPaint.finiteAnimations.some(({ playState }) => (
      playState === 'running' || playState === 'pending'
    ))) {
      stableSamples = 0;
      priorSignature = null;
      return false;
    }
    const signature = JSON.stringify({
      theme: lastPaint.theme,
      primaryFont: lastPaint.primaryFont,
      modal: lastPaint.modal,
      active: lastPaint.active,
      footer: lastPaint.footer,
      heading: lastPaint.heading,
      motion: lastPaint.motion,
    });
    stableSamples = signature === priorSignature ? stableSamples + 1 : 1;
    priorSignature = signature;
    return stableSamples >= 3;
  }, {
    timeout: 15_000,
    interval: 100,
    diagnostic: () => `Settings never reached a stable painted state: ${JSON.stringify(lastPaint)}`,
  });
  return lastPaint;
};

export async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
