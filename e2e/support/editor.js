/**
 * Shared steps every customer journey performs before it can do anything else.
 *
 * These drive the real interface exactly as a person does. Nothing here writes application state,
 * sets a storage key to skip a screen, or reaches past the UI: a journey that skipped first-run
 * onboarding by writing `has_visited_site` would also skip whatever onboarding breaks.
 */

const READY_TIMEOUT_MS = 90_000;

/** Wait until React has committed the application shell. */
export const waitForEditorReady = async () => {
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
 * Relaunch the real process against the same isolated profile and re-pin its sole WebView handle.
 * `reloadSession()` creates a new WebDriver session, so the explicit selection made by the config's
 * `before` hook belongs to the old session. Repeating that standard switch prevents tauri-service
 * from spending five seconds per element command on unavailable active-window discovery.
 */
export const reloadApplicationSession = async () => {
  await browser.reloadSession();
  const handle = await browser.getWindowHandle();
  await browser.switchToWindow(handle);
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
  const centre = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return {
    present: true,
    rect: {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    },
    inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
    disabled: node.disabled === true,
    intercepting: centre === null || centre === node || node.contains(centre)
      ? null
      : { tag: centre.tagName.toLowerCase(), className: (centre.getAttribute('class') || '').slice(0, 80) },
  };
}, selector);

/**
 * Press a control the way a person does: bring it into view, then click it.
 *
 * Scrolling is part of using the application, not a workaround -- these controls sit below the fold
 * on a default window, and a customer scrolls to them. If the click still cannot happen, the
 * failure names what intercepted it instead of only saying it was not clickable.
 */
export const clickControl = async (selector, { timeout = 30_000 } = {}) => {
  const control = await $(selector);
  await control.waitForExist({ timeout, timeoutMsg: `${selector} never appeared` });
  await control.scrollIntoView({ block: 'center' });
  try {
    await control.waitForClickable({ timeout });
  } catch (error) {
    const state = await whatIsAt(selector);
    throw new Error(`${selector} could not be clicked: ${JSON.stringify(state)}`, { cause: error });
  }
  await control.click();
};
