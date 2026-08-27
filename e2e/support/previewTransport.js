import { strict as assert } from 'node:assert';

/* global $, browser, document, getComputedStyle, window */

/**
 * Reveal the Main preview's hover-gated transport controls through their real boundary.
 *
 * The controls live behind a hover reveal, and in the hidden non-focusable window a WebDriver
 * pointer move does not reliably produce the CSS hover state. The product's own reveal is its
 * React mouseover handler, so the journey dispatches exactly that event on the real container and
 * then waits for the transport to accept pointer input — the same observable boundary a customer's
 * cursor crosses. Nothing is forced visible: if the product stopped revealing controls on hover,
 * this fails.
 */
export const revealMainTransportControls = async ({
  previewSelector = '.video-preview',
  controlsSelector = '.video-preview .custom-video-controls',
} = {}) => {
  const containerSelector = `${previewSelector} .native-video-container`;
  const container = await $(containerSelector);
  await container.waitForDisplayed({ timeout: 30_000 });
  const hovered = await browser.execute((target) => {
    const node = document.querySelector(target);
    if (node === null) return false;
    node.dispatchEvent(new window.MouseEvent('mouseover', {
      bubbles: true, cancelable: true, composed: true, view: window,
    }));
    return true;
  }, containerSelector);
  assert.equal(hovered, true, 'the native preview disappeared before its hover boundary');
  await browser.waitUntil(async () => browser.execute((target) => {
    const control = document.querySelector(target);
    return control !== null && getComputedStyle(control).pointerEvents !== 'none';
  }, `${controlsSelector} [aria-label="Play"], ${controlsSelector} [aria-label="Pause"]`), {
    timeout: 10_000,
    interval: 50,
    timeoutMsg: 'the public preview hover did not reveal its transport controls',
  });
};
