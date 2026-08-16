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
 * Completing at the STATE boundary is what makes one side authoritative. Everything downstream — the
 * preview, every render request, the queue item, the persisted entry — reads one complete object,
 * and there is no second place for the two to drift apart.
 *
 * Determinism and scope: no clocks, no RNG, and nothing here validates. A bad VALUE is deliberately
 * left alone so it still reaches `normalizeCustomization` and is refused identically on both sides.
 */

import { useCallback, useState } from 'react';

import {
  defaultCustomization,
  parseStoredSubtitleCustomization,
} from '../subtitleCustomization/defaultCustomization';

/** Where the render tab's style is persisted between sessions. */
export const SUBTITLE_CUSTOMIZATION_STORAGE_KEY = 'videoRender_subtitleCustomization';

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

/**
 * The render tab's style state, complete by construction.
 *
 * The setter takes what the customization panel hands over — `{ ...customization, ...updates }`, or
 * `{ ...preset.customization }` for a stored custom preset, which is where a key goes missing in the
 * first place — and completes it before it becomes state, so no reader has to remember to merge.
 */
export const useSubtitleCustomization = () => {
  const [subtitleCustomization, setStored] = useState(() => {
    try {
      return completeSubtitleCustomization(
        parseStoredSubtitleCustomization(localStorage.getItem(SUBTITLE_CUSTOMIZATION_STORAGE_KEY)),
      );
    } catch {
      return completeSubtitleCustomization(parseStoredSubtitleCustomization(null));
    }
  });

  const setSubtitleCustomization = useCallback((update) => {
    setStored((previous) => completeSubtitleCustomization(
      typeof update === 'function' ? update(previous) : update,
    ));
  }, []);

  return [subtitleCustomization, setSubtitleCustomization];
};
