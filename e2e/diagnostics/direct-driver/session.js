// Attach the session to the editor, retrying session creation when it binds elsewhere.
//
// A Tauri application on Windows hosts more than one WebView2 target and a new WebDriver session
// binds to one of them non-deterministically. Measured over five runs of the same binary with
// identical native startup logs: some sessions land on `https://tauri.localhost/` and render, and
// some land on `about:blank` and report an empty `#root` forever. That reads exactly like an
// intermittent product failure and is not one.
//
// Switching windows does not fix it, which was the first thing tried: `getWindowHandles()` returns
// only the blank target, so the editor is not reachable from a session bound to it. The binding is
// decided when the session is created, so the repair is to create another one.
//
// The `about:blank` target also throws `Access is denied` reading `localStorage`. That is a
// property of that document rather than of the editor, and it is recorded here because it is a
// convincing false lead for anyone debugging this the second time.

const EDITOR_ORIGIN = 'tauri.localhost';
const MAX_SESSION_ATTEMPTS = 6;

const currentHref = () => browser.execute(() => document.location.href);

const waitForRender = (timeout) => browser.waitUntil(
  async () => (await browser.execute(
    () => document.querySelector('#root')?.childElementCount ?? 0,
  )) > 0,
  { timeout, interval: 500, timeoutMsg: 'the editor window never rendered' },
);

/** Returns the editor's URL once the session is bound to it and React has rendered. */
export const attachToEditor = async ({ timeout = 60_000 } = {}) => {
  for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt += 1) {
    const href = await currentHref();
    if (href.includes(EDITOR_ORIGIN)) {
      await waitForRender(timeout);
      return { href, attempts: attempt };
    }
    console.log(`session bound to ${href}; reloading (attempt ${attempt}/${MAX_SESSION_ATTEMPTS})`);
    await browser.reloadSession();
  }
  throw new Error(
    `no session bound to the editor origin after ${MAX_SESSION_ATTEMPTS} attempts. `
    + 'The application may be failing to create its main WebView.',
  );
};
