// Why does a restored project refuse to lay out its subtitle atlas?
//
// A diagnostic, not an assertion of product behaviour, and deliberately outside the default glob.
// It reproduces the restore refusal and then reports the things that separate the live hypotheses:
// whether the managed font was ready when the atlas was baked, and whether the refusal survives a
// re-bake once everything has settled.

import { openEditor } from '../support/editor.js';
import {
  FIRST_CUE,
  editCueText,
  importSubtitles,
  openProjectWithMedia,
  waitForNativeFrame,
} from '../support/workflow.js';

const probe = () => browser.execute(() => {
  const managed = "400 16px 'Google Sans'";
  return {
    fontReadiness: window.__OSG_FONT_READINESS__?.state ?? null,
    fontsStatus: document.fonts?.status ?? null,
    managedUsable: document.fonts?.check(managed) ?? null,
    loadedFaces: [...(document.fonts ?? [])]
      .filter((face) => face.family.includes('Google Sans'))
      .map((face) => `${face.family}/${face.weight}/${face.status}`),
    hasNativeFrame: document.querySelector('.native-composited-frame') !== null,
    refusals: [...document.querySelectorAll('.error, .native-preview-unavailable')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 4),
  };
});

const show = (label, value) => console.log(`=== ${label} ===\n${JSON.stringify(value, null, 2)}`);

describe('a restored project', () => {
  it('reports what differs between the first run and the restore', async () => {
    await openProjectWithMedia();
    await importSubtitles();
    await waitForNativeFrame();
    show('first run, frame drawn', await probe());

    // The failing journeys all edited a cue before relaunching; this probe did not, and it did not
    // reproduce. So the edit is tested on its own, before any relaunch.
    await editCueText(FIRST_CUE, 'Edited first cue');
    await browser.pause(8_000);
    show('after editing a cue, still the same session', await probe());

    await browser.reloadSession();
    await openEditor();

    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector('video') !== null)),
      { timeout: 180_000, interval: 2_000, timeoutMsg: 'the project never restored' },
    );

    // Immediately after restore: was the font ready when the atlas was first baked?
    show('restored, immediately', await probe());

    // After everything has settled. If the refusal clears on its own, the bake raced the font; if it
    // persists, the atlas produced for the restored state is different from the one produced live.
    await browser.pause(20_000);
    show('restored, after settling', await probe());

    // A style change forces a fresh bake from the current state.
    const nudged = await browser.execute(() => {
      const toggle = document.querySelector('.subtitle-settings-toggle');
      if (toggle === null) return 'no settings toggle';
      toggle.click();
      return 'opened settings';
    });
    console.log(`nudge: ${nudged}`);
    await browser.pause(10_000);
    show('restored, after opening subtitle settings', await probe());
  });
});
