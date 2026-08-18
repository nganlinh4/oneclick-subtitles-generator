// Does the default subtitle font actually exist in the shipped application?
//
// The editor's default font was the managed Google Sans family, and the resolver refused that family
// unless told the package was installed. No production caller ever told it, so the default resolved
// to nothing and the preview stayed dormant on every real installation. The frontend fix reads the
// value native code injects — which makes this journey's question the one that matters: in the real
// binary, on a real profile, is that value true AND is the face genuinely there with its own bytes?
//
// A jsdom test cannot answer either half. `document.fonts` is not implemented there, the injected
// bootstrap does not exist, and no font file is ever read. This is exactly the class of thing that
// has to be measured in the application or not claimed at all.

import { strict as assert } from 'node:assert';

const READY_TIMEOUT_MS = 90_000;

/** The family the managed package declares. Stated here so the journey is readable standalone. */
const MANAGED_FAMILY = 'Google Sans';

const observe = () => browser.execute((family) => {
  const measure = (font) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = font;
    // Digits and Latin letters differ between almost any two real faces; a string of them is a
    // sensitive width probe without needing a glyph the fallback lacks.
    return context.measureText('0123456789 Handgloves ABCwxyz').width;
  };

  return {
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    // The typed record native publishes. Reported verbatim: "the bootstrap never ran" and "the
    // package is absent" are different failures and must not collapse into one boolean.
    readiness: window.__OSG_FONT_READINESS__ ?? null,
    fontsStatus: document.fonts?.status ?? 'no-font-face-set',
    faceCheck: document.fonts?.check(`400 16px '${family}'`) ?? null,
    loadedFamilies: [...(document.fonts ?? [])]
      .map((face) => `${face.family}/${face.weight}/${face.status}`).slice(0, 12),
    managedWidth: measure(`400 64px '${family}'`),
    // `sans-serif` alone is whatever the system resolves. If the managed family were missing, the
    // measurement above would fall back to exactly this and the two would be identical.
    fallbackWidth: measure('400 64px sans-serif'),
    documentFont: getComputedStyle(document.body).fontFamily,
  };
}, MANAGED_FAMILY);

describe('the default subtitle font in the real application', () => {
  it('is present, verified and drawn from its own bytes', async () => {
    let seen = await observe();

    await browser.waitUntil(async () => {
      seen = await observe();
      // Fonts load asynchronously; waiting on the face rather than on a timer.
      return seen.rootChildren > 0 && seen.faceCheck === true
        && seen.readiness?.state === 'ready';
    }, {
      timeout: READY_TIMEOUT_MS,
      interval: 500,
      timeoutMsg: () => 'the managed font never became usable. last observation: '
        + JSON.stringify(seen, null, 2),
    });

    console.log('font observation:\n' + JSON.stringify(seen, null, 2));

    assert.ok(seen.readiness, 'native must publish a readiness record into the WebView');
    assert.equal(seen.readiness.schema, 1, 'the frontend only understands schema 1');
    assert.equal(
      seen.readiness.state, 'ready',
      'native must report the managed package installed and verified; this is the record the '
        + 'frontend reads and whose absence made the default font unresolvable',
    );
    assert.ok(seen.readiness.version, 'a ready record names the version it verified');
    assert.equal(seen.readiness.reason, null, 'a ready record has nothing to refuse');
    assert.ok(seen.readiness.epoch > 0, 'the initial resolving record must have been superseded');
    assert.equal(seen.faceCheck, true, `'${MANAGED_FAMILY}' must be usable for drawing`);

    // The measurement is the part that cannot be faked by a lying flag: if the family were absent,
    // the canvas would silently fall back and both numbers would agree to the pixel.
    assert.notEqual(
      seen.managedWidth, seen.fallbackWidth,
      `'${MANAGED_FAMILY}' measured identically to the generic fallback, so the face is being `
        + 'substituted rather than loaded — a flag saying otherwise would be the exact failure this '
        + 'journey exists to catch',
    );
    assert.ok(seen.managedWidth > 0, 'the managed family must measure to something');
  });
});
