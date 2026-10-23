// Vertical layout of the timeline canvas, shared by the drawing code and the narration-lane
// hit-testing so they can never disagree about where a band is.
//
//   ┌─ 25px time ruler ────────────────────────┐
//   │ subtitle band (top of the content area)   │
//   │ narration band (lower, above the waveform) │
//   └─ reserveBottom (waveform overlay) ─────────┘
//
// When there is no narration lane, the subtitle band fills the whole area below the ruler
// (the original, unchanged look).

const TIME_MARKER_SPACE = 25;

/**
 * @param {number} displayHeight - canvas CSS height in px
 * @param {number} [reserveBottom=0] - px reserved at the bottom (waveform overlay)
 * @param {boolean} [hasNarration=false] - whether a narration lane is present
 * @returns {{subtitleBand:{top:number,height:number}, narrationBand:({top:number,height:number}|null)}}
 */
export const computeTimelineBands = (displayHeight, reserveBottom = 0, hasNarration = false) => {
  if (!hasNarration) {
    return {
      subtitleBand: { top: TIME_MARKER_SPACE, height: Math.max(0, displayHeight - TIME_MARKER_SPACE) },
      narrationBand: null,
    };
  }
  const contentTop = TIME_MARKER_SPACE;
  const contentBottom = displayHeight - (reserveBottom || 0);
  const contentHeight = Math.max(20, contentBottom - contentTop);
  return {
    subtitleBand: { top: contentTop, height: contentHeight * 0.58 },
    narrationBand: { top: contentTop + contentHeight * 0.64, height: contentHeight * 0.34 },
  };
};
