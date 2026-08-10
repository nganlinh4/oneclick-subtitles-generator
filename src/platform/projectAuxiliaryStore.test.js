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
