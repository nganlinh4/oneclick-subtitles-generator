// Enumerate what the real editor actually exposes, so journeys target ground truth.
//
// Not an assertion of product behaviour and deliberately not part of the default glob: it exists so
// a customer journey can be written against the controls the application really renders rather than
// against names guessed from source. Run it with
// `npx wdio run wdio.conf.js --spec ./journeys/reconnaissance.journey.js` when the UI moves.

import { clickControl, openEditor } from '../support/editor.js';
import { startMediaServer } from '../support/mediaServer.js';

const survey = () => browser.execute(() => {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const label = (node) => (
    node.getAttribute('aria-label')
    || node.getAttribute('title')
    || (node.innerText || '').trim().slice(0, 60)
    || node.getAttribute('placeholder')
    || ''
  );
  const describe = (node) => ({
    label: label(node),
    className: (node.getAttribute('class') || '').slice(0, 60),
    disabled: node.disabled === true,
  });

  return {
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    buttons: [...document.querySelectorAll('button')].filter(visible).map(describe),
    inputs: [...document.querySelectorAll('input, textarea, select')].filter(visible).map(describe),
    dialogs: [...document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="overlay" i]')]
      .filter(visible).map((node) => (node.getAttribute('class') || '').slice(0, 60)),
    headings: [...document.querySelectorAll('h1, h2, h3, h4')]
      .filter(visible).map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 20),
    status: [...document.querySelectorAll('[role="status"], .error, [role="alert"]')]
      .filter(visible).map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 8),
  };
});

const show = (label, value) => console.log(`=== ${label} ===\n${JSON.stringify(value, null, 2)}`);

describe('the editor surface', () => {
  it('reports the controls reachable at each step of starting a download', async () => {
    show('onboarding', await openEditor());
    show('at rest', await survey());

    const origin = await startMediaServer();
    try {
      const field = await $('.url-field');
      await field.waitForDisplayed({ timeout: 30_000 });
      await field.setValue(origin.urlFor('bars-6s-640x360.mp4'));
      await browser.pause(1_500);
      show('after entering a URL', await survey());

      await clickControl('.download-only-btn');
      await browser.pause(2_000);
      show('modal opened', await survey());

      // Choose "video", which is what a customer wants when they came for a subtitle preview.
      const videoOption = await $('input[name="download-type"][value="video"]');
      if (await videoOption.isExisting()) {
        await videoOption.click();
      } else {
        const first = await $$('input[name="download-type"]');
        if (first.length > 0) await first[0].click();
      }
      await browser.pause(15_000);
      show('after choosing a type', await survey());
      console.log(`origin requests after type choice: ${origin.requests.length}`);
      console.log(JSON.stringify(origin.requests.slice(0, 5), null, 2));
    } finally {
      await origin.stop();
    }
  });
});
