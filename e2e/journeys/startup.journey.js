// The first journey: does the real application reach a usable UI?
//
// Deliberately the smallest possible real-binary assertion. Everything above it in the pyramid
// already passes — 1428 Rust tests, 2147 frontend tests, a green installed lifecycle smoke — while
// the product fails in use. So the first thing to establish is not a feature but a fact: that a
// WebDriver session can attach to the shipped binary and see the editor.
//
// The wait is on the editor actually rendering, not on `document.readyState`. A blank document
// reports `complete` too, and the first version of this test asserted at 164ms against exactly that
// — the application needs several seconds to reach `app.ready`.

import { strict as assert } from 'node:assert';

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

describe('the application starts', () => {
  it('reaches a rendered editor', async () => {
    let last = await inspect();
    console.log('first observation:\n' + JSON.stringify(last, null, 2));

    await browser.waitUntil(async () => {
      last = await inspect();
      return last.rootChildren > 0;
    }, {
      timeout: RENDER_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: `the editor never rendered. last observation: ${JSON.stringify(last)}`,
    });

    console.log('rendered observation:\n' + JSON.stringify(last, null, 2));
    assert.ok(last.rootChildren > 0, 'the React root must have rendered');
    assert.deepEqual(last.errorText, [], 'no error surface may be visible at startup');
  });
});
