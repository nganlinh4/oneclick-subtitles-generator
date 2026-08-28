// One real Settings journey covers mutually exclusive surfaces, then proves representative writes
// at the browser, SQLite, reload/reset, and filesystem boundaries. It never invokes a command
// directly: every mutation below begins with a public control a customer can click.
/* global $, $$, browser, describe, document, getComputedStyle, it, localStorage, MutationObserver, performance, process, window */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  basename, join, resolve,
} from 'node:path';

import { clickControl, openEditor, waitForEditorReady } from '../support/editor.js';
import {
  appearanceSnapshot,
  selectAlternateDropdownOption,
} from '../support/settingsAppearance.js';
import { withDatabase } from '../support/database.js';
import {
  ENGINE_PACKAGES_CACHE, NATIVE_TOOLS_CACHE, runRootAuthorization,
} from '../support/environment.js';
import { digestFrameRgbaRegion } from '../support/nativeMediaOracle.js';
import {
  directoryShapeDigest,
  durableCustomerIdentity,
  durableSettings,
  durableWorkspaceIdentity,
} from '../support/settingsSurfaceOracle.js';
import {
  importSubtitles,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import {
  captureWorkflowStep,
  workflowEvidenceDirectory,
} from '../support/workflowEvidence.js';

const WORKFLOW = 'settings-surface';
const PROMPT_MARKER = 'OSG real-binary settings persistence journey.';
const SETTING_KEYS = Object.freeze([
  'theme',
  'app_font',
  'preferred_language',
  'time_format',
  'show_waveform_long_videos',
  'transcription_prompt',
]);
const SETTINGS_CHROME_REGIONS = Object.freeze({
  title: Object.freeze({ x: 40, y: 35, width: 140, height: 45 }),
  close: Object.freeze({ x: 1318, y: 34, width: 48, height: 48 }),
  footer: Object.freeze({ x: 40, y: 810, width: 540, height: 60 }),
});

const settingsScreenshotPath = (step) => {
  const attempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  assert.match(attempt ?? '', /^[a-z0-9-]+$/u, 'Settings screenshot has no bounded evidence attempt');
  return join(workflowEvidenceDirectory(WORKFLOW), 'attempts', attempt, `${step}.png`);
};

const settingsChromePixelDigest = (step) => Object.fromEntries(
  Object.entries(SETTINGS_CHROME_REGIONS).map(([name, region]) => [
    name,
    digestFrameRgbaRegion(settingsScreenshotPath(step), region).sha256,
  ]),
);

const assertSettingsChromePixels = (step, baseline) => {
  const digest = settingsChromePixelDigest(step);
  if (baseline !== null) {
    assert.deepEqual(
      digest,
      baseline,
      `${step} lost or moved title, close, or footer pixels in the saved PNG`,
    );
  }
  return digest;
};

const assertDisposableFactoryResetRoot = (root) => {
  const canonicalRoot = resolve(root);
  // Factory reset is destructive, so it may only ever run against a root this harness owns.
  // The ownership proof is the managed run-root contract itself -- authorized parent, the
  // managed staging lane, the exact private layout and a live authority token -- which
  // runRootAuthorization validates and refuses. An earlier version required the root to sit
  // under %TEMP%; run roots moved into the managed staging lane, so that test refused every
  // legitimate root while proving strictly less about ownership than the authority does.
  try {
    runRootAuthorization(canonicalRoot);
  } catch (error) {
    assert.fail(
      `factory reset refuses a run root this harness does not own: ${canonicalRoot} (${error.message})`,
    );
  }
  assert.ok(
    basename(canonicalRoot).startsWith('osg-e2e-run-'),
    `factory reset refuses a non-disposable run root: ${canonicalRoot}`,
  );
  const credentialReferences = withDatabase(root, database => Number(
    database.prepare('SELECT COUNT(*) AS count FROM credential_refs').get().count,
  ));
  assert.equal(
    credentialReferences,
    0,
    'factory reset refuses a profile whose credential references could reach the OS vault',
  );
};

const mediaPickerRequestCount = (root) => {
  const log = readFileSync(join(root, 'logs', 'osg.log'), 'utf8');
  return [...log.matchAll(/"event":"media-picker\.requested"/gu)].length;
};

const waitForRestoredMedia = async () => {
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

const assertSettingsArrowIsolation = async (selector) => {
  const before = await browser.execute((target) => {
    const control = document.querySelector(target);
    const video = document.querySelector('.video-preview video.video-player');
    if (control === null || video === null) return null;
    window.__OSG_E2E_SETTINGS_ARROW__ = null;
    control.addEventListener('keydown', (event) => {
      window.__OSG_E2E_SETTINGS_ARROW__ = {
        code: event.code,
        key: event.key,
        ownedByControl: event.target === control || control.contains(event.target),
      };
    }, { once: true });
    control.focus();
    return { currentTime: video.currentTime, focused: document.activeElement === control };
  }, selector);
  assert.equal(before?.focused, true, 'the Settings control could not own keyboard focus');
  await browser.keys('\uE014');
  let after = null;
  await browser.waitUntil(async () => {
    after = await browser.execute((target) => {
      const control = document.querySelector(target);
      const video = document.querySelector('.video-preview video.video-player');
      return {
        event: window.__OSG_E2E_SETTINGS_ARROW__ ?? null,
        currentTime: video?.currentTime ?? null,
        focused: document.activeElement === control,
      };
    }, selector);
    return after.event !== null;
  }, {
    timeout: 5_000,
    interval: 50,
    timeoutMsg: 'ArrowRight never reached the focused Settings control',
  });
  assert.equal(after.event.ownedByControl, true, 'ArrowRight escaped its Settings control');
  assert.equal(after.event.code, 'ArrowRight');
  assert.equal(after.focused, true, 'ArrowRight moved focus out of the Settings control');
  assert.ok(
    Math.abs(after.currentTime - before.currentTime) < 0.001,
    `Settings ArrowRight sought the background video: ${JSON.stringify({ before, after })}`,
  );
};

const TAB_SURFACES = Object.freeze([
  {
    tab: 'api-keys', step: '01-api-keys', root: '.api-key-section', minimumControls: 3,
    required: ['.gemini-column', '#genius-key-input'],
    claim: 'Credential forms render without exposing or changing a secret.',
  },
  {
    tab: 'video-processing', step: '02-video-processing', root: '.video-processing-section', minimumControls: 8,
    required: [
      '#show-waveform-long-videos',
      '.compact-setting:has(label[for="time-format"]) .custom-dropdown-button',
      '#auto-import-site-subtitles',
    ],
    claim: 'Processing, display, and download preferences are reachable.',
  },
  {
    tab: 'prompts', step: '03-prompts', root: '.prompts-section', minimumControls: 3,
    required: ['#transcription-prompt', '.reset-prompt-btn'],
    claim: 'Prompt presets and the editable transcription prompt are reachable.',
  },
  {
    tab: 'cache', step: '04-cache', root: '.cache-section', minimumControls: 2,
    required: ['.clear-cache-btn', '.refresh-cache-btn'],
    claim: 'The cache surface reports the native rebuildable-only inventory.',
  },
  {
    tab: 'model-management', step: '05-narration-models', root: '.narration-model-panel', minimumControls: 0,
    required: ['.narration-model-package'],
    claim: 'The catalog-managed narration package reports an explicit state.',
  },
  {
    tab: 'tools', step: '06-tools', root: '.engines-panel', minimumControls: 1,
    required: ['[data-engine-id]', '[data-native-tool-id]'],
    claim: 'Native tools and local engines report their actual installed states.',
  },
  {
    tab: 'about', step: '07-about', root: '.about-section', minimumControls: 1,
    required: ['.version-info', '.replay-onboarding-button'],
    claim: 'Version, update status, and support links render without opening an external target.',
  },
]);

const settingsDiagnostic = () => browser.execute(() => ({
  modalPresent: document.querySelector('.settings-modal') !== null,
  activeTab: document.querySelector('.settings-tab.active')?.getAttribute('data-settings-tab') ?? null,
  errors: window.__OSG_E2E_SETTINGS_ERRORS__ ?? [],
  lifecycle: (window.__OSG_E2E_SETTINGS_LIFECYCLE__ ?? []).slice(-80),
  settingsResources: performance.getEntriesByType('resource')
    .map((entry) => ({ name: entry.name, duration: entry.duration, transferSize: entry.transferSize }))
    .filter(({ name }) => /SettingsModal|settings/i.test(name))
    .slice(-20),
}));

const installBrowserDiagnostics = () => browser.execute(() => {
  window.__OSG_E2E_SETTINGS_ERRORS__ = [];
  window.__OSG_E2E_SETTINGS_LIFECYCLE__ = [];
  const record = (kind, detail = '') => {
    window.__OSG_E2E_SETTINGS_LIFECYCLE__.push({ kind, detail, at: performance.now() });
  };
  window.addEventListener('error', (event) => {
    window.__OSG_E2E_SETTINGS_ERRORS__.push(`error:${event.message}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    window.__OSG_E2E_SETTINGS_ERRORS__.push(`rejection:${String(event.reason)}`);
  });
  const observer = new MutationObserver(() => {
    const modal = document.querySelector('.settings-modal');
    const current = modal === null ? 'absent' : `present:${modal.className}`;
    if (window.__OSG_E2E_SETTINGS_LAST__ !== current) {
      window.__OSG_E2E_SETTINGS_LAST__ = current;
      record('modal', current);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  window.__OSG_E2E_SETTINGS_OBSERVER__ = observer;
});

const openSettings = async () => {
  await clickControl('[data-app-action="open-settings"]');
  const modal = await $('.settings-modal');
  const opened = await modal.waitForDisplayed({ timeout: 30_000 }).catch(() => false);
  assert.equal(opened, true, `Settings did not open: ${JSON.stringify(await settingsDiagnostic())}`);
};

const waitForLiveToastsToDismiss = async () => {
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

const waitForSettingsPaintStable = async () => {
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

const settingsChromeGeometry = () => browser.execute(() => {
  const selectorFor = (node) => {
    if (node === null || typeof node.tagName !== 'string') return null;
    const className = [...node.classList].slice(0, 3).join('.');
    return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${className ? `.${className}` : ''}`;
  };
  const rectangle = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  };
  const ownsPaintedPoint = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    // Rounded controls intentionally leave transparent corner pixels. The painted centre is the
    // point a real pointer action owns, so checking it detects an overlay without misclassifying
    // the button's own border radius as occlusion.
    const points = [[rect.left + rect.width / 2, rect.top + rect.height / 2]];
    return points.map(([x, y]) => {
      const painted = document.elementFromPoint(x, y);
      return {
        x,
        y,
        owns: painted !== null && (painted === node || node.contains(painted)),
        painted: selectorFor(painted),
      };
    });
  };
  const overlay = document.querySelector('.settings-modal-overlay');
  const modal = document.querySelector('.settings-modal');
  const header = document.querySelector('.settings-header');
  const content = document.querySelector('.settings-content');
  const footer = document.querySelector('.settings-footer');
  const historyContainer = document.querySelector('.toast-history-button-container');
  const historyButton = historyContainer?.querySelector('.toast-history-button') ?? null;
  const historyStyle = historyContainer === null ? null : getComputedStyle(historyContainer);
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    overlayPointerEvents: overlay === null ? null : getComputedStyle(overlay).pointerEvents,
    horizontalScroll: {
      window: window.scrollX,
      document: document.documentElement.scrollLeft,
      body: document.body.scrollLeft,
      overlay: document.querySelector('.settings-modal-overlay')?.scrollLeft ?? null,
      modal: document.querySelector('.settings-modal')?.scrollLeft ?? null,
      header: document.querySelector('.settings-header')?.scrollLeft ?? null,
      content: document.querySelector('.settings-content')?.scrollLeft ?? null,
    },
    verticalScroll: {
      window: window.scrollY,
      document: document.documentElement.scrollTop,
      body: document.body.scrollTop,
      overlay: overlay?.scrollTop ?? null,
      modal: modal?.scrollTop ?? null,
      header: header?.scrollTop ?? null,
      content: content?.scrollTop ?? null,
      footer: footer?.scrollTop ?? null,
    },
    paintedOwnership: {
      title: ownsPaintedPoint('.settings-header h2'),
      close: ownsPaintedPoint('.settings-header .close-button-settings'),
      footerLeft: ownsPaintedPoint('.settings-footer-left'),
      footerRight: ownsPaintedPoint('.settings-footer-right'),
    },
    overlay: rectangle('.settings-modal-overlay'),
    modal: rectangle('.settings-modal'),
    header: rectangle('.settings-header'),
    title: rectangle('.settings-header h2'),
    close: rectangle('.settings-header .close-button-settings'),
    footer: rectangle('.settings-footer'),
    ambientHistory: historyContainer === null ? null : {
      hidden: historyContainer.hidden,
      ariaHidden: historyContainer.getAttribute('aria-hidden'),
      display: historyStyle.display,
      visibility: historyStyle.visibility,
      pointerEvents: historyStyle.pointerEvents,
      buttonDisabled: historyButton?.disabled ?? null,
      buttonTabIndex: historyButton?.tabIndex ?? null,
    },
  };
});

const assertSettingsChromeInViewport = async (tab, baseline = null) => {
  const geometry = await settingsChromeGeometry();
  const epsilon = 1;
  const insideViewport = (rect) => rect !== null
    && rect.width > 0
    && rect.height > 0
    && rect.left >= -epsilon
    && rect.top >= -epsilon
    && rect.right <= geometry.viewport.width + epsilon
    && rect.bottom <= geometry.viewport.height + epsilon;

  assert.ok(
    Object.values(geometry.horizontalScroll).every((value) => (
      Number.isFinite(value) && Math.abs(value) <= epsilon
    )),
    `${tab} scrolled a page ancestor horizontally: ${JSON.stringify(geometry)}`,
  );
  assert.equal(
    geometry.overlayPointerEvents,
    'auto',
    `${tab} allowed pointer input through the Settings backdrop: ${JSON.stringify(geometry)}`,
  );
  for (const [part, points] of Object.entries(geometry.paintedOwnership)) {
    assert.ok(
      Array.isArray(points) && points.every(({ owns }) => owns),
      `${tab} visually occluded the Settings ${part}: ${JSON.stringify(geometry)}`,
    );
  }
  for (const part of ['overlay', 'modal', 'header', 'title', 'close', 'footer']) {
    assert.equal(
      insideViewport(geometry[part]),
      true,
      `${tab} moved the Settings ${part} outside the viewport: ${JSON.stringify(geometry)}`,
    );
  }
  assert.deepEqual(
    geometry.ambientHistory,
    {
      hidden: true,
      ariaHidden: 'true',
      display: 'none',
      visibility: 'visible',
      pointerEvents: 'none',
      buttonDisabled: true,
      buttonTabIndex: -1,
    },
    `${tab} exposed ambient toast-history chrome over Settings: ${JSON.stringify(geometry)}`,
  );
  if (baseline !== null) {
    for (const edge of ['left', 'top', 'right', 'bottom']) {
      assert.ok(
        Math.abs(geometry.modal[edge] - baseline.modal[edge]) <= epsilon,
        `${tab} moved the Settings modal ${edge}: ${JSON.stringify({ baseline, geometry })}`,
      );
    }
  }
  return geometry;
};

const activateTab = async (tab) => {
  const selector = `[data-settings-tab="${tab}"]`;
  await clickControl(selector);
  await browser.waitUntil(async () => (await $(selector).getAttribute('class')).includes('active'), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: `Settings tab did not activate: ${tab}`,
  });
  if (tab === 'cache') {
    await browser.waitUntil(async () => (
      (await $('.cache-section').getAttribute('data-cache-state')) !== 'checking'
    ), {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'Cache inventory never settled before its screenshot',
    });
  }
  if (tab === 'model-management') {
    await browser.waitUntil(async () => (
      (await $('.narration-model-panel').getAttribute('data-model-package-state')) !== 'checking'
    ), {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'Narration model status never settled before its screenshot',
    });
  }
  if (tab === 'tools') {
    // The first status probe per process deliberately hashes the COMPLETE published engine tree
    // before reporting anything installed (verify-once, then cached) — tens of seconds at the
    // measured disk rate. A ten-minute 'checking' therefore means a stalled probe, not a slow
    // hash; name which inventory is stuck so the failure carries its own diagnosis.
    let asr = null;
    let speech = null;
    try {
      await browser.waitUntil(async () => {
        const panel = await $('.engines-panel');
        asr = await panel.getAttribute('data-asr-package-status');
        speech = await panel.getAttribute('data-speech-package-status');
        return asr !== 'checking' && speech !== 'checking';
      }, {
        timeout: 600_000,
        interval: 250,
        timeoutMsg: 'native tool inventory settle timeout',
      });
    } catch (error) {
      throw new Error(
        `Native tool inventories never settled before their screenshot: asr=${asr} speech=${speech}`,
        { cause: error },
      );
    }
  }
  await waitForSettingsPaintStable();
};

