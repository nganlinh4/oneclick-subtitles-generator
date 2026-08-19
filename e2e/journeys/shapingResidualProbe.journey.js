// How big is the shaping residual, really?
//
// The atlas refuses a run when `runAdvanceWidthPx - sum of per-cluster advances` is exactly
// non-zero after rounding to four decimals. That decides whether a subtitle can be drawn at all, so
// the magnitude of that difference decides the repair: noise near 1e-4 means the comparison needs a
// sub-pixel tolerance, while a difference near a whole pixel is real inter-cluster kerning that
// per-cell layout genuinely cannot reproduce.
//
// A diagnostic, outside the default glob. It measures with the same Canvas API the bake uses, in the
// real application, with the real managed font loaded.

import { openEditor } from '../support/editor.js';

const SAMPLES = [
  'First cue for the preview',
  'Edited first cue',
  'Second cue, plain text only',
  'Last cue before the end',
  'Xin chào và 감사합니다 🎬',
  'AV Wa To ffi fl',
  'iiiiiiiiii',
];

describe('the shaping residual', () => {
  it('reports how far a run width differs from the sum of its clusters', async () => {
    await openEditor();

    const measured = await browser.execute((samples) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      const font = "400 24px 'Google Sans', sans-serif";
      context.font = font;

      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      const round4 = (value) => Math.round(value * 10_000) / 10_000;

      return {
        font: context.font,
        managedUsable: document.fonts.check(font),
        rows: samples.map((text) => {
          const run = context.measureText(text).width;
          const clusters = [...segmenter.segment(text)].map((entry) => entry.segment);
          const summed = clusters.reduce((total, cluster) => total + context.measureText(cluster).width, 0);
          return {
            text,
            clusters: clusters.length,
            runWidth: round4(run),
            summedWidth: round4(summed),
            residual: round4(run - summed),
            refusedByExactRule: round4(run - summed) !== 0,
          };
        }),
      };
    }, SAMPLES);

    console.log(`shaping residuals:\n${JSON.stringify(measured, null, 2)}`);
  });
});
