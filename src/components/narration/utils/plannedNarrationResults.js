import { deriveSubtitleId } from '../../../utils/subtitle/idUtils';

/** Match streamed results to plan order with one lookup per subtitle. */
export const plannedNarrationResults = (plan, generationResults = []) => {
  const firstResultById = new Map();
  for (const result of generationResults || []) {
    // IDs historically compare as strings. Keep the first match when a stream
    // contains duplicate IDs, just as the previous per-subtitle find did.
    const id = String(result.subtitle_id);
    if (!firstResultById.has(id)) firstResultById.set(id, result);
  }

  return plan.map((subtitle, index) => {
    const subtitleId = deriveSubtitleId(subtitle, index);
    const existingResult = firstResultById.get(String(subtitleId));
    if (existingResult) return existingResult;

    return {
      subtitle_id: subtitleId,
      text: subtitle.text || '',
      success: false,
      pending: true,
      start: subtitle.start,
      end: subtitle.end,
      original_ids: subtitle.original_ids || (subtitle.id ? [subtitle.id] : []),
    };
  });
};
