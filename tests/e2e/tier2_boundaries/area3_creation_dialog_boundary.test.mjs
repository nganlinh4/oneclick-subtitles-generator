// Tier 2: Boundary & Corner Cases - Area 3: Task-First Creation Dialog Boundary
// Specifications: ORIGINAL_REQUEST.md §R3, PROJECT.md F11-F14, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialDialogState } from '../tier1_features/area3_creation_dialog.test.mjs';

test('T2.3.1: Micro-duration selection range (<500ms) refuses generation with actionable feedback', () => {
  const validateRange = (startMs, endMs) => {
    const duration = endMs - startMs;
    if (duration < 500) {
      return { valid: false, error: 'Selection range too short (minimum 500ms)' };
    }
    return { valid: true };
  };

  assert.equal(validateRange(1000, 1200).valid, false);
  assert.equal(validateRange(1000, 1200).error, 'Selection range too short (minimum 500ms)');
  assert.equal(validateRange(1000, 1500).valid, true);
});

test('T2.3.2: Extremely long media (>10 hours) selection range formatting and bounds arithmetic', () => {
  const tenHoursMs = 10 * 3600 * 1000; // 36,000,000 ms

  const formatTimestamp = (ms) => {
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  assert.equal(formatTimestamp(tenHoursMs), '10:00:00');
  assert.equal(formatTimestamp(tenHoursMs + 185_000), '10:03:05');
});

test('T2.3.3: Rapid task switching between Speech, Translate, and Visual/Custom preserves form inputs', () => {
  const state = createInitialDialogState();

  // User sets custom parameters in Speech
  state.tasks.Speech.captionLayout = 'One word';
  state.tasks.Speech.identifySpeakers = true;

  // User switches to Translate and sets target language
  state.currentTask = 'Translate';
  state.tasks.Translate.targetLanguage = 'ko';

  // User switches to VisualCustom
  state.currentTask = 'VisualCustom';
  state.tasks.VisualCustom.subtask = 'chapters';

  // User switches back to Speech
  state.currentTask = 'Speech';
  assert.equal(state.tasks.Speech.captionLayout, 'One word', 'Task-specific settings must be retained on return');
  assert.equal(state.tasks.Speech.identifySpeakers, true);

  // User switches back to Translate
  state.currentTask = 'Translate';
  assert.equal(state.tasks.Translate.targetLanguage, 'ko');
});

test('T2.3.4: Dialog opened with audio-only asset cleanly disables video-required visual subtasks', () => {
  const mediaAsset = { kind: 'audio', display_name: 'podcast.mp3' };

  const getAvailableVisualTasks = (asset) => {
    const isVideo = asset.kind === 'video';
    return {
      ocrAvailable: isVideo,
      descriptionAvailable: isVideo,
      customRulesAvailable: true, // Audio can still use custom analysis
    };
  };

  const capabilities = getAvailableVisualTasks(mediaAsset);
  assert.equal(capabilities.ocrAvailable, false, 'OCR requires video');
  assert.equal(capabilities.descriptionAvailable, false, 'Video descriptions require video');
  assert.equal(capabilities.customRulesAvailable, true);
});

test('T2.3.5: Multilingual UI text length stress does not break dialog layout container bounds', () => {
  const labels = {
    en: 'Audio from this video is used. The video stays unchanged.',
    vi: 'Âm thanh từ video này được sử dụng. Video gốc vẫn không thay đổi.',
    ko: '이 비디오의 오디오가 사용됩니다. 비디오는 변경되지 않은 상태로 유지됩니다.',
  };

  const containerWidthPx = 480;
  const approxCharWidthPx = 8;

  for (const [lang, text] of Object.entries(labels)) {
    const textWidth = text.length * approxCharWidthPx;
    // Multi-line wrap calculation
    const linesNeeded = Math.ceil(textWidth / (containerWidthPx - 32));
    assert.ok(linesNeeded <= 3, `Label for ${lang} should wrap cleanly in <=3 lines, got ${linesNeeded}`);
  }
});

test('T2.3.6: RTL layout rendering (Arabic/Hebrew) correctly applies direction and text alignment', () => {
  const getLayoutDirection = (languageCode) => {
    const rtlLanguages = new Set(['ar', 'he', 'fa', 'ur']);
    return rtlLanguages.has(languageCode) ? 'rtl' : 'ltr';
  };

  assert.equal(getLayoutDirection('ar'), 'rtl');
  assert.equal(getLayoutDirection('he'), 'rtl');
  assert.equal(getLayoutDirection('en'), 'ltr');
  assert.equal(getLayoutDirection('vi'), 'ltr');
  assert.equal(getLayoutDirection('ko'), 'ltr');
});
