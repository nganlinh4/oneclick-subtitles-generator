/** Persisted `#rgb[a]`/`#rrggbb[aa]` colours resolved to canvas `rgba()` strings. */

const colorChannels = (value) => {
  if (typeof value !== 'string') return {
    red: 0, green: 0, blue: 0, alpha: 255,
  };
  const hex = value.slice(1);
  const expanded = hex.length <= 4 ? [...hex].map((part) => `${part}${part}`).join('') : hex;
  const red = Number.parseInt(expanded.slice(0, 2), 16);
  const green = Number.parseInt(expanded.slice(2, 4), 16);
  const blue = Number.parseInt(expanded.slice(4, 6), 16);
  const alpha = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) : 255;
  return { red, green, blue, alpha };
};

export const rgba = (value, alphaMultiplier = 1) => {
  const color = colorChannels(value);
  return `rgba(${color.red},${color.green},${color.blue},${color.alpha / 255 * alphaMultiplier})`;
};

/**
 * Resolve the independently persisted background colour and opacity to the same quantized alpha
 * byte as `osg-scene`, then apply the cue's animation alpha. Keeping this conversion explicit is
 * what makes alpha-bearing colours WYSIWYG instead of valid in preview but refused by export.
 */
export const subtitleBackgroundRgba = (value, opacityPercentage, cueAlpha = 1) => {
  const color = colorChannels(value);
  const opacityAlpha = Number.isFinite(opacityPercentage) && opacityPercentage > 0
    ? Math.min(255, Math.round(opacityPercentage * 2.55))
    : 0;
  const combinedAlpha = Math.round(color.alpha * opacityAlpha / 255);
  return `rgba(${color.red},${color.green},${color.blue},${combinedAlpha / 255 * cueAlpha})`;
};
