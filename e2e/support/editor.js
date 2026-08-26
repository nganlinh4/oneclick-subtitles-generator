/**
 * Shared steps every customer journey performs before it can do anything else.
 *
 * These drive the real interface exactly as a person does. Nothing here writes application state,
 * sets a storage key to skip a screen, or reaches past the UI: a journey that skipped first-run
 * onboarding by writing `has_visited_site` would also skip whatever onboarding breaks.
 */

/* global $, browser, document, process, window */

const READY_TIMEOUT_MS = 90_000;
const OFFSCREEN_X_LIMIT = -9_000;

/**
 * Prove that the real automation window cannot touch the interactive desktop.
 *
 * This belongs in the journey call path, not only in a WebdriverIO lifecycle hook: WebdriverIO was
 * observed logging a rejected `before` hook and then running the spec to a successful exit code.
 * Every journey calls `waitForEditorReady`, so an unsafe placement is now a test failure even when
 * the runner mishandles its own hook.
 */
export const waitForAutomationWindowIsolation = async () => {
  if (process.env.OSG_E2E_OFFSCREEN_WINDOW !== '1') return null;

  let lastRect = null;
  await browser.waitUntil(
    async () => {
      lastRect = await browser.getWindowRect();
      return lastRect.x <= OFFSCREEN_X_LIMIT;
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: 'the automation window never reached its off-screen position',
    },
  );
  if (lastRect === null || lastRect.x > OFFSCREEN_X_LIMIT) {
    throw new Error(`the automation window entered the interactive desktop: ${JSON.stringify(lastRect)}`);
  }
  return lastRect;
};

/** Wait until React has committed the application shell. */
export const waitForEditorReady = async () => {
  await waitForAutomationWindowIsolation();
  await browser.waitUntil(
    async () => (await browser.execute(
      () => document.querySelector('#root')?.childElementCount ?? 0,
    )) > 0,
    { timeout: READY_TIMEOUT_MS, interval: 500, timeoutMsg: 'the editor never rendered' },
  );
};

/**
 * Dismiss the first-run onboarding overlay the way a customer does.
 *
 * It covers the whole window at `z-index: 100000` and refuses dismissal for the first four seconds,
 * so every control beneath it is genuinely unreachable until then — the first customer journey
 * written without this step failed with "Let's go is not clickable", which was the product behaving
 * exactly as designed.
 *
 * A no-op when the overlay is absent, so a journey on a profile that has already seen it works too.
 */
export const dismissOnboarding = async () => {
  const overlay = await $('.onboarding-overlay');
  if (!(await overlay.isExisting())) return false;

  // The wait is deliberate product behaviour, not a race: the overlay only becomes dismissable once
  // its countdown elapses, and clicking before then does nothing.
  const dismissable = await $('.onboarding-overlay.can-dismiss');
  await dismissable.waitForExist({
    timeout: 30_000,
    timeoutMsg: 'the onboarding overlay never became dismissable',
  });
  await dismissable.click();

  await browser.waitUntil(
    async () => !(await (await $('.onboarding-overlay')).isExisting()),
    { timeout: 30_000, interval: 250, timeoutMsg: 'the onboarding overlay never went away' },
  );
  return true;
};

/**
 * Clear the onboarding footer card by pressing the control it offers.
 *
 * First-run onboarding has two stages, and this is the second: after the full-screen overlay goes,
 * a reveal card still sits over the working controls until "Let's go" is pressed. Missing it looks
 * exactly like the first stage -- a primary button that reports as visible and enabled while
 * something else receives the click.
 */
export const dismissOnboardingControls = async () => {
  const card = await $('.onboarding-reveal-card');
  if (!(await card.isExisting())) return false;

  const proceed = await $('.lets-go-btn');
  await proceed.waitForClickable({
    timeout: 30_000,
    timeoutMsg: 'the onboarding footer card never offered a usable control',
  });
  await proceed.click();

  await browser.waitUntil(
    async () => !(await (await $('.onboarding-reveal-card')).isExisting()),
    { timeout: 30_000, interval: 250, timeoutMsg: 'the onboarding footer card never went away' },
  );
  return true;
};

