import { createProjectAuxiliaryStore } from './projectAuxiliaryStore';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000301';
const SETTING_KEY = `project.legacyAux.v1.${PROJECT_ID}`;

const createHarness = () => {
  const settings = new Map();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'setting_get') return settings.get(args.key) ?? null;
    if (command === 'setting_set') {
      settings.set(args.key, args.value);
      return undefined;
    }
    if (command === 'setting_delete') return settings.delete(args.key);
    throw new Error(`Unexpected command: ${command}`);
  });
  const resolveProject = vi.fn().mockResolvedValue({
    cacheId: 'cache-id',
    projectId: PROJECT_ID,
    snapshot: null,
  });
  return {
    invokeCommand,
    resolveProject,
    settings,
    store: createProjectAuxiliaryStore({ invokeCommand, resolveProject }),
  };
};

it('persists raw subtitle input and structured rules without placing them in cue text', async () => {
  const { store, settings, resolveProject } = createHarness();
  const rules = { terminology: [{ term: 'OSG', definition: 'Application name' }] };

  await store.patch('cache-id', { userSubtitles: 'untimed\nreference text' });
  await store.patch('cache-id', { transcriptionRules: rules });

  expect(settings.get(SETTING_KEY)).toEqual({
    schemaVersion: 1,
    userSubtitles: 'untimed\nreference text',
    transcriptionRules: rules,
    translation: null,
    analysis: null,
    grouping: null,
    languageDetections: { original: null, translated: null },
  });
  await expect(store.read('cache-id')).resolves.toEqual(settings.get(SETTING_KEY));
  expect(resolveProject).toHaveBeenCalledWith('cache-id', { create: true });
  expect(resolveProject).toHaveBeenCalledWith('cache-id', { create: false });
});

it('serializes patches so concurrent field updates cannot overwrite each other', async () => {
  const { store, settings } = createHarness();

  await Promise.all([
    store.patch('cache-id', { userSubtitles: 'reference' }),
    store.patch('cache-id', { transcriptionRules: { atmosphere: 'quiet' } }),
  ]);

  expect(settings.get(SETTING_KEY)).toMatchObject({
    userSubtitles: 'reference',
    transcriptionRules: { atmosphere: 'quiet' },
  });
});

it('persists only an exact project-bound accepted analysis record', async () => {
  const { store, settings } = createHarness();
  const analysis = {
    schemaVersion: 1,
    sourceIdentity: 'asset:01890f39-7b62-7c4e-8c9a-000000000301',
    providerJobId: '01890f39-7b62-7c4e-8c9a-000000000311',
    deliveryId: '01890f39-7b62-7c4e-8c9a-000000000312',
    recommendedPresetId: 'general',
    transcriptionRules: { terminology: [] },
  };

  await store.patch('cache-id', { analysis });
  expect(settings.get(SETTING_KEY).analysis).toEqual(analysis);

  await expect(store.patch('cache-id', {
    analysis: { ...analysis, deliveryId: 'not-a-delivery' },
  })).rejects.toMatchObject({ code: 'invalidProjectAuxiliaryData' });
  expect(settings.get(SETTING_KEY).analysis).toEqual(analysis);
});

it('persists only a strict project-owned subtitle grouping partition', async () => {
  const { store, settings } = createHarness();
  const grouping = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    projectStateVersion: 7,
    sourceType: 'original',
    sourceFingerprint: 'a'.repeat(64),
    intensity: 'moderate',
    providerJobId: '01890f39-7b62-7c4e-8c9a-000000000321',
    deliveryId: '01890f39-7b62-7c4e-8c9a-000000000322',
    groupedRows: [{
      subtitle_id: 1,
      id: 1,
      start: 0,
      end: 2,
      text: 'Exact source',
      original_ids: ['one', 'two'],
      source_positions: [1, 2],
    }],
  };

  await store.patch('cache-id', { grouping });
  expect(settings.get(SETTING_KEY).grouping).toEqual(grouping);

  await expect(store.patch('cache-id', {
    grouping: {
      ...grouping,
      groupedRows: [{ ...grouping.groupedRows[0], source_positions: [1, 3] }],
    },
  })).rejects.toMatchObject({ code: 'invalidProjectAuxiliaryData' });
  expect(settings.get(SETTING_KEY).grouping).toEqual(grouping);
});

it('persists only exact and internally consistent project language detections', async () => {
  const { store, settings } = createHarness();
  const original = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    projectStateVersion: 7,
    sourceType: 'original',
    sourceFingerprint: 'a'.repeat(64),
    providerJobId: '01890f39-7b62-7c4e-8c9a-000000000321',
    deliveryId: '01890f39-7b62-7c4e-8c9a-000000000322',
    result: {
      languageCode: 'en',
      languageName: 'English',
      isMultiLanguage: true,
      secondaryLanguages: ['vi'],
    },
  };

  await store.patch('cache-id', {
    languageDetections: { original, translated: null },
  });
  expect(settings.get(SETTING_KEY).languageDetections.original).toEqual(original);

  await expect(store.patch('cache-id', {
    languageDetections: {
      original: {
        ...original,
        result: { ...original.result, secondaryLanguages: [] },
      },
      translated: null,
    },
  })).rejects.toMatchObject({ code: 'invalidProjectAuxiliaryData' });
  expect(settings.get(SETTING_KEY).languageDetections.original).toEqual(original);
});

it('checks the captured project inside the queued write that selects the native key', async () => {
  const { store, invokeCommand, resolveProject } = createHarness();

  await expect(store.patch(
    'cache-id',
    { transcriptionRules: { atmosphere: 'stale' } },
    { expectedProjectId: '01890f39-7b62-7c4e-8c9a-000000000999' }
  )).rejects.toMatchObject({ code: 'projectScopeMismatch' });

  expect(invokeCommand).not.toHaveBeenCalled();
  expect(resolveProject).toHaveBeenCalledWith('cache-id', { create: false });
});

it('deletes the native auxiliary setting after both fields are cleared', async () => {
  const { store, settings, invokeCommand } = createHarness();
  await store.patch('cache-id', {
    userSubtitles: 'reference',
    transcriptionRules: { atmosphere: 'quiet' },
  });

  await store.patch('cache-id', { userSubtitles: null });
  expect(settings.has(SETTING_KEY)).toBe(true);
  await store.patch('cache-id', { transcriptionRules: null });

  expect(settings.has(SETTING_KEY)).toBe(false);
  expect(invokeCommand).toHaveBeenCalledWith('setting_delete', { key: SETTING_KEY });
});

it('rejects cyclic or oversized auxiliary data before invoking native persistence', async () => {
  const { store, invokeCommand } = createHarness();
  const cyclic = {};
  cyclic.self = cyclic;

  await expect(store.patch('cache-id', { transcriptionRules: cyclic })).rejects.toMatchObject({
    code: 'invalidProjectAuxiliaryData',
  });
  await expect(store.patch('cache-id', { userSubtitles: 'x'.repeat(950 * 1024) })).rejects.toMatchObject({
    code: 'projectAuxiliaryTooLarge',
  });
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'setting_set')).toHaveLength(0);
});
