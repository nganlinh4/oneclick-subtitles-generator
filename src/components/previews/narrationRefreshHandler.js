import { hydrateNarrationResultsForAlignment } from "../../utils/narrationAlignmentUtils";

/**
 * Handles the "Refresh Narration" button click: gathers narration data from
 * window objects, prepares the aligned narration preview, and dispatches the
 * relevant ready/status events.
 *
 * All required values are passed in as params so this function has no
 * dependency on component-state closures.
 *
 * @param {Object} params
 * @param {React.RefObject} params.videoRef - Ref to the underlying video element.
 * @param {Function} params.setIsRefreshingNarration - State setter for the refreshing flag.
 * @param {Function} params.t - i18next translation function.
 */
export const narrationRefreshHandler = async ({
  videoRef,
  setIsRefreshingNarration,
  t,
}) => {
  try {
    // Pause the video if it's playing
    const wasPlaying = !!(videoRef.current && !videoRef.current.paused);
    if (wasPlaying) {
      videoRef.current.pause();
    }

    // Set refreshing state
    setIsRefreshingNarration(true);

    // Get narration data from window objects (same as VideoRenderingSection.js)
    const isUsingGroupedSubtitles = window.useGroupedSubtitles || false;
    const groupedNarrations = window.groupedNarrations || [];
    const originalNarrations = window.originalNarrations || [];
    const translatedNarrations = window.translatedNarrations || [];

    let generationResults = [];

    // Use grouped narrations if available and enabled, otherwise use original/translated narrations
    if (isUsingGroupedSubtitles && groupedNarrations.length > 0) {
      generationResults = groupedNarrations;
      console.log(
        `Using grouped narrations for refresh. Found ${generationResults.length} grouped narrations.`,
      );
    } else if (translatedNarrations.length > 0) {
      generationResults = translatedNarrations;
      console.log(
        `Using translated narrations for refresh. Found ${generationResults.length} narrations.`,
      );
    } else if (originalNarrations.length > 0) {
      generationResults = originalNarrations;
      console.log(
        `Using original narrations for refresh. Found ${generationResults.length} narrations.`,
      );
    }

    if (generationResults.length === 0) {
      throw new Error(
        t(
          "errors.noNarrationResults",
          "No narration results to generate aligned audio",
        ),
      );
    }

    // EXACT same subtitle timing lookup as VideoRenderingSection.js
    // Get all subtitles from the window object, prioritizing grouped subtitles if using them
    const allSubtitles =
      isUsingGroupedSubtitles && window.groupedSubtitles
        ? window.groupedSubtitles
        : window.subtitlesData ||
          window.originalSubtitles ||
          window.subtitles ||
          [];

    // Also try translated subtitles if no other subtitles found
    if (
      allSubtitles.length === 0 &&
      window.translatedSubtitles &&
      Array.isArray(window.translatedSubtitles)
    ) {
      allSubtitles.push(...window.translatedSubtitles);
    }

    // Create a map for faster lookup
    const subtitleMap = {};
    allSubtitles.forEach((sub) => {
      if (sub.id !== undefined) {
        subtitleMap[sub.id] = sub;
      }
    });

    // EXACT same data preparation as downloadAlignedAudio in useNarrationHandlers.js
    const narrationData = hydrateNarrationResultsForAlignment(generationResults)
      .filter(
        (result) =>
          result.success && (result.nativeArtifactId || result.filename),
      )
      .map((result) => {
        // Get the correct subtitle ID from the result
        const subtitleId = result.subtitle_id;
        const isGrouped =
          result.original_ids && result.original_ids.length > 1;

        // Find the corresponding subtitle for timing information
        let subtitle = subtitleMap[subtitleId];

        // If this is a grouped subtitle and we couldn't find it directly in the map,
        // we might need to calculate its timing from the original subtitles
        if (!subtitle && isGrouped && result.original_ids) {
          console.log(
            `Handling grouped subtitle ${subtitleId} with ${result.original_ids.length} original IDs`,
          );

          // Get all the original subtitles that are part of this group
          const originalSubtitles = result.original_ids
            .map((id) => subtitleMap[id])
            .filter(Boolean);

          if (originalSubtitles.length > 0) {
            // Calculate start and end times from the original subtitles
            const start = Math.min(
              ...originalSubtitles.map((sub) => sub.start),
            );
            const end = Math.max(
              ...originalSubtitles.map((sub) => sub.end),
            );

            // Create a synthetic subtitle with the calculated timing
            subtitle = {
              id: subtitleId,
              start,
              end,
              text: result.text,
            };

            console.log(
              `Created synthetic timing for grouped subtitle ${subtitleId}: start=${start}, end=${end}`,
            );
          }
        }

        // If we found a matching subtitle or created synthetic timing, use it
        if (
          subtitle &&
          typeof subtitle.start === "number" &&
          typeof subtitle.end === "number"
        ) {
          return {
            filename: result.filename,
            nativeArtifactId: result.nativeArtifactId,
            subtitle_id: result.subtitle_id,
            start: subtitle.start,
            end: subtitle.end,
            text: subtitle.text || result.text || "",
            // Preserve original_ids if they exist
            original_ids: result.original_ids || [subtitleId],
          };
        }

        // Otherwise, use existing timing or defaults
        return {
          filename: result.filename,
          nativeArtifactId: result.nativeArtifactId,
          subtitle_id: result.subtitle_id,
          start: result.start || 0,
          end: result.end || (result.start ? result.start + 5 : 5),
          text: result.text || "",
          // Preserve original_ids if they exist
          original_ids: result.original_ids || [subtitleId],
        };
      });

    // Sort by start time to ensure correct order
    narrationData.sort((a, b) => a.start - b.start);

    if (narrationData.length === 0) {
      throw new Error(
        t(
          "errors.noNarrationResults",
          "No narration results to generate aligned audio",
        ),
      );
    }

    const { prepareAlignedNarrationPreview } = await import(
      "../../services/alignedNarrationService.js"
    );

    await prepareAlignedNarrationPreview(narrationData);

    console.log("🎵 Aligned narration preview prepared");
    console.log(
      "💾 Updated alignedNarrationCache:",
      window.alignedNarrationCache,
    );

    window.isAlignedNarrationAvailable = true;
    console.log("✅ Set isAlignedNarrationAvailable to true");

    window.dispatchEvent(
      new CustomEvent("aligned-narration-ready", {
        detail: {
          mode: "timeline",
          timestamp: Date.now(),
        },
      }),
    );

    window.dispatchEvent(
      new CustomEvent("aligned-narration-status", {
        detail: {
          status: "complete",
          message: "Aligned narration generation complete",
          isStillGenerating: false,
          available: true,
          mode: "timeline",
          timestamp: Date.now(),
        },
      }),
    );

    if (wasPlaying && videoRef.current) {
      videoRef.current.play().catch((error) => {
        console.warn(
          "Unable to resume video playback after aligned narration refresh:",
          error,
        );
      });
    }

    console.log("✅ Aligned narration preview ready");
  } catch (error) {
    console.error("Error during aligned narration regeneration:", error);

    // Dispatch aligned-narration-status event for auto-dismissing toast
    window.dispatchEvent(
      new CustomEvent("aligned-narration-status", {
        detail: {
          status: "error",
          message: error.message || "Failed to refresh narration",
          isStillGenerating: false,
        },
      }),
    );
  } finally {
    // Clear refreshing state
    setIsRefreshingNarration(false);
  }
};
