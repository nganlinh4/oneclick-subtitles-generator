import { useCallback, useState } from 'react';
import { SERVER_URL } from '../../../config';
import { deriveSubtitleId } from '../../../utils/subtitle/idUtils';

/**
 * Camb AI narration hook. Mirrors useEdgeTTSNarration but:
 *  - targets /api/narration/camb/generate
 *  - supports an additional one-click "dub" action via /api/narration/camb/dub
 */
const useCambNarration = ({
  setIsGenerating,
  setGenerationStatus,
  setError,
  setGenerationResults,
  generationResults,
  subtitleSource,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  selectedVoice,
  cambLanguage,
  t,
  setRetryingSubtitleId,
  useGroupedSubtitles,
  groupedSubtitles,
  setUseGroupedSubtitles,
}) => {
  const [abortController, setAbortController] = useState(null);

  const getSubtitlesForGeneration = useCallback(() => {
    if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
      return groupedSubtitles;
    }
    if (subtitleSource === 'original' && originalSubtitles?.length > 0) return originalSubtitles;
    if (subtitleSource === 'translated' && translatedSubtitles?.length > 0) return translatedSubtitles;
    return subtitles || [];
  }, [subtitleSource, originalSubtitles, translatedSubtitles, subtitles, useGroupedSubtitles, groupedSubtitles]);

  const handleCambNarration = useCallback(async () => {
    const { clearNarrationCachesAndFiles } = await import('../utils/cacheManager');
    await clearNarrationCachesAndFiles(setGenerationResults);

    const subtitlesToProcess = getSubtitlesForGeneration();
    if (!subtitlesToProcess?.length) {
      setError(t('narration.noSubtitlesError', 'No subtitles available for narration generation.'));
      return;
    }

    try {
      setIsGenerating(true);
      setError('');
      setGenerationResults([]);

      const controller = new AbortController();
      setAbortController(controller);

      const processed = subtitlesToProcess.map((s, idx) => ({
        ...s,
        id: deriveSubtitleId(s, idx),
      }));

      setGenerationStatus(t('narration.cambStarting', 'Starting Camb AI generation...'));

      const response = await fetch(`${SERVER_URL}/api/narration/camb/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtitles: processed,
          settings: { voice_id: selectedVoice, language: cambLanguage || 'en' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const results = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.status === 'progress' || data.status === 'error') {
              if (data.result) {
                results.push(data.result);
                setGenerationResults([...results]);
              }
              setGenerationStatus(
                t('narration.cambGeneratingProgress', 'Generating {{current}} of {{total}} narrations with Camb AI...', {
                  current: data.current,
                  total: data.total,
                }),
              );
            } else if (data.status === 'completed') {
              const finalResults = data.results || results;
              setGenerationResults(finalResults);
              setGenerationStatus(t('narration.cambGenerationComplete', 'Camb AI narration generation completed!'));
              if (useGroupedSubtitles && groupedSubtitles?.length) {
                window.groupedNarrations = [...finalResults];
                window.useGroupedSubtitles = true;
                setUseGroupedSubtitles(true);
              } else {
                if (subtitleSource === 'original') window.originalNarrations = [...finalResults];
                else window.translatedNarrations = [...finalResults];
                window.useGroupedSubtitles = false;
              }
            }
          } catch (_e) {
            /* ignore parse errors */
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Camb generation error:', err);
        setError(t('narration.cambGenerationError', 'Error generating Camb AI narration: {{error}}', { error: err.message }));
      }
    } finally {
      setIsGenerating(false);
      setAbortController(null);
    }
  }, [
    getSubtitlesForGeneration,
    selectedVoice,
    cambLanguage,
    setIsGenerating,
    setError,
    setGenerationResults,
    setGenerationStatus,
    t,
    useGroupedSubtitles,
    groupedSubtitles,
    setUseGroupedSubtitles,
    subtitleSource,
  ]);

  const cancelCambGeneration = useCallback(() => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
    setIsGenerating(false);
    setGenerationStatus(t('narration.cambGenerationCancelled', 'Camb AI generation cancelled'));
  }, [abortController, setIsGenerating, setGenerationStatus, t]);

  /**
   * One-click dub: submit a source URL (or path) and target language to Camb.
   */
  const handleCambDub = useCallback(
    async ({ sourceUrl, sourcePath, sourceLanguage = 'en', targetLanguage, preserveBackground = true }) => {
      if (!targetLanguage) {
        setError(t('narration.cambDubNoTarget', 'Select a target language to dub into.'));
        return null;
      }
      try {
        setIsGenerating(true);
        setError('');
        setGenerationStatus(t('narration.cambDubbing', 'Dubbing with Camb AI (this can take a few minutes)...'));
        const resp = await fetch(`${SERVER_URL}/api/narration/camb/dub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_url: sourceUrl,
            source_path: sourcePath,
            source_language: sourceLanguage,
            target_language: targetLanguage,
            preserve_background_audio: preserveBackground,
          }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || 'Dubbing failed');
        setGenerationStatus(t('narration.cambDubComplete', 'Camb AI dubbing complete.'));
        return data.job;
      } catch (err) {
        console.error('Camb dub error:', err);
        setError(t('narration.cambDubError', 'Camb dubbing error: {{error}}', { error: err.message }));
        return null;
      } finally {
        setIsGenerating(false);
      }
    },
    [setIsGenerating, setError, setGenerationStatus, t],
  );

  const retryCambNarration = useCallback(
    async (subtitleId) => {
      const all = getSubtitlesForGeneration();
      const sub = all.find((s, idx) => deriveSubtitleId(s, idx) === subtitleId);
      if (!sub) return;
      setRetryingSubtitleId(subtitleId);
      try {
        const resp = await fetch(`${SERVER_URL}/api/narration/camb/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subtitles: [{ ...sub, id: subtitleId }],
            settings: { voice_id: selectedVoice, language: cambLanguage || 'en' },
          }),
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of decoder.decode(value).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.status === 'completed' && data.results?.length) {
                const nr = data.results[0];
                setGenerationResults((prev) => {
                  let found = false;
                  const updated = prev.map((r) => {
                    if (r.subtitle_id === subtitleId) { found = true; return nr; }
                    return r;
                  });
                  return found ? updated : [...updated, nr];
                });
              }
            } catch (_e) { /* noop */ }
          }
        }
      } finally {
        setRetryingSubtitleId(null);
      }
    },
    [getSubtitlesForGeneration, selectedVoice, cambLanguage, setGenerationResults, setRetryingSubtitleId],
  );

  return { handleCambNarration, cancelCambGeneration, handleCambDub, retryCambNarration };
};

export default useCambNarration;
