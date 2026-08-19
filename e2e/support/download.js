/**
 * Driving the "Download Only" modal the way a customer does.
 *
 * The modal is not a confirmation box. Its confirm button stays disabled until a media TYPE is
 * chosen and, for video, until a QUALITY is chosen from a list the application scans out of the real
 * URL with yt-dlp. A journey that presses only the first button waits for a download nobody asked
 * for; one that presses confirm immediately meets a disabled control. Both happened before this
 * module existed, and both looked like product failures.
 */

import { clickControl } from './editor.js';

/** How long the real format scan may take: it is a network round trip through yt-dlp. */
const SCAN_TIMEOUT_MS = 300_000;

/** What the modal is showing right now, in the terms the component thinks in. */
export const modalState = () => browser.execute(() => {
  const modal = document.querySelector('.download-only-modal');
  if (modal === null) return { open: false };
  const text = (selector) => [...modal.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean);
  return {
    open: true,
    scanning: modal.querySelector('.scanning-indicator') !== null,
    noQualities: modal.querySelector('.no-qualities') !== null,
    qualities: text('.quality-pill-label'),
    typeChosen: [...modal.querySelectorAll('input[name="download-type"]')]
      .filter((input) => input.checked).length > 0,
    confirmDisabled: modal.querySelector('.confirm-button')?.disabled ?? null,
  };
});

/**
 * Choose video, wait for the real quality scan, take the lowest quality offered, and confirm.
 *
 * The LOWEST quality on purpose: every journey that needs media needs it quickly, and which rung of
 * the ladder is fetched is the downloader's business rather than the subject of any journey here.
 * A journey about quality selection would choose a specific one and say so.
 */
export const confirmDownloadOnly = async () => {
  await clickControl('.download-only-modal input[name="download-type"][value="video"]');

  let state = await modalState();
  await browser.waitUntil(async () => {
    state = await modalState();
    return state.open && !state.scanning && (state.qualities.length > 0 || state.noQualities);
  }, {
    timeout: SCAN_TIMEOUT_MS,
    interval: 2_000,
    timeoutMsg: () => `the quality scan never finished. last: ${JSON.stringify(state)}`,
  });

  if (state.noQualities) {
    throw new Error('the application found no downloadable quality for the URL');
  }
  console.log(`qualities offered: ${JSON.stringify(state.qualities)}`);

  // The last pill is the lowest rung: the list arrives in descending order of height.
  //
  // The LABEL is the click target, not the radio. The input is laid out at zero size and styled
  // through its label, so clicking it reports "not clickable, intercepted by .radio-pill" — which
  // is the control working as designed, and is what a customer's pointer lands on anyway.
  const lowest = state.qualities.length - 1;
  await clickControl(`.download-only-modal label[for="quality-${lowest}"]`);

  await browser.waitUntil(async () => !(await modalState()).confirmDisabled, {
    timeout: 30_000,
    interval: 500,
    timeoutMsg: async () => `confirm stayed disabled: ${JSON.stringify(await modalState())}`,
  });
  await clickControl('.download-only-modal .confirm-button');
};
