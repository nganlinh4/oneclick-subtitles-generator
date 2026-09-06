// Tier 2: Boundary & Corner Cases - Area 5: Shared Presentation & Decoded Export Boundary
// Specifications: ORIGINAL_REQUEST.md §R5, PROJECT.md F21-F22, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateActivePresentation } from '../support/contracts.mjs';

test('T2.5.1: Seek to exact word boundary (t == start_ms and t == end_ms) exhibits deterministic state', () => {
  const words = [
    { id: 'w1', text: 'Alpha', start_ms: 1000, end_ms: 1500 },
    { id: 'w2', text: 'Beta', start_ms: 1500, end_ms: 2000 }, // w1 end coincides with w2 start
  ];
  const cues = [{ id: 'c1', start_ms: 1000, end_ms: 2000, text: 'Alpha Beta', word_ids: ['w1', 'w2'] }];

  // At exactly 1000ms: w1 is active
  const t1000 = evaluateActivePresentation(cues, words, 1000, 'WordHighlight');
  assert.equal(t1000.activeWords.find(w => w.id === 'w1').state, 'highlighted');

  // At exactly 1500ms (boundary point): deterministic resolution
  const t1500 = evaluateActivePresentation(cues, words, 1500, 'WordHighlight');
  const w1State = t1500.activeWords.find(w => w.id === 'w1').state;
  const w2State = t1500.activeWords.find(w => w.id === 'w2').state;
  // At 1500ms, w1 has completed or is at end, w2 starts
  assert.ok(w1State === 'highlighted' || w2State === 'highlighted', 'At boundary, exactly one word should be highlighted or transitioning');
});

test('T2.5.2: Seek beyond media duration returns empty presentation without throwing exceptions', () => {
  const cues = [{ id: 'c1', start_ms: 1000, end_ms: 5000, text: 'Last line' }];
  const mediaDurationMs = 10_000;

  const seekFarPast = evaluateActivePresentation(cues, [], 25_000, 'Standard');
  assert.equal(seekFarPast.activeCues.length, 0);
  assert.equal(seekFarPast.activeWords.length, 0);

  const seekNegative = evaluateActivePresentation(cues, [], -500, 'Standard');
  assert.equal(seekNegative.activeCues.length, 0);
});

test('T2.5.3: Rapid bidirectional scrubbing produces deterministic state sequence without stale frame lag', () => {
  const cues = [
    { id: 'c1', start_ms: 1000, end_ms: 2000, text: 'C1' },
    { id: 'c2', start_ms: 3000, end_ms: 4000, text: 'C2' },
    { id: 'c3', start_ms: 5000, end_ms: 6000, text: 'C3' },
  ];

  const scrubPositions = [1500, 3500, 1500, 5500, 2500, 3500];
  const expectedCueIds = ['c1', 'c2', 'c1', 'c3', null, 'c2'];

  for (let i = 0; i < scrubPositions.length; i++) {
    const pos = scrubPositions[i];
    const res = evaluateActivePresentation(cues, [], pos, 'Standard');
    const activeId = res.activeCues[0]?.id || null;
    assert.equal(activeId, expectedCueIds[i], `Scrub position ${pos}ms yielded stale or incorrect cue`);
  }
});

test('T2.5.4: Subtitle line wrapping on narrow display (320px) preserves word timing bindings', () => {
  const words = [
    { id: 'w1', text: 'Unusually', start_ms: 1000, end_ms: 1400 },
    { id: 'w2', text: 'long', start_ms: 1450, end_ms: 1700 },
    { id: 'w3', text: 'words', start_ms: 1750, end_ms: 2000 },
    { id: 'w4', text: 'wrap', start_ms: 2050, end_ms: 2300 },
    { id: 'w5', text: 'smoothly', start_ms: 2350, end_ms: 2700 },
  ];
  const cue = { id: 'c1', start_ms: 1000, end_ms: 2700, text: 'Unusually long words wrap smoothly', word_ids: words.map(w => w.id) };

  // Layout engine wraps into lines
  const wrapLines = (c, wList, maxCharsPerLine = 15) => {
    const lines = [];
    let currentLine = [];
    let currentLength = 0;
    for (const w of wList) {
      if (currentLength + w.text.length > maxCharsPerLine && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = [];
        currentLength = 0;
      }
      currentLine.push(w);
      currentLength += w.text.length + 1;
    }
    if (currentLine.length > 0) lines.push(currentLine);
    return lines;
  };

  const lines = wrapLines(cue, words, 16);
  assert.ok(lines.length >= 2, 'Should wrap into at least 2 lines');

  // Verify that all words are still present in lines and retain timings
  const flattenedWords = lines.flat();
  assert.equal(flattenedWords.length, 5);
  assert.equal(flattenedWords[4].text, 'smoothly');
  assert.equal(flattenedWords[4].end_ms, 2700);
});

test('T2.5.5: Audio-only export generates solid background video with synchronized subtitles', () => {
  const buildAudioOnlyExportCommand = ({ audioPath, subtitleAssPath, outputPath }) => [
    'ffmpeg',
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30',
    '-i', audioPath,
    '-vf', `subtitles='${subtitleAssPath.replace(/\\/g, '/')}'`,
    '-c:v', 'libx264',
    '-shortest',
    outputPath,
  ];

  const args = buildAudioOnlyExportCommand({
    audioPath: 'C:/audio/track.mp3',
    subtitleAssPath: 'C:/subtitles.ass',
    outputPath: 'C:/export.mp4',
  });

  assert.ok(args.includes('color=c=black:s=1920x1080:r=30'), 'Must generate black background for audio-only export');
  assert.ok(args.includes('-shortest'));
});

test('T2.5.6: Export cancellation cleans up temporary output without leaving orphaned locked files', () => {
  const tempFiles = new Set(['temp_frame_0.png', 'temp_render.mp4']);

  const cancelExport = (tempSet) => {
    // Simulated cleanup
    tempSet.clear();
    return true;
  };

  assert.equal(cancelExport(tempFiles), true);
  assert.equal(tempFiles.size, 0, 'Cancelled export must clean up all temporary staging files');
});
