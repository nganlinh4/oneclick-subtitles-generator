import { createMediaCandidateLifecycle } from './mediaCandidateLifecycle';
import { createNativeMediaDescriptor, normalizeMediaCandidate } from './mediaDescriptors';
import { PROJECT_ID, validCandidate, validSnapshot } from './mediaServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

vi.mock('./projectService', () => ({
  activateProjectSnapshot: vi.fn(),
  getActiveProjectSnapshot: vi.fn(),
  mutateProject: vi.fn(),
  undoDetachedProject: vi.fn(),
}));

it('normalizes the real Rust media candidate envelope without reading hostile accessors', () => {
  const candidate = normalizeMediaCandidate(validCandidate());
  expect(candidate).toEqual(validCandidate());
  expect(Object.isFrozen(candidate)).toBe(true);
  expect(Object.isFrozen(candidate.asset)).toBe(true);
  expect(Object.isFrozen(candidate.contentIdentity)).toBe(true);

  let digestReads = 0;
  const hostile = validCandidate();
  Object.defineProperty(hostile.contentIdentity, 'digest', {
    enumerable: true,
    get() {
      digestReads += 1;
      return 'b'.repeat(64);
    },
  });
  expect(() => normalizeMediaCandidate(hostile)).toThrowError(expect.objectContaining({
    code: 'invalidMediaResponse',
  }));
  expect(digestReads).toBe(0);
});

it('opens playback only after projectService conditionally refreshes the exact active project', async () => {
  const candidate = validCandidate();
  const source = {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 7,
    media: [validSnapshot().media],
    tracks: [{ id: 'track' }],
  };
  const committed = {
    metadata: source.metadata,
    stateVersion: 8,
    media: [candidate.asset],
    tracks: source.tracks,
  };
  const mutate = vi.fn(async (projectId, reason, mutator, options) => {
    expect(projectId).toBe(PROJECT_ID);
    expect(reason).toBe(`Replace project media with downloaded candidate ${candidate.asset.id}`);
    expect(options).toEqual({ retryOnConflict: false });
    const replacement = mutator(source);
    expect(replacement.media).toEqual([candidate.asset]);
    expect(replacement.tracks).toBe(source.tracks);
    return {
      revisionId: '01890f39-7b62-7c4e-8c9a-000000000301',
      stateVersion: 8,
      snapshot: committed,
    };
  });
  const descriptor = createNativeMediaDescriptor({
    asset: candidate.asset,
    playback: validSnapshot().playback,
  });
  let active = source;
  const openAsset = vi.fn().mockResolvedValue(descriptor);
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: () => active,
    invokeCommand: vi.fn(),
    mutate: async (...args) => {
      const result = await mutate(...args);
      active = committed;
      return result;
    },
    openAsset,
  });

  await expect(lifecycle.claim(candidate, {
    expectedStateVersion: 7,
    projectId: PROJECT_ID,
  })).resolves.toBe(descriptor);
  expect(openAsset).toHaveBeenCalledExactlyOnceWith(candidate.asset.id);
});

it('never mutates project media when pending subtitle edits cannot be made durable', async () => {
  const candidate = validCandidate();
  const source = {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 7,
    media: [validSnapshot().media],
    tracks: [{ id: 'subtitle-track' }],
  };
  const failure = Object.assign(new Error('history write failed'), {
    code: 'historyWriteFailed',
  });
  const flushSubtitleEdits = vi.fn(async () => { throw failure; });
  const mutate = vi.fn();
  const openAsset = vi.fn();
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: () => source,
    invokeCommand: vi.fn(),
    mutate,
    openAsset,
    flushSubtitleEdits,
  });

  await expect(lifecycle.claim(candidate, {
    expectedStateVersion: 7,
    projectId: PROJECT_ID,
  })).rejects.toBe(failure);

  expect(flushSubtitleEdits).toHaveBeenCalledTimes(1);
  expect(mutate).not.toHaveBeenCalled();
  expect(openAsset).not.toHaveBeenCalled();
});

it('revalidates active project ownership after the subtitle flush', async () => {
  const candidate = validCandidate();
  const source = {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 7,
    media: [validSnapshot().media],
    tracks: [],
  };
  const winner = {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 8,
    media: source.media,
    tracks: [],
  };
  let active = source;
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: () => active,
    invokeCommand: vi.fn(),
    mutate: vi.fn(),
    openAsset: vi.fn(),
    flushSubtitleEdits: vi.fn(async () => { active = winner; }),
  });

  await expect(lifecycle.claim(candidate, {
    expectedStateVersion: 7,
    projectId: PROJECT_ID,
  })).rejects.toMatchObject({ code: 'invalidMediaRequest' });
});

