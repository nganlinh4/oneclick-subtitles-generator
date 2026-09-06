import { describe, expect, it } from 'vitest';
import {
  joinWordsPreservingSpacing,
  regroupWordsOffline,
  regroupPreservingEdits,
  REGROUPING_POLICIES,
} from './localCaptionRegrouping';

describe('localCaptionRegrouping', () => {
  describe('joinWordsPreservingSpacing', () => {
    it('returns empty string for empty or invalid input', () => {
      expect(joinWordsPreservingSpacing([])).toBe('');
      expect(joinWordsPreservingSpacing(null)).toBe('');
      expect(joinWordsPreservingSpacing(undefined)).toBe('');
    });

    it('joins standard Latin words with single spaces', () => {
      const words = [
        { text: 'The' },
        { text: 'quick' },
        { text: 'brown' },
        { text: 'fox' },
      ];
      expect(joinWordsPreservingSpacing(words)).toBe('The quick brown fox');
    });

    it('attaches standard punctuation without prepending a space', () => {
      const words = [
        { text: 'Hello' },
        { text: ',' },
        { text: 'world' },
        { text: '!' },
      ];
      expect(joinWordsPreservingSpacing(words)).toBe('Hello, world!');
    });

    it('attaches apostrophes and closing quotes without prepending a space', () => {
      const words = [
        { text: 'don' },
        { text: "'t" },
        { text: 'worry' },
      ];
      expect(joinWordsPreservingSpacing(words)).toBe("don't worry");
    });

    it('preserves CJK character adjacency without inserting spaces', () => {
      const cjkWords = [
        { text: '中' },
        { text: '文' },
        { text: '字' },
        { text: '幕' },
      ];
      expect(joinWordsPreservingSpacing(cjkWords)).toBe('中文字幕');

      const jpWords = [
        { text: 'す' },
        { text: 'し' },
      ];
      expect(joinWordsPreservingSpacing(jpWords)).toBe('すし');
    });

    it('preserves spacing between Latin words and CJK tokens', () => {
      const words = [
        { text: 'OneClick' },
        { text: '字幕' },
      ];
      expect(joinWordsPreservingSpacing(words)).toBe('OneClick 字幕');
    });

    it('attaches CJK fullwidth punctuation without inserting spaces', () => {
      const words = [
        { text: '你好' },
        { text: '，' },
        { text: '世界' },
        { text: '！' },
      ];
      expect(joinWordsPreservingSpacing(words)).toBe('你好，世界！');
    });
  });

  describe('regroupWordsOffline', () => {
    const sampleWords = [
      { id: 'w1', text: 'First', start_ms: 100, end_ms: 500, speaker_id: 'spk0' },
      { id: 'w2', text: 'second', start_ms: 550, end_ms: 900, speaker_id: 'spk0' },
      { id: 'w3', text: 'third.', start_ms: 950, end_ms: 1400, speaker_id: 'spk0' },
      { id: 'w4', text: 'Fourth', start_ms: 2200, end_ms: 2800, speaker_id: 'spk1' },
    ];

    it('regroups in One word policy with exact word boundaries and no padding', () => {
      const cues = regroupWordsOffline(sampleWords, REGROUPING_POLICIES.ONE_WORD);
      expect(cues).toHaveLength(4);
      expect(cues[0]).toMatchObject({
        id: 'cue_1',
        ordinal: 1,
        start_ms: 100,
        end_ms: 500,
        start: 0.1,
        end: 0.5,
        text: 'First',
        word_ids: ['w1'],
        speaker_id: 'spk0',
        is_unaligned: false,
        manual_state: 'clean',
      });
      expect(cues[0].end_ms - cues[0].start_ms).toBe(400); // exactly matches source word duration without arbitrary padding
      expect(cues[0].start).toBe(0.1);
      expect(cues[0].end).toBe(0.5);
    });

    it('regroups in Short policy respecting maximum word count and duration', () => {
      const cues = regroupWordsOffline(sampleWords, REGROUPING_POLICIES.SHORT);
      expect(cues.length).toBeGreaterThan(0);
      cues.forEach((cue) => {
        expect(cue.end_ms - cue.start_ms).toBeLessThanOrEqual(2500);
        expect(cue.word_ids.length).toBeLessThanOrEqual(5);
        expect(cue.start).toBe(cue.start_ms / 1000);
        expect(cue.end).toBe(cue.end_ms / 1000);
      });
    });

    it('regroups in Natural policy breaking on punctuation and pause threshold', () => {
      const cues = regroupWordsOffline(sampleWords, REGROUPING_POLICIES.NATURAL);
      // w1-w3 end with '.' and have pause > 300ms before w4 (2200 - 1400 = 800ms)
      expect(cues).toHaveLength(2);
      expect(cues[0].text).toBe('First second third.');
      expect(cues[0].word_ids).toEqual(['w1', 'w2', 'w3']);
      expect(cues[0].start).toBe(0.1);
      expect(cues[0].end).toBe(1.4);
      expect(cues[1].text).toBe('Fourth');
      expect(cues[1].word_ids).toEqual(['w4']);
      expect(cues[1].start).toBe(2.2);
      expect(cues[1].end).toBe(2.8);
    });

    it('regroups camelCase word inputs directly from transcriptStore / Rust TimedWordDto', () => {
      const camelWords = [
        { id: 'w1', text: 'Hello', startMs: 1000, endMs: 1500, speakerId: 'spk_1' },
        { id: 'w2', text: 'world.', startMs: 1600, endMs: 2200, speakerId: 'spk_1' },
      ];
      const cues = regroupWordsOffline(camelWords, REGROUPING_POLICIES.NATURAL);
      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe('Hello world.');
      expect(cues[0].start).toBe(1.0);
      expect(cues[0].end).toBe(2.2);
      expect(cues[0].startMs).toBe(1000);
      expect(cues[0].endMs).toBe(2200);
      expect(cues[0].wordIds).toEqual(['w1', 'w2']);
    });

    it('preserves manual edits when using regroupPreservingEdits', () => {
      const existingCues = [
        {
          id: 'cue_1',
          start: 0.1,
          end: 1.4,
          text: 'User custom text',
          manual_state: 'edited_text',
          userEdited: true,
          word_ids: ['w1', 'w2', 'w3'],
        },
        {
          id: 'cue_2',
          start: 2.2,
          end: 2.8,
          text: 'Fourth',
          manual_state: 'clean',
          word_ids: ['w4'],
        },
      ];

      const regroupped = regroupPreservingEdits(sampleWords, existingCues, REGROUPING_POLICIES.ONE_WORD);
      // The manually edited cue should be preserved
      const edited = regroupped.find((c) => c.text === 'User custom text');
      expect(edited).toBeDefined();
      expect(edited.manual_state).toBe('edited_text');
      expect(edited.start).toBe(0.1);
      expect(edited.end).toBe(1.4);
    });

    it('robustly sorts and groups out-of-order words chronologically', () => {
      const outOfOrderWords = [
        { id: 'w3', text: 'third.', startMs: 1600, endMs: 2200 },
        { id: 'w1', text: 'First', startMs: 500, endMs: 900 },
        { id: 'w2', text: 'second', startMs: 1000, endMs: 1500 },
      ];
      const cues = regroupWordsOffline(outOfOrderWords, REGROUPING_POLICIES.NATURAL);
      expect(cues).toHaveLength(1);
      expect(cues[0].text).toBe('First second third.');
      expect(cues[0].startMs).toBe(500);
      expect(cues[0].endMs).toBe(2200);
      expect(cues[0].wordIds).toEqual(['w1', 'w2', 'w3']);
    });

    it('handles overlapping word boundaries using min start and max end', () => {
      const overlapping = [
        { id: 'w1', text: 'Overlapping', startMs: 1000, endMs: 2200 },
        { id: 'w2', text: 'speech', startMs: 1500, endMs: 2000 },
      ];
      const cues = regroupWordsOffline(overlapping, REGROUPING_POLICIES.NATURAL);
      expect(cues).toHaveLength(1);
      expect(cues[0].startMs).toBe(1000);
      expect(cues[0].endMs).toBe(2200);
      expect(cues[0].start).toBe(1.0);
      expect(cues[0].end).toBe(2.2);
    });

    it('preserves spacing without doubling spaces for empty words or pre-spaced tokens', () => {
      const tokens = [
        { id: 'w1', text: 'Hello', startMs: 1000, endMs: 1500 },
        { id: 'w2', text: '', startMs: 1500, endMs: 1550 },
        { id: 'w3', text: ' world', startMs: 1600, endMs: 2000 },
        { id: 'w4', text: '!', startMs: 2000, endMs: 2200 },
      ];
      const cues = regroupWordsOffline(tokens, REGROUPING_POLICIES.NATURAL);
      expect(cues[0].text).toBe('Hello world!');
    });

    it('correctly formats Korean text with word spaces and attached punctuation', () => {
      const koreanWords = [
        { id: 'k1', text: '안녕하세요', startMs: 1000, endMs: 1800 },
        { id: 'k2', text: '여러분', startMs: 1900, endMs: 2500 },
        { id: 'k3', text: '!', startMs: 2500, endMs: 2700 },
      ];
      const cues = regroupWordsOffline(koreanWords, REGROUPING_POLICIES.NATURAL);
      expect(cues[0].text).toBe('안녕하세요 여러분!');
    });
  });
});