const activeControlMap = (rootSelector, requiredSelectors) => browser.execute((
  expectedRoot,
  expectedSelectors,
) => {
  const active = document.querySelector('.settings-tab-content.active');
  const root = active?.querySelector(expectedRoot) ?? null;
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      && rect.width > 0 && rect.height > 0;
  };
  const controls = root === null ? [] : [...root.querySelectorAll(
    'button, input, textarea, select, md-switch, [role="button"], [role="slider"]',
  )].filter(visible);
  return {
    activePanels: document.querySelectorAll('.settings-tab-content.active').length,
    rootPresent: root !== null,
    controls: controls.length,
    buttons: controls.filter((node) => node.matches('button, [role="button"]')).length,
    fields: controls.filter((node) => node.matches('input, textarea, select')).length,
    switches: controls.filter((node) => node.matches('md-switch')).length,
    stableActions: controls.map((node) => (
      node.getAttribute('data-tool-action')
      ?? node.getAttribute('data-cache-category')
      ?? node.id
      ?? null
    )).filter(Boolean).slice(0, 40),
    required: Object.fromEntries(expectedSelectors.map((selector) => [
      selector,
      Boolean(root?.querySelector(selector)),
    ])),
    externalLinks: root === null ? 0 : root.querySelectorAll('a[target="_blank"]').length,
  };
}, rootSelector, requiredSelectors);

