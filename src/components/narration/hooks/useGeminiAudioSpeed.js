import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { editNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import {
  getNativeNarrationArtifactId,
  isNativeNarrationResult,
} from '../../../platform/nativeNarrationCapabilities';

const getBackupName = (filename) => filename ? `backup_${filename}` : null;
const durationSeconds = (result) => Number(result?.durationMicros) / 1_000_000;

const useGeminiAudioSpeed = ({
  generationResults,
  speedValue,
  itemSpeeds,
  itemTrims,
  itemDurations,
  setItemSpeeds,
  setItemDurations,
  setItemProcessing,
  setIsProcessing,
  setProcessingProgress,
  setCurrentFile,
  t,
}) => {
  const fetchDurationsBatch = async (filenames) => {
    if (!Array.isArray(filenames) || filenames.length === 0) return;
    const durations = {};
    if (isDesktopRuntime()) {
      (generationResults || []).filter(isNativeNarrationResult).forEach((result) => {
        const duration = durationSeconds(result);
        if (result.filename && Number.isFinite(duration) && duration > 0) {
          durations[result.filename] = duration;
          durations[getBackupName(result.filename)] = duration;
        }
      });
    }
    setItemDurations((previous) => ({ ...previous, ...durations }));
  };

  const editResult = async (result, speed, range) => {
    if (!isDesktopRuntime() || !isNativeNarrationResult(result)) {
      throw new Error('Native narration audio is unavailable');
    }
    const metadataDuration = durationSeconds(result);
    const total = Number.isFinite(metadataDuration) && metadataDuration > 0
      ? metadataDuration
      : itemDurations[getBackupName(result.filename)] || itemDurations[result.filename];
    if (!Number.isFinite(total) || total <= 0) {
      throw new Error('Native narration duration is unavailable');
    }
    const [start, end] = range || [0, total];
    const replacement = await editNativeNarration(result, {
      normalizedStart: start / total,
      normalizedEnd: end / total,
      speedFactor: Number(speed),
    });
    window.dispatchEvent(new CustomEvent('native-narration-artifact-edited', {
      detail: {
        previousArtifactId: getNativeNarrationArtifactId(result),
        result: replacement,
      },
    }));
    const replacementDuration = durationSeconds(replacement);
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
    if (successful.length === 0) {
      setIsProcessing(false);
      return;
    }
    setItemSpeeds((previous) => ({
      ...previous,
      ...Object.fromEntries(successful.map((result) => [result.subtitle_id, Number(speedValue)])),
    }));
    setIsProcessing(true);
    setCurrentFile('');
    setProcessingProgress({ current: 0, total: successful.length });
    try {
      for (let index = 0; index < successful.length; index += 1) {
        const result = successful[index];
        await editResult(result, speedValue, itemTrims[result.subtitle_id]);
        setProcessingProgress({ current: index + 1, total: successful.length });
      }
      window.resetAlignedNarration?.();
      window.dispatchEvent(new CustomEvent('narration-speed-modified', {
        detail: { speed: speedValue, timestamp: Date.now() },
      }));
    } catch (error) {
      window.addToast?.(t(
        'narration.speedModificationError',
        `Error applying batch edit: ${error.message}`,
      ), 'error');
    } finally {
      setIsProcessing(false);
      setCurrentFile('');
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
      window.resetAlignedNarration?.();
      window.dispatchEvent(new CustomEvent('narration-edit-modified', {
        detail: {
          start: itemTrims[id]?.[0],
          end: itemTrims[id]?.[1],
          speed: itemSpeeds[id],
          id,
          timestamp: Date.now(),
        },
      }));
    } catch (error) {
      window.addToast?.(t(
        'narration.trimModificationError',
        `Error applying edit: ${error.message}`,
      ), 'error');
    } finally {
      setItemProcessing((previous) => ({ ...previous, [id]: { inProgress: false } }));
    }
  };

  return { modifyAudioSpeed, modifySingleAudioEditCombined, fetchDurationsBatch };
};

export default useGeminiAudioSpeed;
