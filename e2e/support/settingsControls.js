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

/**
 * Brings a Settings section into the scrolled viewport before it is used as an evidence focus
 * target. Interacting with controls scrolls `.settings-content` wherever those controls happen to
 * be, so by capture time the section a step is about can sit entirely outside the visible modal
 * even though every interaction succeeded. The evidence publisher rightly refuses a focus target
 * it cannot see; this scrolls the section to the top of its own scroller first.
 */
export const revealSettingsSection = async (selector) => {
  const revealed = await browser.execute((target) => {
    const node = document.querySelector(target);
    if (node === null) return false;
    // Settings tabs do not share one scroll container: some content sits inside
    // `.settings-content`, some inside a panel's own scroller. Walk to whichever ancestor actually
    // scrolls rather than naming a class, and fall back to the element's own scrollIntoView when
    // nothing in the chain scrolls at all - a section that is already fully visible needs no work,
    // and refusing there would fail a capture that would have succeeded.
    let scroller = node.parentElement;
    while (scroller !== null && scroller !== document.body) {
      const style = getComputedStyle(scroller);
      const scrolls = /(auto|scroll|overlay)/u.test(`${style.overflowY} ${style.overflow}`)
        && scroller.scrollHeight > scroller.clientHeight + 1;
      if (scrolls) break;
      scroller = scroller.parentElement;
    }
    if (scroller === null || scroller === document.body) {
      node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      return true;
    }
    scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    return true;
  }, selector);
  if (!revealed) throw new Error(`${selector}: is not present, so it cannot be revealed`);
};