const switchSelected = (selector) => browser.execute(
  (target) => document.querySelector(target)?.selected ?? null,
  selector,
);

const publicToolRemovalGuard = async () => {
  const target = await browser.execute(() => {
    const native = [...document.querySelectorAll('[data-native-tool-id]')]
      .find((row) => row.querySelector('[data-tool-action="remove-request"]') !== null);
    if (native !== undefined) {
      return {
        kind: 'native-tool',
        id: native.getAttribute('data-native-tool-id'),
        state: native.getAttribute('data-tool-state'),
      };
    }
    return document.querySelector('.engines-panel__uninstall-all') === null
      ? null
      : { kind: 'all-engines' };
  });
  if (target === null) {
    return { reachable: false, deletionProven: false, reason: 'no installed package exposed removal' };
  }

  if (target.kind === 'native-tool') {
    assert.match(target.id, /^[a-z0-9-]+$/u, 'native tool id is not safe for a public selector');
    const row = `[data-native-tool-id="${target.id}"]`;
    await clickControl(`${row} [data-tool-action="remove-request"]`);
    const confirm = await $(`${row} [data-tool-action="remove-confirm"]`);
    await confirm.waitForDisplayed({ timeout: 10_000 });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '13-tool-removal-confirmation',
      description: 'Removing an installed native tool requires an explicit second public action.',
      details: {
        target: target.id,
        stateBefore: target.state,
        confirmed: false,
        deletionProven: false,
        reason: 'shared tool packages intentionally survive isolated journeys',
      },
      focusSelector: row,
    });
    await clickControl(`${row} [data-tool-action="remove-cancel"]`);
    assert.equal(await $(`${row} [data-tool-action="remove-request"]`).isExisting(), true);
    return { reachable: true, deletionProven: false, target: target.id, cancelled: true };
  }

  await clickControl('.engines-panel__uninstall-all');
  const confirmation = await $('.engines-panel__confirm-all');
  await confirmation.waitForDisplayed({ timeout: 10_000 });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: '13-tool-removal-confirmation',
    description: 'Removing installed engines requires a second public action.',
    details: {
      target: 'installed-engines',
      confirmed: false,
      deletionProven: false,
      reason: 'shared engine packages intentionally survive isolated journeys',
    },
    focusSelector: '.engines-panel__confirm-all',
  });
  await clickControl('.engines-panel__confirm-all .engine-card__btn--ghost');
  assert.equal(await $('.engines-panel__uninstall-all').isExisting(), true);
  return { reachable: true, deletionProven: false, target: 'installed-engines', cancelled: true };
};

