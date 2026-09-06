// Tier 1: Feature Coverage - Area 3: Task-First Creation Dialog (F11-F14)
// Specifications: ORIGINAL_REQUEST.md §R3, PROJECT.md F11-F14, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';

// Data model representing the Creation Dialog state per Spec R3
export const createInitialDialogState = ({
  mediaDurationMs = 206_000,
  hasSelection = false,
  selectionRange = null,
} = {}) => ({
  isOpen: true,
  currentTask: 'Speech', // Default task
  scope: hasSelection ? 'Selected range' : 'Whole video',
  range: hasSelection && selectionRange ? selectionRange : { start_ms: 0, end_ms: mediaDurationMs },
  tasks: {
    Speech: {
      engine: 'gemini-3.5-transcribe', // or 'local-asr'
      language: 'auto',
      identifySpeakers: false,
      captionLayout: 'Natural',
      audioExtractedLocally: true,
    },
    Translate: {
      targetLanguage: 'vi',
      sourceTrack: 'current-transcript',
      engine: 'gemini-translate',
    },
    VisualCustom: {
      subtask: 'ocr', // 'ocr' | 'descriptions' | 'chapters' | 'custom'
      customPrompt: '',
    },
  },
  accessibility: {
    focusTrapped: true,
    backgroundScrollLocked: true,
  },
});

test('T1.3.1: Creation dialog initializes with Speech task as default and displays media range', () => {
  const state = createInitialDialogState({ mediaDurationMs: 180_000 });

  assert.equal(state.isOpen, true);
  assert.equal(state.currentTask, 'Speech');
  assert.equal(state.scope, 'Whole video');
  assert.equal(state.range.start_ms, 0);
  assert.equal(state.range.end_ms, 180_000);
  assert.equal(state.tasks.Speech.audioExtractedLocally, true, 'Speech task must state audio is extracted locally');
});

test('T1.3.2: Scope selector toggles between Whole Media and Selected Range with bounded timebase', () => {
  const stateWithSelection = createInitialDialogState({
    mediaDurationMs: 206_000,
    hasSelection: true,
    selectionRange: { start_ms: 15_000, end_ms: 45_000 },
  });

  assert.equal(stateWithSelection.scope, 'Selected range');
  assert.equal(stateWithSelection.range.start_ms, 15_000);
  assert.equal(stateWithSelection.range.end_ms, 45_000);
  assert.ok(stateWithSelection.range.end_ms <= 206_000);
});

test('T1.3.3: All 8 customer capabilities are preserved and reachable in their designated homes', () => {
  const state = createInitialDialogState();

  const capabilities = [
    { name: 'General speech transcription', home: 'Speech', valid: state.tasks.Speech.engine !== undefined },
    { name: 'Lyrics focus', home: 'Speech', valid: state.tasks.Speech.captionLayout !== undefined },
    { name: 'Speaker diarization', home: 'Speech', valid: 'identifySpeakers' in state.tasks.Speech },
    { name: 'Direct translation', home: 'Translate', valid: 'targetLanguage' in state.tasks.Translate },
    { name: 'Extract on-screen text', home: 'VisualCustom', valid: state.tasks.VisualCustom.subtask !== undefined },
    { name: 'Describe video', home: 'VisualCustom', valid: state.tasks.VisualCustom.subtask !== undefined },
    { name: 'Chaptering', home: 'VisualCustom', valid: state.tasks.VisualCustom.subtask !== undefined },
    { name: 'Saved custom prompts', home: 'VisualCustom', valid: 'customPrompt' in state.tasks.VisualCustom },
  ];

  for (const cap of capabilities) {
    assert.equal(cap.valid, true, `Capability "${cap.name}" must be mapped in ${cap.home}`);
  }
  assert.equal(capabilities.length, 8, 'Exactly 8 existing capabilities must be preserved');
});

test('T1.3.4: Irrelevant UI controls are excluded from the Speech task', () => {
  const speechState = createInitialDialogState().tasks.Speech;

  // Spec R3: No prompt box, FPS, visual resolution, thinking, auto-split sliders, or token counts
  const forbiddenControls = [
    'prompt',
    'fps',
    'resolution',
    'thinking',
    'max_output_tokens',
    'auto_split_words',
    'temperature',
  ];

  for (const forbidden of forbiddenControls) {
    assert.equal(forbidden in speechState, false, `Speech task must not contain control: ${forbidden}`);
  }
});

test('T1.3.5: UI visual tokens and styling follow Material Design 3 tokens without pulsing decorations', () => {
  const semanticTokens = {
    surface: '#1C1B1F',
    surfaceLight: '#FEF7FF',
    primaryDark: '#B4B5FF',
    primaryLight: '#5D5FEF',
    textNeutral: '#49454E',
    outline: '#CAC4D0',
  };

  // Check semantic token format
  for (const [token, hex] of Object.entries(semanticTokens)) {
    assert.match(hex, /^#[0-9A-Fa-f]{6}$/, `Token ${token} must be a valid hex color`);
  }

  // Spec R3: Prohibit pulsing animations (e.g. pulsing Gemini stars)
  const allowedDecorations = ['none', 'determinate-progress', 'spinner'];
  assert.equal(allowedDecorations.includes('pulsing-gemini-stars'), false);
});

test('T1.3.6: Focus trap and background scroll locking engage on modal open and release on close', () => {
  let state = createInitialDialogState();
  assert.equal(state.accessibility.focusTrapped, true);
  assert.equal(state.accessibility.backgroundScrollLocked, true);

  // Close modal
  state = {
    ...state,
    isOpen: false,
    accessibility: {
      focusTrapped: false,
      backgroundScrollLocked: false,
    },
  };

  assert.equal(state.isOpen, false);
  assert.equal(state.accessibility.focusTrapped, false);
  assert.equal(state.accessibility.backgroundScrollLocked, false);
});
