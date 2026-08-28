import { clickControl, whatIsAt } from './editor.js';

/* global browser, document */

/**
 * Click a control that lives inside the Settings modal's scrollable content, tolerating the sticky
 * settings footer.
 *
 * `.settings-footer` is genuinely `position: sticky; bottom: 0` (src/styles/settings/header-footer.css)
 * at the bottom of `.settings-content`. clickControl's own `scrollIntoView({block: 'nearest'})` is
 * satisfied the moment a control's centre point is inside the window, which can still land that centre
 * directly under the footer for a control near the bottom of a tall tab (observed for
 * `#enable-youtube-search`: `inViewport: true` yet intercepted by `div.settings-footer`). Retry once,
 * scrolling `.settings-content` far enough that the control clears the footer, then perform the exact
 * same real click clickControl performs everywhere else. Any other failure is rethrown untouched.
 */
export const clickSettingsControl = async (selector, options = {}) => {
  try {
    await clickControl(selector, options);
    return;
  } catch (error) {
    const state = await whatIsAt(selector);
    const blockedByFooter = state.intercepting?.className?.includes('settings-footer') ?? false;
    if (!blockedByFooter) throw error;
  }
  const cleared = await browser.execute((target) => {
    const node = document.querySelector(target);
    const footer = document.querySelector('.settings-footer');
    const scroller = node?.closest('.settings-content');
    if (node === null || footer === null || scroller === null) return false;
    const overlap = node.getBoundingClientRect().bottom - footer.getBoundingClientRect().top;
    if (overlap <= 0) return true;
    scroller.scrollTop += overlap + 16;
    return true;
  }, selector);
  if (!cleared) throw new Error(`${selector}: could not clear the sticky settings footer`);
  await clickControl(selector, options);
};
