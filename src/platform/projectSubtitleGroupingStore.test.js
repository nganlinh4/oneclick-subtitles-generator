import { createGroupedSubtitles } from '../services/gemini/subtitleGroupingService';
import { createProjectSubtitleGroupingStore } from './projectSubtitleGroupingStore';

vi.mock('./projectService', async (importOriginal) => ({
  ...(await importOriginal()),
  getActiveProjectSnapshot: vi.fn(),
}));
vi.mock('./subtitleProjectStore', () => ({
  loadExactProjectSubtitles: vi.fn(),
  resolveProjectForCache: vi.fn(),
}));
vi.mock('./projectAuxiliaryStore', () => ({
  patchProjectAuxiliary: vi.fn(),
  readProjectAuxiliary: vi.fn(),
}));
vi.mock('../utils/userSubtitlesStore', () => ({ getCurrentCacheId: vi.fn() }));
vi.mock('./jobResultDeliveryService', () => ({
  acknowledgeJobResult: vi.fn(),
  claimJobResult: vi.fn(),
}));

const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000501';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000502';
const JOB_ID = '01890f39-7b62-7c4e-8c9a-000000000511';
const DELIVERY_ID = '01890f39-7b62-7c4e-8c9a-000000000512';
const SOURCE = [
  { id: 'one', start: 0, end: 1, text: 'First part' },
  { id: 'two', start: 1, end: 2, text: 'second part.' },
  { id: 'three', start: 3, end: 4, text: 'Third.' },
];

const createHarness = () => {
  let cacheId = 'cache-a';
  let active = { metadata: { id: PROJECT_A }, stateVersion: 3 };
  let auxiliary = { translation: null, grouping: null };
  const events = [];
  const resolveProject = vi.fn(async (requested) => ({
    cacheId: requested,
    projectId: requested === 'cache-a' ? PROJECT_A : PROJECT_B,
  }));
  const loadOriginalRows = vi.fn(async () => SOURCE);
  const readAuxiliary = vi.fn(async () => structuredClone(auxiliary));
  const patchAuxiliary = vi.fn(async (_cache, changes) => {
    events.push('persist');
    auxiliary = { ...auxiliary, ...structuredClone(changes) };
    return structuredClone(auxiliary);
  });
  const claimDelivery = vi.fn(async () => null);
  const acknowledgeDelivery = vi.fn(async () => { events.push('recover-ack'); });
  const store = createProjectSubtitleGroupingStore({
    getCacheId: () => cacheId,
    getActiveSnapshot: () => structuredClone(active),
    resolveProject,
    loadOriginalRows,
    readAuxiliary,
    patchAuxiliary,
    claimDelivery,
    acknowledgeDelivery,
  });
  return {
    store,
    resolveProject,
    loadOriginalRows,
    readAuxiliary,
    patchAuxiliary,
    claimDelivery,
    acknowledgeDelivery,
    events,
    get auxiliary() { return auxiliary; },
    set auxiliary(value) { auxiliary = value; },
    switchProject() {
      cacheId = 'cache-b';
      active = { metadata: { id: PROJECT_B }, stateVersion: 0 };
    },
  };
};

const providerResult = (context, acknowledge = vi.fn(async () => undefined)) => ({
  success: true,
  groupedSubtitles: createGroupedSubtitles(context.sourceRows, [[1, 2], [3]]),
  providerJobId: JOB_ID,
  deliveryId: DELIVERY_ID,
  acknowledge,
});

it('persists and rereads the exact project/source record before acknowledging', async () => {
  const harness = createHarness();
  const context = await harness.store.capture({
    sourceType: 'original', subtitles: SOURCE, intensity: 'moderate',
  });
  const acknowledge = vi.fn(async () => { harness.events.push('provider-ack'); });
  const receipt = await harness.store.persist(context, providerResult(context, acknowledge));

  expect(acknowledge).not.toHaveBeenCalled();
  expect(harness.auxiliary.grouping).toMatchObject({
    projectId: PROJECT_A,
    projectStateVersion: 3,
    sourceType: 'original',
    sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    providerJobId: JOB_ID,
    deliveryId: DELIVERY_ID,
  });
  await expect(harness.store.acknowledge(receipt)).resolves.toEqual(
    harness.auxiliary.grouping
  );
  expect(harness.events).toEqual(['persist', 'provider-ack']);
});

