// Fixed inputs for the subtitle customization preview journey.

export const WORKFLOW = 'subtitle-customization-preview';
export const CANVAS = '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]';
export const COMPARE_AT_SECONDS = 1;
export const SYSTEM_FONT = 'Impact';
export const SYSTEM_FONT_CSS = "'Impact', sans-serif";
export const SYSTEM_FONT_WEIGHT = 400;
export const CUSTOMIZATION_CUE = 'Every subtitle appearance control must change this long native preview line independently';
export const CUSTOMIZATION_SRT = `1
00:00:00,250 --> 00:00:05,500
${CUSTOMIZATION_CUE}
`;
