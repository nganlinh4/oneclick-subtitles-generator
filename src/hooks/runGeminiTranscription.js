// Gemini transcription for one prepared generation run: a selected segment merged into the saved
// project track, full local media, or a site URL. Returns the uncommitted subtitle rows.
import { callGeminiApi } from '../services/geminiService';
import { getVideoDuration } from '../utils/videoProcessor';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import { createFullMediaStreamingHandler } from './subtitleStreamingHandlers';
import { assertAutoGenerationContextDurable } from '../utils/autoGenerationOwnership';
import { bindGeminiTranscriptionDeliveries } from '../services/gemini/transcriptionDelivery';
import { loadExactProjectSubtitles } from '../platform/subtitleProjectStore';

const assertDurable = async (autoRunContext) => {
    if (autoRunContext) await assertAutoGenerationContextDurable(autoRunContext);
};

const callGeminiWithAdmission = async (run, extra = {}) => {
    const { input, inputType, options, runId, autoRunContext, prepared } = run;
    await assertDurable(autoRunContext);
    return callGeminiApi(input, inputType, await prepared.withGeminiProjectAdmission({
        userProvidedSubtitles: options.userProvidedSubtitles,
        ...extra,
        runId,
        promptContext: options.promptContext,
        autoRunContext,
        signal: options.signal
    }));
};

const transcribeSegment = async (run) => {
    const { input, options, runId, autoRunContext, prepared, presentation, streaming, t } = run;
    const { segment } = options;
    const { deliveryContext, validateDeliveryOwnership } = prepared;
    // The generation-start checkpoint acknowledged the latest manual edits. Read that exact
    // native project revision back as the merge base; a React setter callback is not a
    // transactional read and can stall or observe another project's presentation.
    await validateDeliveryOwnership(deliveryContext);
    const loadedSubtitles = await loadExactProjectSubtitles(
        deliveryContext.cacheId,
        deliveryContext.projectId
    );
    // A project with media but no subtitle track is the normal first-generation state. The
    // native store represents that absence as null; its merge identity is an empty timeline.
    const currentSubtitles = loadedSubtitles === null ? [] : loadedSubtitles;
    if (!Array.isArray(currentSubtitles)) {
        throw new Error('The native subtitle project returned an invalid track.');
    }
    await validateDeliveryOwnership(deliveryContext);

    run.currentSourceFileRef.current = input;

    await assertDurable(autoRunContext);
    const nonOverlappingSubtitles = currentSubtitles.filter(sub => (
        sub.end <= segment.start || sub.start >= segment.end
    ));
    streaming.handler = createFullMediaStreamingHandler(
        (streamingRows) => presentation.setGenerationSubtitlesData(
            [...nonOverlappingSubtitles, ...streamingRows].sort((a, b) => a.start - b.start)
        ),
        presentation.setGenerationStatus,
        t,
        {
            rollbackRows: currentSubtitles,
            rollbackPublisher: presentation.setGenerationSubtitlesData,
        },
    );
    const segmentSubtitles = await processGeminiSegment(
        input,
        segment,
        await prepared.withGeminiProjectAdmission({
            fps: options.fps,
            audioOnly: options.audioOnly === true,
            mediaResolution: options.mediaResolution,
            model: options.model,
            engine: options.engine,
            languageHints: options.languageHints,
            diarization: options.diarization,
            windowDurationSecs: options.windowDurationSecs,
            userProvidedSubtitles: options.userProvidedSubtitles,
            maxDurationPerRequest: options.maxDurationPerRequest,
            segmentProcessingDelay: options.segmentProcessingDelay,
            autoSplitSubtitles: options.autoSplitSubtitles,
            maxWordsPerSubtitle: options.maxWordsPerSubtitle,
            forceInline: options.inlineExtraction === true,
            runId,
            promptContext: options.promptContext,
            autoRunContext,
            signal: options.signal,
            t
        }),
        {
            onStatus: presentation.setGenerationStatus,
            onStreamingUpdate: streaming.handler,
            t
        }
    );

    // Build the replacement from the checkpointed pre-run snapshot without publishing
    // uncommitted provider rows. The exact-project save owns the visible commit.
    if (segmentSubtitles && segmentSubtitles.length > 0) {
        return bindGeminiTranscriptionDeliveries(
            [...nonOverlappingSubtitles, ...segmentSubtitles].sort((a, b) => a.start - b.start),
            segmentSubtitles
        );
    }
    return currentSubtitles;
};

const transcribeFullMedia = async (run) => {
    const { input, options, runId, autoRunContext, prepared, presentation, streaming, t } = run;
    const duration = await getVideoDuration(input);
    // Stream full video/audio unconditionally (feature parity with segment streaming)
    streaming.handler = createFullMediaStreamingHandler(
        presentation.setGenerationSubtitlesData,
        presentation.setGenerationStatus,
        t,
        { rollbackRows: prepared.presentationRollbackRows },
    );
    run.currentSourceFileRef.current = input;
    await assertDurable(autoRunContext);
    return await processGeminiSegment(
        input,
        { start: 0, end: duration },
        await prepared.withGeminiProjectAdmission({
            fps: options.fps,
            audioOnly: options.audioOnly === true,
            mediaResolution: options.mediaResolution,
            model: options.model,
            engine: options.engine,
            languageHints: options.languageHints,
            diarization: options.diarization,
            windowDurationSecs: options.windowDurationSecs,
            userProvidedSubtitles: options.userProvidedSubtitles,
            maxDurationPerRequest: options.maxDurationPerRequest,
            autoSplitSubtitles: options.autoSplitSubtitles,
            maxWordsPerSubtitle: options.maxWordsPerSubtitle,
            forceInline: options.inlineExtraction === true,
            runId,
            promptContext: options.promptContext,
            autoRunContext,
            signal: options.signal
        }),
        {
            onStatus: presentation.setGenerationStatus,
            onStreamingUpdate: streaming.handler,
            t
        }
    );
};

// A site URL without native media has no local file to stream, so it always uses the default
// Gemini call. The inline option only forgets the previously remembered source.
const transcribeYoutube = async (run) => {
    if (run.options.inlineExtraction === true) run.currentSourceFileRef.current = null;
    return callGeminiWithAdmission(run);
};

/**
 * @param {object} run
 * @param {*} run.input media descriptor, File or URL
 * @param {string} run.inputType
 * @param {object} run.options generation options (segment, fps, model, signal, ...)
 * @param {string} run.runId
 * @param {object|null} run.autoRunContext
 * @param {object} run.prepared result of prepareGeminiGeneration
 * @param {object} run.presentation run-owned status/subtitle publishers
 * @param {{ current: * }} run.currentSourceFileRef remembers the source for later retries
 * @param {{ handler: Function|null }} run.streaming receives the streaming handler it creates
 * @param {Function} run.t
 */
export const runGeminiTranscription = (run) => {
    if (run.options.segment) return transcribeSegment(run);
    const { type } = run.input;
    if (type && (type.startsWith('video/') || type.startsWith('audio/'))) {
        return transcribeFullMedia(run);
    }
    return transcribeYoutube(run);
};
