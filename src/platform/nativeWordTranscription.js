import { Channel } from '@tauri-apps/api/core';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

/**
 * Starts native word-native transcription via Tauri command.
 *
 * @param {Object} request
 * @param {string} request.projectId
 * @param {number} [request.expectedProjectStateVersion]
 * @param {string} [request.mediaAssetId]
 * @param {string} [request.filePath]
 * @param {string} [request.credentialId]
 * @param {number} [request.rangeStartMs]
 * @param {number} [request.rangeEndMs]
 * @param {number} [request.windowDurationMs]
 * @param {number} [request.windowDurationSecs]
 * @param {string[]} [request.languageHints]
 * @param {boolean} [request.diarization]
 * @param {Object} [request.config]
 * @param {Object} [handlers]
 * @param {(event: Object) => void} [handlers.onEvent]
 * @param {(event: Object) => void} [handlers.onStageChanged]
 * @param {(event: Object) => void} [handlers.onWindowProgress]
 * @param {(event: Object) => void} [handlers.onWindowPromoted]
 * @param {(event: Object) => void} [handlers.onCompleted]
 * @param {(event: Object) => void} [handlers.onCancelled]
 * @param {(event: Object) => void} [handlers.onFailed]
 * @param {(error: Error) => void} [handlers.onError]
 * @returns {Promise<Object>} JobSnapshot
 */
export const startWordNativeTranscription = async (request = {}, handlers = {}) => {
  if (!request.projectId || typeof request.projectId !== 'string') {
    throw new Error('Native word transcription requires an established active project ID');
  }

  const normalizedRequest = {
    projectId: request.projectId,
    ...(request.expectedProjectStateVersion !== undefined
      ? { expectedProjectStateVersion: request.expectedProjectStateVersion }
      : {}),
    ...(request.mediaAssetId ? { mediaAssetId: request.mediaAssetId } : {}),
    ...(request.filePath ? { filePath: request.filePath } : {}),
    ...(request.credentialId ? { credentialId: request.credentialId } : {}),
    ...(request.rangeStartMs !== undefined ? { rangeStartMs: request.rangeStartMs } : {}),
    ...(request.rangeEndMs !== undefined ? { rangeEndMs: request.rangeEndMs } : {}),
    ...(request.windowDurationMs !== undefined ? { windowDurationMs: request.windowDurationMs } : {}),
    ...(request.windowDurationSecs !== undefined ? { windowDurationSecs: request.windowDurationSecs } : {}),
    ...(Array.isArray(request.languageHints) ? { languageHints: request.languageHints } : {}),
    ...(request.diarization !== undefined ? { diarization: Boolean(request.diarization) } : {}),
    ...(request.config ? { config: request.config } : {}),
  };

  const channel = new Channel();
  channel.onmessage = (event) => {
    try {
      handlers.onEvent?.(event);
      if (!event || typeof event !== 'object') return;
      switch (event.event) {
        case 'windowCues':
          handlers.onWindowCues?.(event);
          break;
        case 'stageChanged':
          handlers.onStageChanged?.(event);
          break;
        case 'windowProgress':
          handlers.onWindowProgress?.(event);
          break;
        case 'windowPromoted':
          handlers.onWindowPromoted?.(event);
          break;
        case 'completed':
          handlers.onCompleted?.(event);
          break;
        case 'cancelled':
          handlers.onCancelled?.(event);
          break;
        case 'failed':
          handlers.onFailed?.(event);
          break;
        default:
          break;
      }
    } catch (err) {
      handlers.onError?.(err);
    }
  };

  return await invokeDesktop('start_word_native_transcription', {
    request: normalizedRequest,
    onEvent: channel,
  });
};

/**
 * Cancels an in-flight native transcription operation.
 *
 * @param {string} taskId
 * @returns {Promise<Object>} JobSnapshot
 */
export const cancelWordNativeTranscription = async (taskId) => {
  return await invokeDesktop('cancel_transcription', {
    taskId,
    jobId: taskId,
  });
};

export const getNativeTranscriptionJob = async (taskId) => {
  return await invokeDesktop('job_get', { id: taskId });
};

export const isNativeWordTranscriptionSupported = () => isDesktopRuntime();
