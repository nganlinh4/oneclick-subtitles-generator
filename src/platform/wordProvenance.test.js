import { describe, it, expect } from 'vitest';
import {
  applyWordCorrection,
  splitWordProportionally,
  mergeAdjacentWords,
  nudgeWordTiming,
  WordProvenance,
  AlignmentStatus,
} from './wordProvenance';
import { regroupWordsOffline, regroupPreservingEdits } from './localCaptionRegrouping';

describe('wordProvenance', () => {
  it('preserves raw text and timing on typo edit', () => {
    const orig = { id: 'w1', text: 'teh', start_ms: 1000, end_ms: 1500 };
    const edited = applyWordCorrection(orig, 'the');
    expect(edited.text).toBe('the');
    expect(edited.raw_spelling).toBe('teh');
    expect(edited.start_ms).toBe(1000);
    expect(edited.end_ms).toBe(1500);
    expect(edited.provenance).toBe(WordProvenance.MANUAL);
    expect(edited.alignment_status).toBe(AlignmentStatus.MODIFIED);
    expect(edited.is_unaligned).toBe(false);
  });

  it('splits words proportionally based on character ratio', () => {
    const orig = { id: 'w1', text: 'cannot', start_ms: 1000, end_ms: 1600 };
    // 'can' (3) / 'cannot' (6) -> 50% of 600ms = 300ms -> split at 1300ms
    const [w1, w2] = splitWordProportionally(orig, 3);
    expect(w1.text).toBe('can');
    expect(w1.start_ms).toBe(1000);
    expect(w1.end_ms).toBe(1300);
    expect(w2.text).toBe('not');
    expect(w2.start_ms).toBe(1300);
    expect(w2.end_ms).toBe(1600);
    expect(w1.provenance).toBe(WordProvenance.INTERPOLATED);
    expect(w2.provenance).toBe(WordProvenance.INTERPOLATED);
  });

  it('merges adjacent words into a union interval', () => {
    const w1 = { id: 'w1', text: 'Hello', start_ms: 1000, end_ms: 1300, speaker_id: 's1' };
    const w2 = { id: 'w2', text: 'world', start_ms: 1400, end_ms: 1800, speaker_id: 's1' };
    const merged = mergeAdjacentWords(w1, w2);
    expect(merged.text).toBe('Hello world');
    expect(merged.start_ms).toBe(1000);
    expect(merged.end_ms).toBe(1800);
    expect(merged.provenance).toBe(WordProvenance.INTERPOLATED);
    expect(merged.alignment_status).toBe(AlignmentStatus.MODIFIED);
  });

  it('nudges word timing and tags alignment as Unaligned', () => {
    const orig = { id: 'w1', text: 'Word', start_ms: 1000, end_ms: 1500 };
    const nudged = nudgeWordTiming(orig, -100, 100);
    expect(nudged.start_ms).toBe(900);
    expect(nudged.end_ms).toBe(1600);
    expect(nudged.provenance).toBe(WordProvenance.MANUAL);
    expect(nudged.alignment_status).toBe(AlignmentStatus.UNALIGNED);
    expect(nudged.is_unaligned).toBe(true);
  });

  it('handles camelCase properties seamlessly across provenance operations', () => {
    const orig = { id: 'w1', text: 'sample', startMs: 1200, endMs: 2000, speakerId: 'spk1' };
    const corrected = applyWordCorrection(orig, 'Sample');
    expect(corrected.startMs).toBe(1200);
    expect(corrected.endMs).toBe(2000);
    expect(corrected.start_ms).toBe(1200);
    expect(corrected.end_ms).toBe(2000);
    expect(corrected.alignmentStatus).toBe(AlignmentStatus.MODIFIED);

    const [left, right] = splitWordProportionally(orig, 3);
    expect(left.startMs).toBe(1200);
    expect(right.endMs).toBe(2000);

    const merged = mergeAdjacentWords(left, right);
    expect(merged.startMs).toBe(1200);
    expect(merged.endMs).toBe(2000);
    expect(merged.speakerId).toBe('spk1');
  });

  it('handles float seconds inputs and synchronizes start/end properties', () => {
    const floatWord = { id: 'w1', text: 'float', start: 1.5, end: 2.5 };
    const corrected = applyWordCorrection(floatWord, 'Float');
    expect(corrected.startMs).toBe(1500);
    expect(corrected.endMs).toBe(2500);
    expect(corrected.start).toBe(1.5);
    expect(corrected.end).toBe(2.5);

    const [left, right] = splitWordProportionally(floatWord, 2);
    expect(left.start).toBe(1.5);
    expect(right.end).toBe(2.5);
    expect(left.startMs).toBe(1500);
    expect(right.endMs).toBe(2500);

    const nudged = nudgeWordTiming(floatWord, 100, 200);
    expect(nudged.startMs).toBe(1600);
    expect(nudged.endMs).toBe(2700);
    expect(nudged.start).toBe(1.6);
    expect(nudged.end).toBe(2.7);
  });
});

describe('localCaptionRegrouping', () => {
  const words = [
    { id: 'w1', text: 'Hello', start_ms: 1000, end_ms: 1300 },
    { id: 'w2', text: 'world,', start_ms: 1350, end_ms: 1700 },
    { id: 'w3', text: 'this', start_ms: 1750, end_ms: 2000 },
    { id: 'w4', text: 'is', start_ms: 2050, end_ms: 2200 },
    { id: 'w5', text: 'OSG.', start_ms: 2250, end_ms: 2600 },
  ];

  it('regroups with One word policy', () => {
    const cues = regroupWordsOffline(words, 'One word');
    expect(cues.length).toBe(5);
    expect(cues[0].text).toBe('Hello');
  });

  it('regroups with Short policy', () => {
    const cues = regroupWordsOffline(words, 'Short');
    expect(cues.length).toBeGreaterThanOrEqual(1);
    expect(cues[0].word_ids.length).toBeLessThanOrEqual(5);
  });

  it('regroups preserving manual edits', () => {
    // With Short policy (max 5 words or 2500ms), let's create 8 words across 2 cues
    const eightWords = [
      { id: 'w1', text: 'Hello', start_ms: 1000, end_ms: 1300 },
      { id: 'w2', text: 'world,', start_ms: 1350, end_ms: 1700 },
      { id: 'w3', text: 'this', start_ms: 1750, end_ms: 2000 },
      { id: 'w4', text: 'is', start_ms: 2050, end_ms: 2200 },
      { id: 'w5', text: 'OSG', start_ms: 2250, end_ms: 2600 },
      { id: 'w6', text: 'and', start_ms: 2650, end_ms: 2800 },
      { id: 'w7', text: 'we', start_ms: 2850, end_ms: 3000 },
      { id: 'w8', text: 'code.', start_ms: 3050, end_ms: 3300 },
    ];
    const initialCues = regroupWordsOffline(eightWords, 'Short');
    expect(initialCues.length).toBe(2);
    initialCues[0].userEdited = true;
    initialCues[0].text = 'Custom hello';

    const reflowed = regroupPreservingEdits(eightWords, initialCues, 'One word');
    // First cue is preserved ('Custom hello'), remaining 3 words each become 1 cue -> 1 + 3 = 4 cues
    expect(reflowed.length).toBe(4);
    expect(reflowed[0].text).toBe('Custom hello');
  });
});
