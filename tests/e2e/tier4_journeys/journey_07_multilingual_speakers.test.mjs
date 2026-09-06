// Tier 4: Real-World Scenario - Journey 7: Multilingual and speaker tests (Korean/CJK, RTL, repeated words, live diarization namespaces)
// Specifications: WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (Journey 7), TEST_INFRA.md, PROJECT.md F05, F09, F14, F16

import test from 'node:test';
import assert from 'node:assert/strict';
import { namespaceSpeaker, regroupWordsOffline } from '../support/contracts.mjs';

test('Journey 7: Multilingual and speaker tests (Korean/CJK, RTL, repeated words, live diarization namespaces)', () => {
  // 1. Korean/CJK text with native spacing preserved (fleurs-ko-1883 fixture)
  const koreanWords = [
    { id: 'ko1', text: '인공지능', start_ms: 500, end_ms: 1200, speaker_id: namespaceSpeaker(0, '1') },
    { id: 'ko2', text: '연구는', start_ms: 1250, end_ms: 1800, speaker_id: namespaceSpeaker(0, '1') },
    { id: 'ko3', text: '기계가', start_ms: 1850, end_ms: 2400, speaker_id: namespaceSpeaker(0, '2') },
    { id: 'ko4', text: '스마트한', start_ms: 2450, end_ms: 3100, speaker_id: namespaceSpeaker(0, '2') },
  ];

  // Invariant: Korean words preserve spaces between tokens without artificial glued strings
  const koreanCues = regroupWordsOffline(koreanWords, 'Natural');
  assert.equal(koreanCues[0].text, '인공지능 연구는 기계가 스마트한');

  // 2. Arabic / RTL text with directional tagging
  const arabicWords = [
    { id: 'ar1', text: 'البحث', start_ms: 1000, end_ms: 1500, speaker_id: namespaceSpeaker(0, '1') },
    { id: 'ar2', text: 'العلمي', start_ms: 1550, end_ms: 2100, speaker_id: namespaceSpeaker(0, '1') },
  ];
  const arabicCues = regroupWordsOffline(arabicWords, 'Natural');
  assert.equal(arabicCues[0].text, 'البحث العلمي');

  // 3. Repeated consecutive words (e.g. "no no no" or "the the")
  const repeatedWords = [
    { id: 'rep1', text: 'no', start_ms: 500, end_ms: 800 },
    { id: 'rep2', text: 'no', start_ms: 850, end_ms: 1100 },
    { id: 'rep3', text: 'no', start_ms: 1150, end_ms: 1400 },
  ];
  const repeatedCues = regroupWordsOffline(repeatedWords, 'Natural');
  assert.equal(repeatedCues[0].text, 'no no no', 'Repeated consecutive words must not be deduplicated or dropped');

  // 4. Diarization cross-window speaker isolation
  const speakerWin0 = namespaceSpeaker(0, 'Speaker 1');
  const speakerWin1 = namespaceSpeaker(1, 'Speaker 1');

  assert.equal(speakerWin0, 'w0:Speaker 1');
  assert.equal(speakerWin1, 'w1:Speaker 1');
  assert.notEqual(speakerWin0, speakerWin1, 'Cross-window speaker labels must not be collapsed into identical identities');
});
