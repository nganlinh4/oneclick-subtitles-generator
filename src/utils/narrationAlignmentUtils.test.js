import {
  buildStrictNativeNarrationPlan,
  createNativeNarrationPlanKey,
  hydrateNarrationResultsForAlignment,
} from './narrationAlignmentUtils';

const ARTIFACT_A = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const ARTIFACT_B = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';

const cue = (overrides = {}) => ({
  id: 1,
  text: 'Current words',
  start: 2.25,
  end: 3.75,
  ...overrides,
});

const result = (overrides = {}) => ({
  subtitle_id: 1,
  text: 'Current words',
  success: true,
  nativeArtifactId: ARTIFACT_A,
  projectId: PROJECT_ID,
  // A generation result may retain old timing. The current cue is the only timing authority.
  start: 90,
  end: 95,
  ...overrides,
});

describe('strict native narration alignment plan', () => {
  it('uses only the exact current cue timing and native artifact capability', () => {
    const plan = buildStrictNativeNarrationPlan([result()], [cue()]);

    expect(plan.items).toEqual([{
      subtitle_id: '1',
      nativeArtifactId: ARTIFACT_A,
      projectId: PROJECT_ID,
      start: 2.25,
      end: 3.75,
      text: 'Current words',
      original_ids: ['1'],
    }]);
    expect(plan.subtitleTimestamps).toEqual({ 1: { start: 2.25, end: 3.75 } });
  });

  it.each([
    ['missing native capability', [result({ nativeArtifactId: undefined, filename: 'subtitle_1/1.wav' })], [cue()], 'narrationArtifactUnavailable'],
    ['missing current timing', [result()], [cue({ end: undefined })], 'narrationCueTimingInvalid'],
    ['stale text', [result({ text: 'Old words' })], [cue()], 'narrationResultStale'],
    ['partial success', [result({ success: false })], [cue()], 'narrationPlanIncomplete'],
    ['duplicate cue ID', [result()], [cue(), cue()], 'narrationCueDuplicate'],
    ['duplicate result ID', [result(), result()], [cue(), cue({ id: 2, text: 'Second' })], 'narrationResultDuplicate'],
    [
      'one artifact reused for two cues',
      [result(), result({ subtitle_id: 2, text: 'Second' })],
      [cue(), cue({ id: 2, text: 'Second' })],
      'narrationArtifactDuplicate',
    ],
  ])('refuses %s', (_label, results, cues, code) => {
    expect(() => buildStrictNativeNarrationPlan(results, cues)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('requires exact, complete grouped lineage on both cue and result', () => {
    const groupedCue = cue({ id: 'group-1', original_ids: [7, 8] });
    const groupedResult = result({
      subtitle_id: 'group-1',
      original_ids: [7],
    });

    expect(() => buildStrictNativeNarrationPlan([groupedResult], [groupedCue])).toThrow(
      expect.objectContaining({ code: 'narrationCueLineageMismatch' }),
    );
    expect(buildStrictNativeNarrationPlan([
      { ...groupedResult, original_ids: [7, 8] },
    ], [groupedCue]).items[0].original_ids).toEqual(['7', '8']);
  });

  it('keys cache identity by artifact, current text, lineage, and exact timing', () => {
    const first = buildStrictNativeNarrationPlan([result()], [cue()]);
    const retimed = buildStrictNativeNarrationPlan([result()], [cue({ start: 2.5 })]);
    const replaced = buildStrictNativeNarrationPlan([
      result({ nativeArtifactId: ARTIFACT_B }),
    ], [cue()]);

    expect(createNativeNarrationPlanKey(retimed)).not.toBe(createNativeNarrationPlanKey(first));
    expect(createNativeNarrationPlanKey(replaced)).not.toBe(createNativeNarrationPlanKey(first));
  });

  it('normalizes native tokens but never invents success, timing, or guessed paths', () => {
    expect(hydrateNarrationResultsForAlignment([{
      subtitle_id: 1,
      filename: `osg-speech-artifact:${ARTIFACT_A}`,
    }])).toEqual([{
      subtitle_id: 1,
      filename: `osg-speech-artifact:${ARTIFACT_A}`,
      nativeArtifactId: ARTIFACT_A,
      audioData: null,
    }]);
    expect(hydrateNarrationResultsForAlignment([{ subtitle_id: 2 }])).toEqual([{ subtitle_id: 2 }]);
  });
});
