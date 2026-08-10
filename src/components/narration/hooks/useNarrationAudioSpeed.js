import { useCallback, useState } from 'react';

import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { editNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import {
  getNativeNarrationArtifactId,
  isNativeNarrationResult,
} from '../../../platform/nativeNarrationCapabilities';

const getBackupName = (filename) => filename ? `backup_${filename}` : null;
const seconds = (result) => Number(result?.durationMicros) / 1_000_000;

const dispatchEdit = (previous, replacement) => {
  window.dispatchEvent(new CustomEvent('native-narration-artifact-edited', {
    detail: {
      previousArtifactId: getNativeNarrationArtifactId(previous),
      result: replacement,
    },
  }));
};

const resetAlignment = (name, detail) => {
  window.resetAlignedNarration?.();
  window.dispatchEvent(new CustomEvent(name, { detail }));
};

const useNarrationAudioSpeed = ({ generationResults, t }) => {
  const [itemDurations, setItemDurations] = useState({});
  const [speedValue, setSpeedValue] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [itemSpeeds, setItemSpeeds] = useState({});
  const [itemProcessing, setItemProcessing] = useState({});
  const [itemTrims, setItemTrims] = useState({});

  const fetchDurationsBatch = useCallback(async () => {
    const durations = {};
    if (isDesktopRuntime()) {
      (generationResults || []).filter(isNativeNarrationResult).forEach((result) => {
        const duration = seconds(result);
        if (result.filename && Number.isFinite(duration) && duration > 0) {
          durations[result.filename] = duration;
          durations[getBackupName(result.filename)] = duration;
        }
      });
    }
    setItemDurations((previous) => ({ ...previous, ...durations }));
  }, [generationResults]);

  const setItemSpeed = (id, value) => {
    setItemSpeeds((previous) => ({ ...previous, [id]: value }));
  };

  const setItemTrim = (id, range) => {
    setItemTrims((previous) => ({ ...previous, [id]: range }));
  };

  const editResult = async (result, speed, range) => {
    if (!isDesktopRuntime() || !isNativeNarrationResult(result)) {
      throw new Error('Native narration audio is unavailable');
    }
    const duration = seconds(result);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Native narration duration is unavailable');
    }
    const [start, end] = range || [0, duration];
    const replacement = await editNativeNarration(result, {
      normalizedStart: start / duration,
      normalizedEnd: end / duration,
      speedFactor: Number(speed),
    });
    dispatchEdit(result, replacement);
    const replacementDuration = seconds(replacement);
    if (replacement.filename && Number.isFinite(replacementDuration)) {
      setItemDurations((previous) => ({
        ...previous,
        [replacement.filename]: replacementDuration,
        [getBackupName(replacement.filename)]: replacementDuration,
      }));
    }
    return replacement;
  };

  const modifyAudioSpeed = async () => {
    const successful = (generationResults || [])
      .filter((result) => result.success && result.filename);
    if (successful.length === 0) return;
    setItemSpeeds((previous) => ({
      ...previous,
      ...Object.fromEntries(successful.map((result) => [result.subtitle_id, Number(speedValue)])),
    }));
    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: successful.length });
    try {
      for (let index = 0; index < successful.length; index += 1) {
        const result = successful[index];
        await editResult(result, speedValue, itemTrims[result.subtitle_id]);
        setProcessingProgress({ current: index + 1, total: successful.length });
      }
      resetAlignment('narration-speed-modified', {
        speed: speedValue,
        timestamp: Date.now(),
      });
    } catch (error) {
      alert(t(
        'narration.speedModificationError',
        `Error applying batch edit: ${error.message}`,
      ));
    } finally {
      setIsProcessing(false);
    }
  };

  const modifySingleAudioEditCombined = async (result) => {
    if (!result?.filename) return;
    const id = result.subtitle_id;
    setItemProcessing((previous) => ({ ...previous, [id]: { inProgress: true } }));
    try {
      await editResult(
        result,
        typeof itemSpeeds[id] === 'number' ? itemSpeeds[id] : 1,
        itemTrims[id],
      );
      resetAlignment('narration-edit-modified', {
        id,
        start: itemTrims[id]?.[0],
        end: itemTrims[id]?.[1],
        speed: itemSpeeds[id],
        timestamp: Date.now(),
      });
    } catch (error) {
      alert(t(
        'narration.trimModificationError',
        `Error applying edit: ${error.message}`,
      ));
    } finally {
      setItemProcessing((previous) => ({ ...previous, [id]: { inProgress: false } }));
    }
  };

  return {
    itemDurations,
    setItemDurations,
    fetchDurationsBatch,
    speedValue,
    setSpeedValue,
    isProcessing,
    processingProgress,
    itemSpeeds,
    setItemSpeed,
    itemProcessing,
    itemTrims,
    setItemTrim,
    modifyAudioSpeed,
    modifySingleAudioEditCombined,
  };
};

export default useNarrationAudioSpeed;
