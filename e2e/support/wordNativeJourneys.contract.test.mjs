// Contract test verifying opaque-box compliance for the remaining Word-Native customer journeys.
// Asserts absence of backdoor IPC, absence of API secrets, and presence of evidence recording.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const JOURNEYS = [
  'wordNativeFreshVideoSpeech.journey.js',
  'wordNativeAudioRangeProjection.journey.js',
  'wordNativeCancelRetrySwitch.journey.js',
  'wordNativeTranslationVisualCustom.journey.js',
  'wordNativePreviewDecodedExport.journey.js',
];

test('all word-native customer journeys exist and adhere to opaque-box contracts', () => {
  const journeysDir = join(import.meta.dirname, '..', 'journeys');

  for (const filename of JOURNEYS) {
    const fullPath = join(journeysDir, filename);
    assert.ok(existsSync(fullPath), `Missing journey file: ${filename}`);
    const content = readFileSync(fullPath, 'utf8');

    // 1. Must use public selectors and evidence captures
    assert.match(content, /captureWorkflowStep/u, `${filename} must record workflow screenshot checkpoints`);
    assert.doesNotMatch(content, /captureWorkflowStep\s*\(\s*(?!\{)/u,
      `${filename} must use the current object-shaped evidence API`);

    // 2. Must NOT contain private backdoor invocations or credentials
    assert.doesNotMatch(content, /AIza|__TAURI__|invokeDesktop|invokeCommand/u,
      `${filename} must not contain backdoor IPC or hardcoded credentials`);
    assert.doesNotMatch(content, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM)\b/iu,
      `${filename} must be read-only on database without manual SQL tampering`);
  }
});
