import { useRef } from 'react';

import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { importAudioBlob, releaseAudioBlob } from '../../../platform/mediaService';
import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import {
  createNativeNarrationToken,
  getNativeNarrationArtifactId,
} from '../../../platform/nativeNarrationCapabilities';
import { transcribeAudio } from '../../../services/transcriptionService';
import { cacheReferenceAudio } from './referenceAudioCache';

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

  const commitReference = (playable, {
    text = referenceText,
    language = 'English',
    source = 'native import',
  } = {}) => {
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
      language,
      text: text || '',
    };
    setReferenceAudio(normalized);
    cacheReferenceAudio(normalized, source);
    onReferenceAudioChange?.({
      nativeArtifactId: artifactId,
      filename: normalized.filename,
      text: normalized.text,
      language,
    });
    return normalized;
  };

  const transcribeReference = async (blob) => {
    if (!autoRecognize || narrationMethod !== 'f5tts') return null;
    setIsRecognizing(true);
    try {
      return await transcribeAudio(blob);
    } finally {
      setIsRecognizing(false);
    }
  };

  const importReference = async (blob, source) => {
    if (!nativeRuntime) return failClosed();
    let imported = null;
    let playable = null;
    let committed = false;
    try {
      imported = await importAudioBlob(blob);
      const [resolved, transcription] = await Promise.all([
        nativeNarrationAdapter.importReference({
          method: narrationMethod,
          assetId: imported.assetId,
        }),
        transcribeReference(blob).catch((error) => {
          setError(error.message || t(
            'narration.recognitionError',
            'Error recognizing reference audio',
          ));
          return null;
        }),
      ]);
      playable = resolved;
      if (transcription?.text) setReferenceText(transcription.text);
      const normalized = commitReference(playable, {
        text: transcription?.text || referenceText || '',
        language: transcription?.language || 'English',
        source,
      });
      committed = true;
      setRecordedAudio({
        nativeArtifactId: normalized.nativeArtifactId,
        url: normalized.url,
      });
      return normalized;
    } catch (error) {
      if (playable && !committed) releaseReferencePlayback(playable);
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
    let committed = false;
    try {
      playable = await nativeNarrationAdapter.extractReference({
        method: narrationMethod,
        startMs: Math.round(Number(segmentStartTime) * 1_000),
        endMs: Math.round(Number(segmentEndTime) * 1_000),
      });
      commitReference(playable, { source: 'native extraction' });
      committed = true;
    } catch (error) {
      if (playable && !committed) releaseReferencePlayback(playable);
      setError(error.message || t(
        'narration.extractionError',
        'Error extracting audio segment',
      ));
    } finally {
      setIsExtractingSegment(false);
    }
  };

  const clearReferenceAudio = () => {
    releaseReferencePlayback(referenceAudio);
    setReferenceAudio(null);
    setRecordedAudio(null);
    setReferenceText('');
    try {
      localStorage.removeItem('reference_audio_cache');
    } catch {
      // Storage cleanup is best-effort.
    }
    onReferenceAudioChange?.(null);
  };

  const handleExampleSelect = async (result) => {
    if (!nativeRuntime) return failClosed();
    try {
      const artifactId = getNativeNarrationArtifactId(result);
      const playable = artifactId
        ? (result?.nativePlaybackId && result?.audioUrl
          ? result
          : await nativeNarrationAdapter.resolvePlayback(artifactId))
        : await nativeNarrationAdapter.selectReference(narrationMethod);
      if (!playable) return null;
      return commitReference(playable, {
        text: result?.reference_text || result?.text || referenceText,
        language: result?.language || 'English',
        source: 'native selection',
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