describe('a customer changes and safely resets Settings', () => {
  it('covers every tab, persists representative choices, and preserves owned work', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Settings journey requires an isolated application root');
    const cleanSettings = Object.fromEntries(SETTING_KEYS.map((key) => [key, null]));
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      cleanSettings,
      'clean-install display fallbacks were persisted without a user action',
    );

    await openProjectWithMedia();
    await importSubtitles();
    await seekPreviewTo(1);
    await waitForCanvasSubtitleFrame();
    const customerAtStart = durableCustomerIdentity(root);
    assert.equal(customerAtStart.projects.length, 1, 'the public import did not create a project');
    assert.equal(customerAtStart.media.length, 1, 'the public import did not retain its media');
    assert.ok(customerAtStart.cues.length > 0, 'the public subtitle import did not persist cues');
    assert.ok(customerAtStart.sourceFiles.every(({ available, sha256 }) => available && sha256));
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '00-owned-project',
      description: 'A real imported video and subtitle scene are playable before Settings changes.',
      details: {
        projects: customerAtStart.projects.length,
        media: customerAtStart.media.length,
        cues: customerAtStart.cues.length,
        sourceFiles: customerAtStart.sourceFiles.map(({ relativePath, size, sha256 }) => ({
          relativePath, size, sha256,
        })),
      },
      focusSelector: '.video-preview',
    });

    // The import success toast is useful evidence in step 00, but the Settings screenshots
    // describe steady surfaces. Prove that the real timer removes it before opening the modal.
    await waitForLiveToastsToDismiss();

    await installBrowserDiagnostics();
    await openSettings();
    let settingsChromeBaseline = null;
    let darkChromePixelBaseline = null;
    for (const surface of TAB_SURFACES) {
      await activateTab(surface.tab);
      const geometry = await assertSettingsChromeInViewport(
        surface.tab,
        settingsChromeBaseline,
      );
      settingsChromeBaseline ??= geometry;
      const controlMap = await activeControlMap(surface.root, surface.required);
      assert.equal(controlMap.activePanels, 1, `Settings rendered overlapping panels on ${surface.tab}`);
      assert.equal(controlMap.rootPresent, true, `Settings omitted the ${surface.tab} root`);
      assert.ok(
        controlMap.controls >= surface.minimumControls,
        `${surface.tab} rendered too few public controls: ${JSON.stringify(controlMap)}`,
      );
      assert.ok(
        Object.values(controlMap.required).every(Boolean),
        `${surface.tab} omitted a mapped public control: ${JSON.stringify(controlMap.required)}`,
      );
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: surface.step,
        description: surface.claim,
        details: { tab: surface.tab, controlMap, geometry },
        focusSelector: '.settings-modal',
      });
      darkChromePixelBaseline = assertSettingsChromePixels(
        surface.step,
        darkChromePixelBaseline,
      );
    }

    const initialAppearance = await appearanceSnapshot();
    await clickControl('.settings-footer-controls .theme-toggle');
    await selectAlternateDropdownOption(
      '.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button',
    );
    await selectAlternateDropdownOption(
      '.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown)'
        + ' > .custom-dropdown-button',
    );
    const changedAppearance = await appearanceSnapshot();
    assert.notEqual(changedAppearance.theme, initialAppearance.theme, 'theme did not change');
    assert.equal(changedAppearance.documentTheme, changedAppearance.theme, 'theme was not painted');
    assert.notEqual(changedAppearance.font, initialAppearance.font, 'application font did not change');
    assert.notEqual(changedAppearance.language, initialAppearance.language, 'language did not change');
    const changedPaint = await waitForSettingsPaintStable();
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '08-appearance-changed',
      description: 'Theme, application font, and language change through their real footer controls.',
      details: { before: initialAppearance, after: changedAppearance, paint: changedPaint },
      focusSelector: '.settings-modal',
    });
    const changedChromePixelBaseline = assertSettingsChromePixels(
      '08-appearance-changed',
      null,
    );

    await activateTab('video-processing');
    await assertSettingsArrowIsolation(
      '.video-processing-section .compact-setting:has(label[for="time-format"])'
        + ' .custom-dropdown-button',
    );
    const waveformBefore = await switchSelected('#show-waveform-long-videos');
    assert.equal(typeof waveformBefore, 'boolean', 'waveform preference switch is unavailable');
    await clickControl('#show-waveform-long-videos');
    const waveformAfter = await switchSelected('#show-waveform-long-videos');
    assert.equal(waveformAfter, !waveformBefore, 'waveform preference did not toggle');
    const timeFormatLabels = await selectAlternateDropdownOption(
      '.video-processing-section .compact-setting:has(label[for="time-format"])'
        + ' .custom-dropdown-button',
    );
    const timeFormatExpected = ['seconds', 'hms'][timeFormatLabels.optionIndex];
    assert.ok(timeFormatExpected, 'time format exposed an undocumented option');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '09-processing-edits',
      description: 'A display format and long-video processing preference change through public controls.',
      details: {
        waveform: { before: waveformBefore, after: waveformAfter },
        timeFormat: { expected: timeFormatExpected, labels: timeFormatLabels },
      },
      // The section is intentionally taller than the modal viewport. Bind the evidence to the
      // changed control that the public interaction just brought into view, not to an element that
      // can never be wholly visible.
      focusSelector: '.video-processing-section .compact-setting:has(label[for="time-format"])',
    });
    assertSettingsChromePixels('09-processing-edits', changedChromePixelBaseline);

    await activateTab('prompts');
    const prompt = await $('#transcription-prompt');
    const originalPrompt = await prompt.getValue();
    assert.match(originalPrompt, /\{contentType\}/u, 'the required prompt placeholder is absent');
    const changedPrompt = originalPrompt.includes(PROMPT_MARKER)
      ? originalPrompt
      : `${originalPrompt.trimEnd()}\n\n${PROMPT_MARKER}`;
    await prompt.setValue(changedPrompt);
    assert.equal(await prompt.getValue(), changedPrompt, 'the prompt field did not accept the edit');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '10-prompt-edited',
      description: 'The transcription prompt is edited while its required content placeholder remains intact.',
      details: {
        changedCharacters: changedPrompt.length - originalPrompt.length,
        requiredPlaceholderPresent: changedPrompt.includes('{contentType}'),
      },
      focusSelector: '.transcription-prompt-setting',
    });
    assertSettingsChromePixels('10-prompt-edited', changedChromePixelBaseline);

    const save = await $('.save-btn');
    await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Settings never marked the public edits as saveable',
    });
    await clickControl('.save-btn');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });

    const expectedSettings = {
      theme: changedAppearance.theme,
      app_font: changedAppearance.font,
      preferred_language: changedAppearance.language,
      time_format: timeFormatExpected,
      show_waveform_long_videos: String(waveformAfter),
      transcription_prompt: changedPrompt,
    };
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      expectedSettings,
      'the public Save action did not commit the exact settings to SQLite',
    );

    await openSettings();
    const restoredAppearance = await appearanceSnapshot();
    assert.deepEqual(
      {
        theme: restoredAppearance.theme,
        documentTheme: restoredAppearance.documentTheme,
        font: restoredAppearance.font,
        language: restoredAppearance.language,
      },
      {
        theme: expectedSettings.theme,
        documentTheme: expectedSettings.theme,
        font: expectedSettings.app_font,
        language: expectedSettings.preferred_language,
      },
      'appearance choices did not survive closing and reopening Settings',
    );
    await activateTab('video-processing');
    assert.equal(await switchSelected('#show-waveform-long-videos'), waveformAfter);
    const restoredTimeLabel = await $(
      '.video-processing-section .compact-setting:has(label[for="time-format"])'
        + ' .custom-dropdown-button .dropdown-value',
    ).getText();
    assert.equal(restoredTimeLabel, timeFormatLabels.selected, 'time format did not restore in the UI');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '11-persisted-preferences',
      description: 'Appearance and processing choices restore from the durable preference snapshot.',
      details: { appearance: restoredAppearance, waveform: waveformAfter, timeFormat: timeFormatExpected },
      focusSelector: '.settings-modal',
    });
    assertSettingsChromePixels('11-persisted-preferences', changedChromePixelBaseline);

    await activateTab('prompts');
    assert.equal(await $('#transcription-prompt').getValue(), changedPrompt, 'prompt did not restore');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '12-persisted-prompt',
      description: 'The exact edited prompt restores after Settings remounts.',
      details: { characters: changedPrompt.length, requiredPlaceholderPresent: true },
      focusSelector: '.transcription-prompt-setting',
    });
    assertSettingsChromePixels('12-persisted-prompt', changedChromePixelBaseline);

    await activateTab('tools');
    const nativeToolsBefore = directoryShapeDigest(NATIVE_TOOLS_CACHE);
    const enginePackagesBefore = directoryShapeDigest(ENGINE_PACKAGES_CACHE);
    const removalGuard = await publicToolRemovalGuard();
    assert.deepEqual(
      directoryShapeDigest(NATIVE_TOOLS_CACHE),
      nativeToolsBefore,
      'cancelling removal changed native tools',
    );
    assert.deepEqual(
      directoryShapeDigest(ENGINE_PACKAGES_CACHE),
      enginePackagesBefore,
      'cancelling removal changed engines',
    );
    if (!removalGuard.reachable) {
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '13-tool-removal-unavailable',
        description: 'No installed package exposes removal in this isolated run; deletion remains unproven.',
        details: removalGuard,
        focusSelector: '.engines-panel',
      });
    }
    assertSettingsChromePixels(
      removalGuard.reachable
        ? '13-tool-removal-confirmation'
        : '13-tool-removal-unavailable',
      changedChromePixelBaseline,
    );

    const customerBeforeReset = durableCustomerIdentity(root);
    const workspaceBeforeReset = durableWorkspaceIdentity(root);
    assert.equal(customerBeforeReset.projects.length, 1, 'reset fixture has more than one project');
    assert.equal(customerBeforeReset.media.length, 1, 'reset fixture has more than one media asset');
    assert.equal(workspaceBeforeReset.initialized, true, 'native workspace authority was not initialized');
    assert.equal(workspaceBeforeReset.current?.projectId, customerBeforeReset.projects[0].id);
    assert.equal(workspaceBeforeReset.current?.mediaId, customerBeforeReset.media[0].id);
    assert.equal(workspaceBeforeReset.projectState?.trackId, customerBeforeReset.tracks[0].id);
    assert.equal(mediaPickerRequestCount(root), 1, 'the setup selected media more than once');
    const diagnosticBeforeReset = await settingsDiagnostic();
    assert.deepEqual(diagnosticBeforeReset.errors, [], 'Settings emitted a browser error');
    assertDisposableFactoryResetRoot(root);
    await clickControl('.factory-reset-btn');
    const resetToast = await $('.toast.toast-warning');
    await resetToast.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'factory reset skipped confirmation' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '14-factory-reset-confirmation',
      description: 'Factory reset is blocked behind an explicit warning and confirmation action.',
      details: {
        settingsToClear: SETTING_KEYS,
        projectDeletionExpected: false,
        sharedPackageDeletionExpected: false,
      },
      focusSelector: '.toast.toast-warning',
    });
    assertSettingsChromePixels('14-factory-reset-confirmation', changedChromePixelBaseline);
    await clickControl('.toast.toast-warning .toast-button');

    await browser.waitUntil(async () => {
      try {
        return await browser.execute(() => document.querySelector('.onboarding-overlay') !== null);
      } catch {
        return false;
      }
    }, {
      timeout: 90_000,
      interval: 250,
      timeoutMsg: 'factory reset did not reload into the clean-install public surface',
    });
    await waitForEditorReady();
    const onboarding = await openEditor();
    assert.equal(onboarding.dismissedOverlay, true, 'factory reset did not restore first-run onboarding');
    assert.equal(onboarding.dismissedControls, true, 'factory reset did not restore onboarding controls');
    // Preferences and the browser mirror were cleared, but the exact native workspace is product
    // state. It must hydrate without a second picker or content-hash recovery.
    await waitForRestoredMedia();
    await seekPreviewTo(1);
    await waitForCanvasSubtitleFrame();

    const customerAfterReset = durableCustomerIdentity(root);
    assert.deepEqual(
      customerAfterReset,
      customerBeforeReset,
      'factory reset changed customer-owned projects, subtitles, or source bytes',
    );
    assert.equal(customerAfterReset.projects.length, 1, 'reset duplicated the preserved project');
    assert.equal(customerAfterReset.media.length, 1, 'reset duplicated the preserved media asset');
    assert.deepEqual(
      customerAfterReset.cues.map(({ id, track_id: trackId, text_hash: textHash }) => ({
        id, trackId, textHash,
      })),
      customerBeforeReset.cues.map(({ id, track_id: trackId, text_hash: textHash }) => ({
        id, trackId, textHash,
      })),
      'reset restored different cue or track identities',
    );
    assert.deepEqual(
      durableWorkspaceIdentity(root),
      workspaceBeforeReset,
      'reset changed the exact native project, media, track, or alias identity',
    );
    assert.equal(
      mediaPickerRequestCount(root),
      1,
      'factory reset opened a second media picker instead of hydrating the native workspace',
    );
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      cleanSettings,
      'factory reset left one of the edited preferences durable',
    );
    await openSettings();
    await activateTab('prompts');
    const resetPrompt = await $('#transcription-prompt').getValue();
    assert.match(resetPrompt, /\{contentType\}/u, 'factory reset lost the prompt fallback');
    assert.equal(
      resetPrompt.includes(PROMPT_MARKER),
      false,
      'factory reset restored the edited prompt instead of the read-time default',
    );
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      cleanSettings,
      'opening Settings persisted display fallbacks without a user action',
    );
    await clickControl('[data-settings-action="close"]');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });
    assert.deepEqual(
      directoryShapeDigest(NATIVE_TOOLS_CACHE),
      nativeToolsBefore,
      'factory reset changed the shared native-tool package store',
    );
    assert.deepEqual(
      directoryShapeDigest(ENGINE_PACKAGES_CACHE),
      enginePackagesBefore,
      'factory reset changed the shared engine-package store',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '15-factory-reset-safe',
      description: 'After onboarding, the preserved project plays and draws subtitles while shared package shape remains unchanged.',
      details: {
        customerStatePreserved: true,
        workspaceIdentityPreserved: true,
        mediaPickerRequests: 1,
        clearedSettings: SETTING_KEYS,
        nativeToolDirectoryShape: nativeToolsBefore,
        enginePackageDirectoryShape: enginePackagesBefore,
        toolDeletionProven: false,
      },
      focusSelector: '.video-preview',
    });

  });
});

async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
