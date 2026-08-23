import { useRef } from 'react';

import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { importAudioBlob, releaseAudioBlob } from '../../../platform/mediaService';
import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import { getActiveProjectSnapshot } from '../../../platform/projectService';
import {
  createNativeNarrationToken,
  getNativeNarrationArtifactId,
} from '../../../platform/nativeNarrationCapabilities';
import { transcribeAudio } from '../../../services/transcriptionService';

const RECORDING_MIME_TYPES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
]);

const useAudioIO = ({
  mediaRecorderRef,
  audioChunksRef,
  referenceAudio,
  referenceText,
  setReferenceAudio,
  setReferenceText,
  setRecordedAudio,
  setIsRecording,
  setIsStartingRecording,
  setRecordingStartTime,
  setIsExtractingSegment,
  setIsRecognizing,
  setError,
  autoRecognize,
  segmentStartTime,
  segmentEndTime,
  onReferenceAudioChange,
  t,
  narrationMethod,
}) => {
  const nativeRuntime = isDesktopRuntime();
  const recordingStartTimeRef = useRef(null);

  const requireProjectContext = async () => {
    const active = getActiveProjectSnapshot();
    if (!active?.metadata?.id || !Number.isSafeInteger(active.stateVersion)) {
      const error = new Error('An active subtitle project is required for reference audio');
      error.code = 'referenceProjectUnavailable';
      throw error;
    }
    const context = Object.freeze({
      projectId: active.metadata.id,
      projectStateVersion: active.stateVersion,
    });
    const stored = await nativeNarrationAdapter.getReference(context.projectId);
    const confirmed = getActiveProjectSnapshot();
    if (confirmed?.metadata?.id !== context.projectId
        || confirmed.stateVersion !== context.projectStateVersion) {
      if (stored) releaseReferencePlayback(stored);
      const error = new Error('The active subtitle project changed');
      error.code = 'referenceProjectChanged';
      throw error;
    }
    return Object.freeze({
      ...context,
      expectedReferenceVersion: stored?.referenceVersion ?? 0,
      stored,
    });
  };

  const stillOwnsProject = (context) => {
    const active = getActiveProjectSnapshot();
    return active?.metadata?.id === context.projectId
      && active.stateVersion === context.projectStateVersion;
  };

  const assertStillOwnsProject = (context) => {
    if (stillOwnsProject(context)) return;
    const error = new Error('The active subtitle project changed');
    error.code = 'referenceProjectChanged';
    throw error;
  };

  const failClosed = () => {
    setError(t(
      'narration.serviceUnavailableMessage',
      'Narration requires the desktop runtime',
    ));
    return null;
  };

  const releaseReferencePlayback = (reference) => {
    if (!nativeRuntime || !reference?.nativePlaybackId) return;
    nativeNarrationAdapter.releasePlayback(reference).catch(() => undefined);
  };

  const publishReference = (context, playable, {
    text = playable?.text ?? referenceText,
    language = playable?.language ?? 'Unknown',
  } = {}) => {
    if (!stillOwnsProject(context)
        || playable?.projectId !== context.projectId
        || !Number.isSafeInteger(playable?.referenceVersion)) {
      releaseReferencePlayback(playable);
      const error = new Error('The active subtitle project changed');
      error.code = 'referenceProjectChanged';
      throw error;
    }
    const artifactId = getNativeNarrationArtifactId(playable);
    if (!artifactId || !playable?.nativePlaybackId || !playable?.audioUrl) {
      throw new Error('Native reference audio is unavailable');
    }
    if (referenceAudio?.nativePlaybackId !== playable.nativePlaybackId) {
      releaseReferencePlayback(referenceAudio);
    }
    const normalized = {
      nativeArtifactId: artifactId,
      nativePlaybackId: playable.nativePlaybackId,
      filename: createNativeNarrationToken(artifactId),
      url: playable.audioUrl,
      audioUrl: playable.audioUrl,
      mimeType: playable.mimeType,
      format: playable.format,
      durationMicros: playable.durationMicros,
      projectId: playable.projectId,
      projectStateVersion: context.projectStateVersion,
      referenceVersion: playable.referenceVersion,
      pendingDelivery: playable.pendingDelivery ?? null,
      language,
      text: text || '',
    };
    setReferenceAudio(normalized);
    setReferenceText(normalized.text);
    onReferenceAudioChange?.({
      nativeArtifactId: artifactId,
      filename: normalized.filename,
      text: normalized.text,
      language,
    });
    return normalized;
  };

  const transcribeReference = async (blob, context) => {
    if (!autoRecognize || narrationMethod !== 'f5tts') return null;
    setIsRecognizing(true);
    try {
      return await transcribeAudio(blob, {
        projectId: context.projectId,
        expectedProjectStateVersion: context.projectStateVersion,
      });
    } finally {
      setIsRecognizing(false);
    }
  };

  const importReference = async (blob, source) => {
    if (!nativeRuntime) return failClosed();
    let imported = null;
    let playable = null;
    let context = null;
    try {
      context = await requireProjectContext();
      imported = await importAudioBlob(blob);
      assertStillOwnsProject(context);
      playable = await nativeNarrationAdapter.importReference({
        method: narrationMethod,
        assetId: imported.assetId,
        projectId: context.projectId,
        expectedProjectStateVersion: context.projectStateVersion,
        expectedReferenceVersion: context.expectedReferenceVersion,
      });
      assertStillOwnsProject(context);
      if (context.stored?.nativePlaybackId !== playable.nativePlaybackId) {
        releaseReferencePlayback(context.stored);
      }
      if (!stillOwnsProject(context)) {
        releaseReferencePlayback(playable);
        return null;
      }
      const transcription = await transcribeReference(blob, context).catch((error) => {
          setError(error.message || t(
            'narration.recognitionError',
            'Error recognizing reference audio',
          ));
          return null;
      });
      assertStillOwnsProject(context);
      if (transcription?.delivery) {
        const committed = await nativeNarrationAdapter.commitReference({
          projectId: context.projectId,
          expectedProjectStateVersion: context.projectStateVersion,
          expectedReferenceVersion: playable.referenceVersion,
          artifactId: playable.nativeArtifactId,
          transcript: transcription.text,
          language: transcription.language,
          deliveryJobId: transcription.delivery.jobId,
          deliveryId: transcription.delivery.deliveryId,
        });
        assertStillOwnsProject(context);
        const verified = await nativeNarrationAdapter.getReference(context.projectId);
        assertStillOwnsProject(context);
        if (!verified
            || verified.nativeArtifactId !== playable.nativeArtifactId
            || verified.referenceVersion !== committed.referenceVersion
            || verified.text !== transcription.text
            || verified.language !== transcription.language) {
          releaseReferencePlayback(verified);
          throw new Error('The durable reference audio could not be verified');
        }
        releaseReferencePlayback(playable);
        playable = verified;
        try {
          assertStillOwnsProject(context);
          await transcription.delivery.acknowledge();
          assertStillOwnsProject(context);
          if (stillOwnsProject(context)) {
            const cleared = await nativeNarrationAdapter.commitReference({
              projectId: context.projectId,
              expectedProjectStateVersion: context.projectStateVersion,
              expectedReferenceVersion: playable.referenceVersion,
              artifactId: playable.nativeArtifactId,
              transcript: playable.text,
              language: playable.language,
              deliveryJobId: null,
              deliveryId: null,
            });
            assertStillOwnsProject(context);
            playable = Object.freeze({
              ...playable,
              referenceVersion: cleared.referenceVersion,
              pendingDelivery: null,
            });
          }
        } catch {
          // The exact delivery remains in both SQLite records and is retried during hydration.
        }
      } else {
        const fallbackText = referenceText || '';
        if (fallbackText !== playable.text) {
          assertStillOwnsProject(context);
          const committed = await nativeNarrationAdapter.commitReference({
            projectId: context.projectId,
            expectedProjectStateVersion: context.projectStateVersion,
            expectedReferenceVersion: playable.referenceVersion,
            artifactId: playable.nativeArtifactId,
            transcript: fallbackText,
            language: playable.language || 'Unknown',
            deliveryJobId: null,
            deliveryId: null,
          });
          assertStillOwnsProject(context);
          playable = Object.freeze({
            ...playable,
            text: committed.transcript,
            language: committed.language,
            referenceVersion: committed.referenceVersion,
          });
        }
      }
      const normalized = publishReference(context, playable, {
        text: transcription?.text ?? playable.text ?? referenceText ?? '',
        language: transcription?.language ?? playable.language ?? 'Unknown',
        source,
      });
      setRecordedAudio({
        nativeArtifactId: normalized.nativeArtifactId,
        url: normalized.url,
      });
      return normalized;
    } catch (error) {
      if (playable && referenceAudio?.nativePlaybackId !== playable.nativePlaybackId) {
        releaseReferencePlayback(playable);
      }
      setError(error.message || t(
        'narration.uploadError',
        'Error uploading reference audio',
      ));
      return null;
    } finally {
      if (imported) await releaseAudioBlob(imported.assetId).catch(() => undefined);
    }
  };

  const handleFileUpload = async (event) => {
    const file = event?.target?.files?.[0];
    if (!file) return;
    await importReference(file, 'native upload');
    event.target.value = '';
  };

  const startRecording = async () => {
    if (!nativeRuntime) {
      failClosed();
      return;
    }
    try {
      setError('');
      audioChunksRef.current = [];
      setIsStartingRecording?.(true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        ? RECORDING_MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate))
        : null;
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        try {
          if (audioChunksRef.current.length === 0) {
            setError(t('narration.noAudioData', 'No audio data recorded'));
            return;
          }
          const duration = recordingStartTimeRef.current
            ? (Date.now() - recordingStartTimeRef.current) / 1_000
            : 0;
          if (narrationMethod === 'f5tts' && duration > 12) {
            window.dispatchEvent(new CustomEvent('aligned-narration-status', {
              detail: {
                status: 'error',
                message: t(
                  'narration.f5ttsAudioTooLongError',
                  'Reference audio for F5TTS cannot be longer than 12s',
                ),
              },
            }));
            return;
          }
          const blob = new Blob(audioChunksRef.current, {
            type: recorder.mimeType || audioChunksRef.current[0]?.type || 'audio/webm',
          });
          await importReference(blob, 'native recording');
        } finally {
          recordingStartTimeRef.current = null;
          setRecordingStartTime?.(null);
        }
      };
      recorder.start();
      recordingStartTimeRef.current = Date.now();
      setRecordingStartTime?.(recordingStartTimeRef.current);
      setIsRecording(true);
      setIsStartingRecording?.(false);
    } catch (error) {
      setIsStartingRecording?.(false);
      setError(error.message || t(
        'narration.microphoneError',
        'Error accessing microphone',
      ));
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    recorder.stop();
    setIsRecording(false);
    recorder.stream?.getTracks().forEach((track) => track.stop());
  };

  const extractSegment = async () => {
    if (!nativeRuntime) {
      failClosed();
      return;
    }
    if (segmentStartTime === '' || segmentEndTime === '') {
      setError(t('narration.timeRangeError', 'Please specify both start and end times'));
      return;
    }
    setIsExtractingSegment(true);
    setError('');
    let playable = null;
    let context = null;
    try {
      context = await requireProjectContext();
      playable = await nativeNarrationAdapter.extractReference({
        method: narrationMethod,
        startMs: Math.round(Number(segmentStartTime) * 1_000),
        endMs: Math.round(Number(segmentEndTime) * 1_000),
        projectId: context.projectId,
        expectedProjectStateVersion: context.projectStateVersion,
        expectedReferenceVersion: context.expectedReferenceVersion,
      });
      assertStillOwnsProject(context);
      if (context.stored?.nativePlaybackId !== playable.nativePlaybackId) {
        releaseReferencePlayback(context.stored);
      }
      if ((referenceText || '') !== playable.text) {
        assertStillOwnsProject(context);
        const committed = await nativeNarrationAdapter.commitReference({
          projectId: context.projectId,
          expectedProjectStateVersion: context.projectStateVersion,
          expectedReferenceVersion: playable.referenceVersion,
          artifactId: playable.nativeArtifactId,
          transcript: referenceText || '',
          language: 'Unknown',
          deliveryJobId: null,
          deliveryId: null,
        });
        assertStillOwnsProject(context);
        playable = Object.freeze({
          ...playable,
          text: committed.transcript,
          language: committed.language,
          referenceVersion: committed.referenceVersion,
        });
      }
      publishReference(context, playable, { text: referenceText, language: 'Unknown' });
    } catch (error) {
      if (playable && referenceAudio?.nativePlaybackId !== playable.nativePlaybackId) {
        releaseReferencePlayback(playable);
      }
      setError(error.message || t(
        'narration.extractionError',
        'Error extracting audio segment',
      ));
    } finally {
      setIsExtractingSegment(false);
    }
  };

  const clearReferenceAudio = async () => {
    const active = getActiveProjectSnapshot();
    if (referenceAudio?.projectId
        && active?.metadata?.id === referenceAudio.projectId
        && active.stateVersion === referenceAudio.projectStateVersion) {
      await nativeNarrationAdapter.clearReference({
        projectId: referenceAudio.projectId,
        expectedProjectStateVersion: active.stateVersion,
        expectedReferenceVersion: referenceAudio.referenceVersion,
      });
      assertStillOwnsProject({
        projectId: referenceAudio.projectId,
        projectStateVersion: active.stateVersion,
      });
      releaseReferencePlayback(referenceAudio);
      setReferenceAudio(null);
      setRecordedAudio(null);
      setReferenceText('');
      onReferenceAudioChange?.(null);
    }
  };

  const handleExampleSelect = async (result) => {
    if (!nativeRuntime) return failClosed();
    try {
      const context = await requireProjectContext();
      const artifactId = getNativeNarrationArtifactId(result);
      if (artifactId) {
        throw new Error('Select or upload the sample so it can be copied into this project');
      }
      let playable = await nativeNarrationAdapter.selectReference({
        method: narrationMethod,
        projectId: context.projectId,
        expectedProjectStateVersion: context.projectStateVersion,
        expectedReferenceVersion: context.expectedReferenceVersion,
      });
      assertStillOwnsProject(context);
      if (!playable) return null;
      if (context.stored?.nativePlaybackId !== playable.nativePlaybackId) {
        releaseReferencePlayback(context.stored);
      }
      const selectedText = result?.reference_text || result?.text || referenceText || '';
      const selectedLanguage = result?.language || 'Unknown';
      if (selectedText !== playable.text || selectedLanguage !== playable.language) {
        assertStillOwnsProject(context);
        const committed = await nativeNarrationAdapter.commitReference({
          projectId: context.projectId,
          expectedProjectStateVersion: context.projectStateVersion,
          expectedReferenceVersion: playable.referenceVersion,
          artifactId: playable.nativeArtifactId,
          transcript: selectedText,
          language: selectedLanguage,
          deliveryJobId: null,
          deliveryId: null,
        });
        assertStillOwnsProject(context);
        playable = Object.freeze({
          ...playable,
          text: committed.transcript,
          language: committed.language,
          referenceVersion: committed.referenceVersion,
        });
      }
      return publishReference(context, playable, {
        text: selectedText,
        language: selectedLanguage,
      });
    } catch (error) {
      setError(error.message || t(
        'narration.uploadError',
        'Error uploading reference audio',
      ));
      return null;
    }
  };

  return {
    handleFileUpload,
    startRecording,
    stopRecording,
    extractSegment,
    clearReferenceAudio,
    handleExampleSelect,
  };
};

export default useAudioIO;
