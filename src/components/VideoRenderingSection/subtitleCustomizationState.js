/**
 * The render tab's subtitle style, and the one place it is completed against the defaults.
 *
 * THE MERGE USED TO HAPPEN ON ONE SIDE ONLY. `VideoRenderingSection` built its export request as
 * `{ ...defaultCustomization, ...subtitleCustomization }` at each of the three places a render
 * request was constructed, and handed the preview the state object raw. `normalizeCustomization` in
 * `src/platform/renderService.js` takes an EXACT key set, so a style missing one key — a custom
 * preset saved by an older build, a hand-edited `localStorage` entry, `CustomPresetButtons`
 * spreading a stored preset straight into `onChange` — built an export request and refused a
 * preview request. The file rendered and the panel went silently dormant, the two disagreeing about
 * a style neither of them reported.
 *
 * They agreed in practice only because `parseStoredSubtitleCustomization` had already merged before
 * the state was first set, which is one decision made in two places and waiting to come apart.
 *
 * The state authority has since moved to the native project render scene. This leaf remains only
 * for preset compatibility: a preset may omit a field, but it must be completed before being handed
 * to that strict project scene. It owns no React state and reads no browser storage.
 *
 * Determinism and scope: no clocks, no RNG, and nothing here validates. A bad VALUE is deliberately
 * left alone so it still reaches `normalizeCustomization` and is refused identically on both sides.
 */

import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';

/**
 * The style with every key the render contract names, and the caller's value wherever it has one.
 *
 * A shallow spread rather than `mergeSubtitleCustomizationDefaults`, and that is the whole point of
 * the distinction: a MISSING key is a shape the contract cannot read and is filled in, while an
 * out-of-bounds VALUE is a style the user cannot actually get and must still be refused — by the
 * export as well as by the preview. Repairing it here would show a preview of something that will
 * not render.
 */
export const completeSubtitleCustomization = (candidate) => Object.freeze({
  ...defaultCustomization,
  ...(candidate === null || typeof candidate !== 'object' ? null : candidate),
});