it('refuses a provider result after the active project switches', async () => {
  const harness = createHarness();
  const context = await harness.store.capture({
    sourceType: 'original', subtitles: SOURCE, intensity: 'balanced',
  });
  const acknowledge = vi.fn();
  harness.switchProject();

  await expect(harness.store.persist(context, providerResult(context, acknowledge)))
    .rejects.toMatchObject({ code: 'subtitleGroupingProjectChanged' });
  expect(harness.patchAuxiliary).not.toHaveBeenCalled();
  expect(acknowledge).not.toHaveBeenCalled();
});

it('refuses a provider result after the durable subtitle revision changes', async () => {
  const harness = createHarness();
  const context = await harness.store.capture({
    sourceType: 'original', subtitles: SOURCE, intensity: 'balanced',
  });
  const changed = SOURCE.map((row, index) => (
    index === 1 ? { ...row, text: 'changed after request' } : row
  ));
  harness.loadOriginalRows.mockResolvedValue(changed);

  await expect(harness.store.persist(context, providerResult(context)))
    .rejects.toMatchObject({ code: 'subtitleGroupingSourceChanged' });
  expect(harness.patchAuxiliary).not.toHaveBeenCalled();
});

it('leaves the native delivery pending when persistence fails', async () => {
  const harness = createHarness();
  const context = await harness.store.capture({
    sourceType: 'original', subtitles: SOURCE, intensity: 'light',
  });
  harness.patchAuxiliary.mockRejectedValueOnce(new Error('disk full'));
  const acknowledge = vi.fn();

  await expect(harness.store.persist(context, providerResult(context, acknowledge)))
    .rejects.toThrow('disk full');
  expect(acknowledge).not.toHaveBeenCalled();
  expect(harness.auxiliary.grouping).toBeNull();
});

it('requires translated grouping input to match a complete durable translation', async () => {
  const harness = createHarness();
  harness.auxiliary = {
    translation: { status: 'partial', baseSubtitles: SOURCE },
    grouping: null,
  };
  await expect(harness.store.capture({
    sourceType: 'translated', subtitles: SOURCE, intensity: 'minimal',
  })).rejects.toMatchObject({ code: 'subtitleGroupingSourceNotDurable' });

  harness.auxiliary = {
    translation: { status: 'complete', baseSubtitles: SOURCE },
    grouping: null,
  };
  await expect(harness.store.capture({
    sourceType: 'translated', subtitles: SOURCE, intensity: 'minimal',
  })).resolves.toMatchObject({ sourceType: 'translated' });
});

it('recovers a committed record after acknowledgement failure without another provider call', async () => {
  const harness = createHarness();
  const context = await harness.store.capture({
    sourceType: 'original', subtitles: SOURCE, intensity: 'enhanced',
  });
  const failedAck = vi.fn(async () => { throw new Error('host restarted'); });
  const receipt = await harness.store.persist(context, providerResult(context, failedAck));
  await expect(harness.store.acknowledge(receipt)).rejects.toThrow('host restarted');
  expect(harness.auxiliary.grouping).not.toBeNull();

  harness.claimDelivery.mockResolvedValueOnce({
    job: { id: JOB_ID },
    delivery: { jobId: JOB_ID, deliveryId: DELIVERY_ID, projectId: PROJECT_A },
  });
  const recovered = await harness.store.load({
    sourceType: 'original', subtitles: SOURCE, intensity: 'enhanced',
  });
  expect(recovered.groupedSubtitles).toEqual(harness.auxiliary.grouping.groupedRows);
  expect(harness.acknowledgeDelivery).toHaveBeenCalledExactlyOnceWith(JOB_ID, DELIVERY_ID);
});

it('rejects forged grouped text even when positions look complete', async () => {
  const harness = createHarness();
  const context = await harness.store.capture({
    sourceType: 'original', subtitles: SOURCE, intensity: 'aggressive',
  });
  const result = providerResult(context);
  const forged = {
    ...result,
    groupedSubtitles: result.groupedSubtitles.map((row, index) => (
      index === 0 ? { ...row, text: 'fabricated' } : row
    )),
  };
  await expect(harness.store.persist(context, forged)).rejects.toMatchObject({
    code: 'invalidSubtitleGroupingResult',
  });
  expect(harness.patchAuxiliary).not.toHaveBeenCalled();
});
