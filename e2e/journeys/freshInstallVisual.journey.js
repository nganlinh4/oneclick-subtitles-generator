/* global $, browser, describe, it, document, window */

import assert from 'node:assert/strict';

import {
  dismissOnboarding,
  dismissOnboardingControls,
  waitForEditorReady,
} from '../support/editor.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'fresh-install-visual';

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
    panel: read('.onboarding-setup-panel'),
    controls: read('.onboarding-controls-row'),
    continueButton: read('.lets-go-btn'),
    continueLabel: read('.lets-go-text'),
    title: document.querySelector('#onboarding-setup-title')?.textContent?.trim() ?? null,
  };
});

const assertCoversViewport = (rect, viewport, label) => {
  assert.ok(rect, `${label} is absent`);
  assert.equal(rect.left, 0, `${label} does not begin at the viewport left edge`);
  assert.equal(rect.top, 0, `${label} does not begin at the viewport top edge`);
  assert.equal(rect.width, viewport.width, `${label} does not span the viewport width`);
  assert.equal(rect.height, viewport.height, `${label} does not span the viewport height`);
};

describe('a first-time customer sees intentional full-window onboarding', () => {
  it('keeps both onboarding stages centred and complete', async () => {
    await waitForEditorReady();

    const first = await geometry();
    assertCoversViewport(first.banner, first.viewport, 'the first onboarding overlay');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-welcome',
      description: 'The first welcome screen fills the fresh application window.',
      details: first,
    });

    assert.equal(await dismissOnboarding(), true, 'the first onboarding stage was not shown');
    const second = await geometry();
    assertCoversViewport(second.reveal, second.viewport, 'the onboarding controls overlay');
    assertCoversViewport(second.card, second.viewport, 'the onboarding controls card');
    assert.ok(second.panel, 'the onboarding setup panel is absent');
    assert.ok(second.controls, 'the onboarding controls are absent');
    assert.ok(second.title?.length > 0, 'the onboarding setup panel has no title');
    assert.ok(second.panel.width <= 600, `the setup panel is implausibly wide: ${JSON.stringify(second)}`);
    assert.ok(second.controls.height <= 70, `the setup controls wrapped onto multiple rows: ${JSON.stringify(second)}`);
    assert.ok(second.continueLabel?.width >= 40, `the continue label has no painted width: ${JSON.stringify(second)}`);
    assert.equal(second.continueLabel.visibility, 'visible', 'the continue label is hidden');
    assert.equal(second.continueLabel.opacity, '1', 'the continue label is transparent');
    const controlsCentreX = second.panel.left + second.panel.width / 2;
    const controlsCentreY = second.panel.top + second.panel.height / 2;
    assert.ok(
      Math.abs(controlsCentreX - second.viewport.width / 2) <= 2,
      `the onboarding setup panel is not horizontally centred: ${JSON.stringify(second)}`,
    );
    assert.ok(
      Math.abs(controlsCentreY - second.viewport.height / 2) <= 2,
      `the onboarding setup panel is not vertically centred: ${JSON.stringify(second)}`,
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-preferences',
      description: 'A titled setup slate groups theme, language, and the continue action.',
      details: second,
    });

    assert.equal(await dismissOnboardingControls(), true, 'the second onboarding stage was not shown');
  });
});