it.each([
  ['another project', {
    metadata: { id: '01890f39-7b62-7c4e-8c9a-000000000401', name: 'Project B' },
    stateVersion: 1,
    media: [],
    tracks: [],
  }],
  ['a newer same-project version', {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 20,
    media: [validSnapshot().media],
    tracks: [],
  }],
])('does not reactivate stale media after %s wins during the project commit', async (_label, winner) => {
  const candidate = validCandidate();
  const source = {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 7,
    media: [validSnapshot().media],
    tracks: [],
  };
  const committed = {
    metadata: source.metadata,
    stateVersion: 8,
    media: [candidate.asset],
    tracks: source.tracks,
  };
  let finishCommit;
  const commitGate = new Promise(resolve => { finishCommit = resolve; });
  let active = source;
  const mutate = vi.fn(async (_projectId, _reason, mutator) => {
    expect(mutator(source).media).toEqual([candidate.asset]);
    await commitGate;
    return {
      revisionId: '01890f39-7b62-7c4e-8c9a-000000000301',
      stateVersion: 8,
      snapshot: committed,
    };
  });
  const openAsset = vi.fn();
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: () => active,
    invokeCommand: vi.fn(),
    mutate,
    openAsset,
  });

  const claim = lifecycle.claim(candidate, {
    expectedStateVersion: 7,
    projectId: PROJECT_ID,
  });
  await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
  active = winner;
  finishCommit();

  await expect(claim).rejects.toMatchObject({ code: 'invalidMediaRequest' });
  expect(active).toBe(winner);
  expect(openAsset).not.toHaveBeenCalled();
});

it('never opens native media when the caller generation is superseded during project commit', async () => {
  const candidate = validCandidate();
  const source = {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 7,
    media: [validSnapshot().media],
    tracks: [],
  };
  const committed = {
    metadata: source.metadata,
    stateVersion: 8,
    media: [candidate.asset],
    tracks: [],
  };
  let finishCommit;
  const commitGate = new Promise((resolve) => { finishCommit = resolve; });
  let active = source;
  let owned = true;
  const ownershipError = Object.assign(new Error('newer request won'), {
    code: 'autoGenerationOwnershipLost',
  });
  const openAsset = vi.fn();
  const mutate = vi.fn(async () => {
    await commitGate;
    active = committed;
    return {
      revisionId: '01890f39-7b62-7c4e-8c9a-000000000301',
      stateVersion: 8,
      snapshot: committed,
    };
  });
  const rollbackMutation = vi.fn(async (_projectId, _reason) => {
    active = source;
    return source;
  });
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: () => active,
    invokeCommand: vi.fn(),
    mutate,
    openAsset,
    rollbackMutation,
  });

  const claim = lifecycle.claim(candidate, {
    expectedStateVersion: 7,
    projectId: PROJECT_ID,
  }, {
    validateOwnership: () => {
      if (!owned) throw ownershipError;
    },
  });
  await vi.waitFor(() => expect(mutate).toHaveBeenCalledOnce());
  owned = false;
  finishCommit();

  await expect(claim).rejects.toBe(ownershipError);
  expect(openAsset).not.toHaveBeenCalled();
  expect(rollbackMutation).toHaveBeenCalledExactlyOnceWith(
    PROJECT_ID,
    `Replace project media with downloaded candidate ${candidate.asset.id}`
  );
  expect(active).toBe(source);
});

it('does not return an opened A descriptor after B becomes active during native open', async () => {
  const candidate = validCandidate();
  const source = {
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 7,
    media: [validSnapshot().media],
    tracks: [],
  };
  const committed = {
    metadata: source.metadata,
    stateVersion: 8,
    media: [candidate.asset],
    tracks: source.tracks,
  };
  const projectB = {
    metadata: { id: '01890f39-7b62-7c4e-8c9a-000000000401', name: 'Project B' },
    stateVersion: 1,
    media: [],
    tracks: [],
  };
  let active = source;
  let finishOpen;
  const opened = new Promise(resolve => { finishOpen = resolve; });
  const descriptor = createNativeMediaDescriptor({
    asset: candidate.asset,
    playback: validSnapshot().playback,
  });
  const openAsset = vi.fn(() => opened);
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: () => active,
    invokeCommand: vi.fn(),
    mutate: async (_projectId, _reason, mutator) => {
      expect(mutator(source).media).toEqual([candidate.asset]);
      active = committed;
      return {
        revisionId: '01890f39-7b62-7c4e-8c9a-000000000301',
        stateVersion: 8,
        snapshot: committed,
      };
    },
    openAsset,
  });

  const claim = lifecycle.claim(candidate, {
    expectedStateVersion: 7,
    projectId: PROJECT_ID,
  });
  await vi.waitFor(() => expect(openAsset).toHaveBeenCalledOnce());
  active = projectB;
  finishOpen(descriptor);

  await expect(claim).rejects.toMatchObject({ code: 'invalidMediaRequest' });
  expect(active).toBe(projectB);
});

it('rejects stale project claims before commit and discards only through the exact candidate ABI', async () => {
  const candidate = validCandidate();
  const mutate = vi.fn(async (_projectId, _reason, mutator) => mutator({
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 8,
    media: [],
    tracks: [],
  }));
  const invokeCommand = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce('true');
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: () => ({
      metadata: { id: PROJECT_ID, name: 'Fixture' },
      stateVersion: 7,
      media: [],
      tracks: [],
    }),
    invokeCommand,
    mutate,
    openAsset: vi.fn(),
  });

  await expect(lifecycle.claim(candidate, {
    expectedStateVersion: 7,
    projectId: PROJECT_ID,
  })).rejects.toMatchObject({ code: 'invalidMediaRequest' });
  await expect(lifecycle.discard(candidate.asset.id)).resolves.toBe(true);
  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'discard_media_candidate', {
    id: candidate.asset.id,
  });
  await expect(lifecycle.discard(candidate.asset.id)).rejects.toMatchObject({
    code: 'invalidMediaResponse',
  });
});
