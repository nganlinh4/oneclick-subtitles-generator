import { createProjectSubtitleLanguageStore } from './projectSubtitleLanguageStore';

const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000601';
const JOB_ID = '01890f39-7b62-7c4e-8c9a-000000000602';
const DELIVERY_ID = '01890f39-7b62-7c4e-8c9a-000000000603';
const rows = [
  { id: 'a', start: 0, end: 1, text: 'Hello' },
  { id: 'b', start: 1, end: 2, text: 'world' },
];
const result = Object.freeze({
  languageCode: 'en',
  languageName: 'English',
  isMultiLanguage: false,
  secondaryLanguages: [],
});

const harness = () => {
  let active = { metadata: { id: PROJECT_ID }, stateVersion: 3 };
  let auxiliary = {
    translation: null,
    languageDetections: { original: null, translated: null },
  };
  const dependencies = {
    getCacheId: vi.fn(() => 'cache-1'),
    getActiveSnapshot: vi.fn(() => active),
    resolveProject: vi.fn(async () => ({ projectId: PROJECT_ID })),
    loadOriginalRows: vi.fn(async () => rows),
    readAuxiliary: vi.fn(async () => structuredClone(auxiliary)),
    patchAuxiliary: vi.fn(async (_cacheId, changes) => {
      auxiliary = { ...auxiliary, ...structuredClone(changes) };
      return structuredClone(auxiliary);
    }),
    claimDelivery: vi.fn(async () => null),
    acknowledgeDelivery: vi.fn(async () => true),
  };
  return {
    dependencies,
    store: createProjectSubtitleLanguageStore(dependencies),
    setActive: (value) => { active = value; },
    getAuxiliary: () => auxiliary,
  };
};

const provider = (overrides = {}) => ({
  result,
  job: { id: JOB_ID },
  deliveryId: DELIVERY_ID,
  acknowledge: vi.fn(async () => undefined),
  ...overrides,
});

test('persists and rereads the exact project result before acknowledging it', async () => {
  const { store, dependencies, getAuxiliary } = harness();
  const context = await store.capture({ sourceType: 'original', subtitles: rows });
  const delivery = provider();
  const receipt = await store.persist(context, delivery);

  expect(delivery.acknowledge).not.toHaveBeenCalled();
  expect(getAuxiliary().languageDetections.original).toMatchObject({
    projectId: PROJECT_ID,
    projectStateVersion: 3,
    providerJobId: JOB_ID,
    deliveryId: DELIVERY_ID,
    result,
  });

  await expect(store.acknowledge(receipt)).resolves.toMatchObject({ result });
  expect(dependencies.patchAuxiliary).toHaveBeenCalledBefore(delivery.acknowledge);
  expect(delivery.acknowledge).toHaveBeenCalledTimes(1);
});

test('a project switch before persistence leaves the delivery pending', async () => {
  const { store, setActive, dependencies } = harness();
  const context = await store.capture({ sourceType: 'original', subtitles: rows });
  const delivery = provider();
  setActive({ metadata: { id: '01890f39-7b62-7c4e-8c9a-000000000699' }, stateVersion: 0 });

  await expect(store.persist(context, delivery)).rejects.toMatchObject({
    code: 'subtitleLanguageProjectChanged',
  });
  expect(dependencies.patchAuxiliary).not.toHaveBeenCalled();
  expect(delivery.acknowledge).not.toHaveBeenCalled();
});

test('an acknowledgement failure does not erase the durable project result', async () => {
  const { store, getAuxiliary } = harness();
  const context = await store.capture({ sourceType: 'original', subtitles: rows });
  const delivery = provider({ acknowledge: vi.fn(async () => { throw new Error('offline'); }) });
  const receipt = await store.persist(context, delivery);

  await expect(store.acknowledge(receipt)).rejects.toThrow('offline');
  expect(getAuxiliary().languageDetections.original?.deliveryId).toBe(DELIVERY_ID);
});

test('relaunch claims and acknowledges the exact saved delivery without provider work', async () => {
  const first = harness();
  const context = await first.store.capture({ sourceType: 'original', subtitles: rows });
  await first.store.persist(context, provider());
  const saved = structuredClone(first.getAuxiliary());

  const second = harness();
  second.dependencies.readAuxiliary.mockImplementation(async () => structuredClone(saved));
  second.dependencies.claimDelivery.mockResolvedValue({
    job: { id: JOB_ID },
    delivery: {
      jobId: JOB_ID,
      deliveryId: DELIVERY_ID,
      projectId: PROJECT_ID,
    },
  });

  await expect(second.store.load({ sourceType: 'original', subtitles: rows }))
    .resolves.toMatchObject({ result });
  expect(second.dependencies.acknowledgeDelivery)
    .toHaveBeenCalledExactlyOnceWith(JOB_ID, DELIVERY_ID);
});

test.each([
  [{ ...result, languageCode: 'english' }],
  [{ ...result, languageName: '' }],
  [{ ...result, isMultiLanguage: true }],
  [{ ...result, secondaryLanguages: ['en'] }],
  [{ ...result, extra: true }],
])('rejects inconsistent or non-exact provider language data: %j', async (badResult) => {
  const { store } = harness();
  const context = await store.capture({ sourceType: 'original', subtitles: rows });
  const delivery = provider({ result: badResult });

  await expect(store.persist(context, delivery)).rejects.toMatchObject({
    code: 'invalidSubtitleLanguageResult',
  });
  expect(delivery.acknowledge).not.toHaveBeenCalled();
});
