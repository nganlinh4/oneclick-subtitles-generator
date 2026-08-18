// Diagnostic: why does the editor sometimes not render?
//
// Two runs of the same binary on fresh isolated roots produced identical native startup logs
// (app.ready, then two page_load_finished) but different outcomes: one rendered, one showed an
// empty #root for 90 seconds. The native side is not the variable, so this captures the WebView's.

const observe = () => browser.execute(() => {
  const root = document.querySelector('#root');
  const scripts = [...document.querySelectorAll('script')].map((s) => ({
    src: (s.src || '').split('/').pop() || '(inline)',
    type: s.type || undefined,
  }));
  const resources = (performance.getEntriesByType('resource') || [])
    .map((entry) => ({
      name: entry.name.split('/').pop(),
      status: entry.responseStatus,
      duration: Math.round(entry.duration),
      size: entry.transferSize,
    }))
    .slice(0, 25);
  return {
    href: document.location.href,
    readyState: document.readyState,
    rootChildren: root?.childElementCount ?? -1,
    rootHtml: (root?.innerHTML || '').slice(0, 300),
    bodyChildren: document.body?.childElementCount ?? -1,
    scripts,
    resources,
    globalError: window.__lastError ?? null,
    hasReact: Boolean(window.React || document.querySelector('[data-reactroot], #root > *')),
  };
});

describe('editor render', () => {
  it('observes what the WebView actually did', async () => {
    let state;
    let rendered = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      state = await observe();
      if (state.rootChildren > 0) { rendered = true; break; }
      await browser.pause(500);
    }
    console.log(`RENDERED: ${rendered}`);
    console.log('STATE:\n' + JSON.stringify(state, null, 2));
    try {
      const logs = await browser.getLogs('browser');
      console.log('BROWSER LOGS:\n' + JSON.stringify(logs, null, 2));
    } catch (error) {
      console.log(`browser logs unavailable: ${error.message}`);
    }
  });
});