/** Reach the editor as a first-time customer does: launch, wait, clear both onboarding stages. */
export const openEditor = async () => {
  await waitForEditorReady();
  const dismissedOverlay = await dismissOnboarding();
  const dismissedControls = await dismissOnboardingControls();
  return { dismissedOverlay, dismissedControls };
};

/**
 * What actually receives a click at a control's centre.
 *
 * A failure to click is almost never "the button is missing": it is off-screen, or something is
 * sitting on top of it. Reporting the intercepting element turns a generic "not clickable" into a
 * finding — that is how the first-run onboarding overlay was identified as the reason the primary
 * control could not be pressed.
 */
export const whatIsAt = async (selector) => browser.execute((target) => {
  const node = document.querySelector(target);
  if (node === null) return { present: false };
  const rect = node.getBoundingClientRect();
  const centreX = rect.left + rect.width / 2;
  const centreY = rect.top + rect.height / 2;
  const centre = document.elementFromPoint(centreX, centreY);
  return {
    present: true,
    rect: {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    },
    // Actionability is about the point WebDriver presses, not full-rectangle containment. A user
    // can press a tab whose outer padding is clipped by a scroll container while its centre remains
    // visible; requiring every edge caused `scrollIntoView(nearest)` to make no movement and then
    // wait forever on a perfectly usable control.
    inViewport: centreX >= 0 && centreY >= 0
      && centreX < window.innerWidth && centreY < window.innerHeight,
    fullyInViewport: rect.top >= 0 && rect.left >= 0
      && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
    disabled: node.disabled === true,
    intercepting: centre === null || centre === node || node.contains(centre)
      ? null
      : { tag: centre.tagName.toLowerCase(), className: (centre.getAttribute('class') || '').slice(0, 80) },
  };
}, selector);

/**
 * Press a control the way a person does: bring it into view only when needed, then click it.
 *
 * Scrolling is part of using below-the-fold controls, but scrolling a fixed/modal control that is
 * already visible can move a transformed application shell and corrupt screenshot evidence. If the
 * click still cannot happen, the failure names what intercepted it instead of only saying it was
 * not clickable.
 */
export const clickControl = async (selector, { timeout = 30_000 } = {}) => {
  if (typeof selector !== 'string' || selector.trim() === '' || selector.trimStart().startsWith('/')) {
    throw new TypeError('clickControl requires one non-empty CSS selector; XPath is not supported');
  }
  const control = await $(selector);
  await control.waitForExist({ timeout, timeoutMsg: `${selector} never appeared` });
  const initialState = await whatIsAt(selector);
  if (!initialState.inViewport) {
    const scrolled = await browser.execute((target) => {
      const node = document.querySelector(target);
      if (node === null) return false;
      node.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
      return true;
    }, selector);
    if (!scrolled) throw new Error(`${selector} disappeared before it could be scrolled into view`);
    let scrolledState = null;
    try {
      await browser.waitUntil(async () => {
        scrolledState = await whatIsAt(selector);
        return scrolledState.inViewport;
      }, {
        timeout,
        interval: 50,
        timeoutMsg: `${selector} remained outside the viewport after in-document scrolling`,
      });
    } catch (error) {
      scrolledState = await whatIsAt(selector);
      throw new Error(
        `${selector} remained outside the viewport after in-document scrolling: ${JSON.stringify(scrolledState)}`,
        { cause: error },
      );
    }
  }
  let actionableState = null;
  try {
    await browser.waitUntil(async () => {
      actionableState = await whatIsAt(selector);
      return actionableState.present
        && actionableState.inViewport
        && !actionableState.disabled
        && actionableState.intercepting === null;
    }, {
      timeout,
      interval: 50,
      timeoutMsg: `${selector} never owned an enabled hit target inside the viewport`,
    });
  } catch (error) {
    actionableState = await whatIsAt(selector);
    throw new Error(
      `${selector} never owned an enabled hit target inside the viewport: ${JSON.stringify(actionableState)}`,
      { cause: error },
    );
  }
  try {
    await control.click();
  } catch (error) {
    const state = await whatIsAt(selector);
    throw new Error(`${selector} could not be clicked: ${JSON.stringify(state)}`, { cause: error });
  }
};
