// The first launch on a fresh profile: does the real application reach a usable UI, with its
// managed default font really loaded, behind full-window first-run onboarding?
//
// The wait is on the editor actually rendering, not on `document.readyState`. A blank document
// reports `complete` too. The font half cannot be answered in jsdom: `document.fonts` is not
// implemented there and the native readiness bootstrap does not exist, so it is measured here.

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  dismissOnboarding,
  dismissOnboardingControls,
  waitForAutomationWindowIsolation,
} from '../support/editor.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

/* global browser, console, describe, document, getComputedStyle, it, window */

const WORKFLOW = 'startup';
const RENDER_TIMEOUT_MS = 90_000;

const inspect = () => browser.execute(() => ({
  href: document.location.href,
  readyState: document.readyState,
  hasRoot: document.querySelector('#root') !== null,
  rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
  bodyText: (document.body?.innerText || '').slice(0, 400),
  errorText: [...document.querySelectorAll('[role="alert"], [class*="error" i]')]
    .map((node) => node.innerText).filter(Boolean).slice(0, 5),
}));

/** The family the managed package declares. Stated here so the journey is readable standalone. */
const MANAGED_FAMILY = 'Google Sans';

const observe = () => browser.execute((family) => {
  const measure = (font) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = font;
    // Digits and Latin letters differ between almost any two real faces; a string of them is a
    // sensitive width probe without needing a glyph the fallback lacks.
    return context.measureText('0123456789 Handgloves ABCwxyz').width;
  };

  return {
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    // The typed record native publishes. Reported verbatim: "the bootstrap never ran" and "the
    // package is absent" are different failures and must not collapse into one boolean.
    readiness: window.__OSG_FONT_READINESS__ ?? null,
    fontsStatus: document.fonts?.status ?? 'no-font-face-set',
    faceCheck: document.fonts?.check(`400 16px '${family}'`) ?? null,
    loadedFamilies: [...(document.fonts ?? [])]
      .map((face) => `${face.family}/${face.weight}/${face.status}`).slice(0, 12),
    managedWidth: measure(`400 64px '${family}'`),
    // `sans-serif` alone is whatever the system resolves. If the managed family were missing, the
    // measurement above would fall back to exactly this and the two would be identical.
    fallbackWidth: measure('400 64px sans-serif'),
    documentFont: getComputedStyle(document.body).fontFamily,
  };
}, MANAGED_FAMILY);

const geometry = () => browser.execute(() => {
  const read = (selector) => {
    const node = document.querySelector(selector);
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      position: style.position,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      color: style.color,
      backgroundColor: style.backgroundColor,
      text: node.textContent?.trim() ?? '',
    };
  };
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    banner: read('.onboarding-overlay'),
    reveal: read('.onboarding-reveal-overlay'),
    card: read('.onboarding-reveal-card'),
    controls: read('.onboarding-controls-row'),
    settingsControls: read('.settings-footer-controls'),
    themeToggle: read('.settings-footer-controls .theme-toggle'),
    languageButton: read('.settings-footer-controls .custom-dropdown-button'),
    continueButton: read('.lets-go-btn'),
    continueLabel: read('.lets-go-text'),
    settingsButtonCovered: (() => {
      const button = document.querySelector('[data-app-action="open-settings"]');
      if (button === null) return null;
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit !== button && !button.contains(hit);
    })(),
  };
});

const assertCoversViewport = (rect, viewport, label) => {
  assert.ok(rect, `${label} is absent`);
  assert.equal(rect.left, 0, `${label} does not begin at the viewport left edge`);
  assert.equal(rect.top, 0, `${label} does not begin at the viewport top edge`);
  assert.equal(rect.width, viewport.width, `${label} does not span the viewport width`);
  assert.equal(rect.height, viewport.height, `${label} does not span the viewport height`);
};

