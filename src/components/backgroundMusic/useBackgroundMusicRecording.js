// Recording state for PromptDJ output: start/stop commands, the elapsed timer, and the trimmed
// recording's object URL (revoked whenever it is replaced, cleared or unmounted).
import { useCallback, useEffect, useRef, useState } from 'react';
import { trimSilenceFromBlob } from '../../utils/audioTrim';

const MAX_RECORDING_BYTES = 512 * 1024 * 1024;
const RECORDING_TYPE = /^audio\/(?:wav|webm)(?:;|$)/i;

const revokeUrl = (url) => {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch {
    // Revoking an already-released recording URL is harmless.
  }
};

const isAcceptedRecording = (blob) => blob instanceof Blob
  && blob.size > 0
  && blob.size <= MAX_RECORDING_BYTES
  && RECORDING_TYPE.test(blob.type);

/**
 * @param {object} params
 * @param {() => Window|null} params.getPromptDjWindow
 * @param {(message: object) => void} params.postToPromptDj
 */
const useBackgroundMusicRecording = ({ getPromptDjWindow, postToPromptDj }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recordingBlob, setRecordingBlob] = useState(null);
  const [recordingStartTime, setRecordingStartTime] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const recordingUrlRef = useRef('');
  recordingUrlRef.current = recordingUrl;

  const publishRecording = useCallback((blob) => {
    revokeUrl(recordingUrlRef.current);
    setRecordingBlob(blob);
    setRecordingUrl(URL.createObjectURL(blob));
  }, []);

  const clearRecording = useCallback(() => {
    revokeUrl(recordingUrlRef.current);
    setRecordingUrl('');
    setRecordingBlob(null);
  }, []);

  const startRecording = useCallback(() => {
    if (!getPromptDjWindow()) return;
    clearRecording();
    setRecordingStartTime(Date.now());
    postToPromptDj({ type: 'pm-dj-start-recording' });
  }, [clearRecording, getPromptDjWindow, postToPromptDj]);

  const stopRecording = useCallback(() => {
    postToPromptDj({ type: 'pm-dj-stop-recording' });
  }, [postToPromptDj]);

  const onRecordingStarted = useCallback(() => {
    setIsRecording(true);
    setRecordingStartTime((prev) => prev ?? Date.now());
  }, []);

  const onRecordingError = useCallback(() => {
    setIsRecording(false);
  }, []);

  const onRecordingStopped = useCallback(async (blob) => {
    setIsRecording(false);
    if (!isAcceptedRecording(blob)) return;
    try {
      const trimmed = await trimSilenceFromBlob(blob, {
        silenceThreshold: 0.004, // ~ -48 dBFS
        minSilenceMs: 180,
        analysisWindowMs: 20,
      });
      publishRecording(trimmed || blob);
    } catch {
      try {
        publishRecording(blob);
      } catch {
        // A failed raw-blob fallback leaves the prior recording unchanged.
      }
    }
  }, [publishRecording]);

  useEffect(() => {
    if (isRecording && recordingStartTime) {
      setElapsed((Date.now() - recordingStartTime) / 1000);
      const id = setInterval(() => {
        setElapsed((Date.now() - recordingStartTime) / 1000);
      }, 100);
      return () => clearInterval(id);
    }
    setElapsed(0);
    return undefined;
  }, [isRecording, recordingStartTime]);

  useEffect(() => () => revokeUrl(recordingUrl), [recordingUrl]);

  return {
    isRecording,
    recordingUrl,
    recordingBlob,
    elapsed,
    startRecording,
    stopRecording,
    clearRecording,
    onRecordingStarted,
    onRecordingStopped,
    onRecordingError,
  };
};

export default useBackgroundMusicRecording;