describe('the application starts on a fresh profile', () => {
  it('renders hidden, loads its managed font, and shows centred full-window onboarding', async () => {
    const windowRect = await waitForAutomationWindowIsolation();
    let last = await inspect();
    console.log('first observation:\n' + JSON.stringify(last, null, 2));

    try {
      await browser.waitUntil(async () => {
        last = await inspect();
        return last.rootChildren > 0;
      }, {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: 'the editor never rendered before its timeout',
      });
    } catch (error) {
      last = await inspect();
      throw new Error(`the editor never rendered. last observation: ${JSON.stringify(last)}`, {
        cause: error,
      });
    }

    console.log('rendered observation:\n' + JSON.stringify(last, null, 2));
    assert.ok(last.rootChildren > 0, 'the React root must have rendered');
    assert.deepEqual(last.errorText, [], 'no error surface may be visible at startup');

    const logRoot = join(process.env.OSG_E2E_DATA_ROOT, 'logs');
    let hiddenMarker = false;
    await browser.waitUntil(() => {
      if (!existsSync(logRoot)) return false;
      hiddenMarker = readdirSync(logRoot, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.log'))
        .some((entry) => {
          try {
            return readFileSync(join(entry.parentPath, entry.name), 'utf8')
              .includes('automation.window_offscreen');
          } catch {
            // The append lock is transient on Windows. A locked candidate is not success, so the
            // bounded wait retries until the marker is readable or fails with the safety message.
            return false;
          }
        });
      return hiddenMarker;
    }, {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'the automation binary never recorded its permanent-hidden window branch',
    });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-hidden-rendered-editor',
      description: 'The compiled real app rendered while its native window remained hidden and off-screen.',
      details: { hiddenMarker, windowRect },
    });

    let seen = await observe();

    try {
      await browser.waitUntil(async () => {
        seen = await observe();
        // Fonts load asynchronously; waiting on the face rather than on a timer.
        return seen.rootChildren > 0 && seen.faceCheck === true
          && seen.readiness?.state === 'ready';
      }, {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: 'the managed font never became usable',
      });
    } catch (error) {
      throw new Error(
        'the managed font never became usable. last observation: '
          + JSON.stringify(seen, null, 2),
        { cause: error },
      );
    }

    console.log('font observation:\n' + JSON.stringify(seen, null, 2));

    assert.ok(seen.readiness, 'native must publish a readiness record into the WebView');
    assert.equal(seen.readiness.schema, 1, 'the frontend only understands schema 1');
    assert.equal(
      seen.readiness.state, 'ready',
      'native must report the managed package installed and verified; this is the record the '
        + 'frontend reads and whose absence made the default font unresolvable',
    );
    assert.ok(seen.readiness.version, 'a ready record names the version it verified');
    assert.equal(seen.readiness.reason, null, 'a ready record has nothing to refuse');
    assert.ok(seen.readiness.epoch > 0, 'the initial resolving record must have been superseded');
    assert.equal(seen.faceCheck, true, `'${MANAGED_FAMILY}' must be usable for drawing`);

    // The measurement is the part that cannot be faked by a lying flag: if the family were absent,
    // the canvas would silently fall back and both numbers would agree to the pixel.
    assert.notEqual(
      seen.managedWidth, seen.fallbackWidth,
      `'${MANAGED_FAMILY}' measured identically to the generic fallback, so the face is being `
        + 'substituted rather than loaded — a flag saying otherwise would be the exact failure this '
        + 'journey exists to catch',
    );
    assert.ok(seen.managedWidth > 0, 'the managed family must measure to something');

    const first = await geometry();
    assertCoversViewport(first.banner, first.viewport, 'the first onboarding overlay');
    assert.equal(first.settingsButtonCovered, true, 'the Settings action leaked above first-run onboarding');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-welcome',
      description: 'The first welcome screen fills the fresh application window.',
      details: first,
    });

    assert.equal(await dismissOnboarding(), true, 'the first onboarding stage was not shown');
    const second = await geometry();
    assertCoversViewport(second.reveal, second.viewport, 'the onboarding controls overlay');
    assertCoversViewport(second.card, second.viewport, 'the onboarding controls card');
    assert.ok(second.controls, 'the onboarding controls are absent');
    assert.ok(second.settingsControls, 'the theme and language controls are absent');
    assert.ok(second.themeToggle, 'the theme control is absent');
    assert.ok(second.languageButton, 'the language control is absent');
    assert.ok(second.controls.height <= 70, `the setup controls wrapped onto multiple rows: ${JSON.stringify(second)}`);
    assert.ok(second.settingsControls.height <= 42, `theme and language stacked vertically: ${JSON.stringify(second)}`);
    assert.ok(
      Math.abs(second.themeToggle.top - second.languageButton.top) <= 2,
      `theme and language do not share a row: ${JSON.stringify(second)}`,
    );
    assert.ok(second.continueLabel?.width >= 40, `the continue label has no painted width: ${JSON.stringify(second)}`);
    assert.equal(second.settingsButtonCovered, true, 'the Settings action leaked above onboarding preferences');
    assert.equal(second.continueLabel.visibility, 'visible', 'the continue label is hidden');
    assert.equal(second.continueLabel.opacity, '1', 'the continue label is transparent');
    const controlsCentreX = second.controls.left + second.controls.width / 2;
    const controlsCentreY = second.controls.top + second.controls.height / 2;
    assert.ok(
      Math.abs(controlsCentreX - second.viewport.width / 2) <= 2,
      `the onboarding controls are not horizontally centred: ${JSON.stringify(second)}`,
    );
    assert.ok(
      Math.abs(controlsCentreY - second.viewport.height / 2) <= 2,
      `the onboarding controls are not vertically centred: ${JSON.stringify(second)}`,
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-preferences',
      description: 'The original simple theme, language, and continue controls stay centred in one row.',
      details: second,
    });

    assert.equal(await dismissOnboardingControls(), true, 'the second onboarding stage was not shown');
  });
});
