import { createNativeMediaDescriptor } from './mediaService';
import {
  NATIVE_MEDIA_SESSION_KEY,
  canonicalAssetFromDescriptor,
  ensureProjectOwnsNativeMedia,
  forgetNativeMediaSession,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
  subtitleAliasForActiveMedia,
  writeNativeMediaSession,
} from './nativeMediaOwnership';

vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(async (url) => (
    url === 'https://example.com/broken' ? '' : `site_${url.replace(/[^a-z0-9]+/gi, '_')}`
  )),
}));

const ASSET_A = '018f47a2-7c20-7f70-8000-000000000001';
const ASSET_B = '018f47a2-7c20-7f70-8000-000000000002';
const PROJECT_A = '018f47a2-7c20-7f70-8000-0000000000a1';
const PROJECT_B = '018f47a2-7c20-7f70-8000-0000000000a2';
const URL_ALIAS = 'site_https_example_com_clip';

const MEDIA_A = createNativeMediaDescriptor({
  asset: {
    displayName: 'fixture.mp4', extension: 'mp4', id: ASSET_A, kind: 'video', sizeBytes: 10,
  },
  playback: {
    byteLength: 10,
    id: '123e4567-e89b-42d3-a456-426614174000',
    mimeType: 'video/mp4',
    playbackUrl: `http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=${'a'.repeat(64)}`,
  },
});

const ASSET_RECORD = Object.freeze({
  id: ASSET_A, displayName: 'fixture.mp4', extension: 'mp4', sizeBytes: 10, kind: 'video',
});

const snapshotWith = (media, { projectId = PROJECT_A, stateVersion = 3 } = {}) => ({
  metadata: { id: projectId, name: 'Downloaded media' },
  stateVersion,
  media,
  tracks: [],
});

beforeEach(() => {
  localStorage.clear();
});

it('converts a native descriptor to the exact durable asset record', () => {
  const asset = canonicalAssetFromDescriptor(MEDIA_A);
  expect(asset).toEqual(ASSET_RECORD);
  expect(Object.isFrozen(asset)).toBe(true);
});

it.each([
  ['a non-descriptor', () => ({ assetId: ASSET_A })],
  ['a dotless name', () => Object.freeze({ ...MEDIA_A, name: 'fixture' })],
  ['an unknown kind', () => Object.freeze({ ...MEDIA_A, type: 'application/pdf' })],
])('refuses to convert %s', (_label, build) => {
  expect(() => canonicalAssetFromDescriptor(build())).toThrow(
    expect.objectContaining({ code: 'nativeMediaOwnershipFailed' })
  );
});

it('keys downloaded media by its source URL and imported media by its asset', async () => {
  await expect(subtitleAliasForActiveMedia({
    assetId: ASSET_A,
    videoUrl: 'https://example.com/clip',
  })).resolves.toBe(URL_ALIAS);
  await expect(subtitleAliasForActiveMedia({ assetId: ASSET_A })).resolves.toBe(ASSET_A);
  await expect(subtitleAliasForActiveMedia({ assetId: ASSET_A, videoUrl: null }))
    .resolves.toBe(ASSET_A);
});

it.each([
  ['a non-UUIDv7 asset', { assetId: 'asset-a' }],
  ['a non-string URL', { assetId: ASSET_A, videoUrl: 7 }],
  ['a URL that derives no alias', { assetId: ASSET_A, videoUrl: 'https://example.com/broken' }],
])('refuses an alias for %s', async (_label, input) => {
  await expect(subtitleAliasForActiveMedia(input)).rejects.toMatchObject({
    code: 'nativeMediaOwnershipFailed',
  });
});

it('round-trips a session pointer through storage', () => {
  writeNativeMediaSession({ assetId: ASSET_A, cacheId: URL_ALIAS, projectId: PROJECT_A });
  expect(JSON.parse(localStorage.getItem(NATIVE_MEDIA_SESSION_KEY))).toEqual({
    v: 1, assetId: ASSET_A, cacheId: URL_ALIAS, projectId: PROJECT_A,
  });
  expect(readNativeMediaSession()).toEqual({
    assetId: ASSET_A, cacheId: URL_ALIAS, projectId: PROJECT_A,
  });

  forgetNativeMediaSession();
  expect(readNativeMediaSession()).toBeNull();
});

it.each([
  ['absent', null],
  ['not JSON', 'not-json'],
  ['an array', '[]'],
  ['a wrong version', JSON.stringify({ v: 2, assetId: ASSET_A, cacheId: 'a', projectId: PROJECT_A })],
  ['missing a key', JSON.stringify({ v: 1, assetId: ASSET_A, cacheId: 'a' })],
  ['carrying an extra key', JSON.stringify({
    v: 1, assetId: ASSET_A, cacheId: 'a', projectId: PROJECT_A, path: 'C:\\clip.mp4',
  })],
  ['a non-UUIDv7 asset', JSON.stringify({
    v: 1, assetId: 'asset-a', cacheId: 'a', projectId: PROJECT_A,
  })],
  ['a non-UUIDv7 project', JSON.stringify({
    v: 1, assetId: ASSET_A, cacheId: 'a', projectId: 'project-a',
  })],
  ['a blank alias', JSON.stringify({
    v: 1, assetId: ASSET_A, cacheId: '', projectId: PROJECT_A,
  })],
  ['an over-long alias', JSON.stringify({
    v: 1, assetId: ASSET_A, cacheId: 'a'.repeat(9_000), projectId: PROJECT_A,
  })],
])('reads no session when the pointer is %s', (_label, raw) => {
  if (raw !== null) localStorage.setItem(NATIVE_MEDIA_SESSION_KEY, raw);
  expect(readNativeMediaSession()).toBeNull();
});

it.each([
  ['a non-UUIDv7 asset', { assetId: 'asset-a', cacheId: 'a', projectId: PROJECT_A }],
  ['a blank alias', { assetId: ASSET_A, cacheId: '', projectId: PROJECT_A }],
  ['a non-UUIDv7 project', { assetId: ASSET_A, cacheId: 'a', projectId: 'p' }],
])('refuses to remember a session with %s', (_label, session) => {
  expect(() => writeNativeMediaSession(session)).toThrow(
    expect.objectContaining({ code: 'nativeMediaOwnershipFailed' })
  );
});

it('attaches imported media to its alias project and remembers the association', async () => {
  const mutate = vi.fn(async () => ({ snapshot: snapshotWith([ASSET_RECORD], { stateVersion: 4 }) }));
  const rememberSession = vi.fn();
  const resolveProject = vi.fn()
    .mockResolvedValueOnce({
      cacheId: ASSET_A, projectId: PROJECT_A, snapshot: snapshotWith([]),
    })
    .mockResolvedValueOnce({
      cacheId: ASSET_A, projectId: PROJECT_A, snapshot: snapshotWith([ASSET_RECORD]),
    });

  await expect(ensureProjectOwnsNativeMedia(
    { media: MEDIA_A, cacheId: ASSET_A },
    { resolveProject, mutate, rememberSession }
  )).resolves.toEqual({ assetId: ASSET_A, cacheId: ASSET_A, projectId: PROJECT_A });

  expect(resolveProject).toHaveBeenNthCalledWith(1, ASSET_A, { create: true });
  expect(resolveProject).toHaveBeenNthCalledWith(2, ASSET_A, { create: false });
  expect(mutate).toHaveBeenCalledExactlyOnceWith(
    PROJECT_A,
    'Associate active media with its subtitle project',
    expect.any(Function),
    { retryOnConflict: true }
  );
  expect(mutate.mock.calls[0][2](snapshotWith([])).media).toEqual([ASSET_RECORD]);
  expect(rememberSession).toHaveBeenCalledExactlyOnceWith({
    assetId: ASSET_A, cacheId: ASSET_A, projectId: PROJECT_A,
  });
});

it('does not commit again when the claim already attached the same asset', async () => {
  const mutate = vi.fn();
  const rememberSession = vi.fn();
  const resolveProject = vi.fn(async () => ({
    cacheId: URL_ALIAS, projectId: PROJECT_A, snapshot: snapshotWith([ASSET_RECORD]),
  }));

  await ensureProjectOwnsNativeMedia(
    { media: MEDIA_A, cacheId: URL_ALIAS },
    { resolveProject, mutate, rememberSession }
  );

  expect(mutate).not.toHaveBeenCalled();
  expect(resolveProject).toHaveBeenCalledTimes(2);
  expect(rememberSession).toHaveBeenCalledOnce();
});

it('never records a session when the alias remaps during ownership publication', async () => {
  const rememberSession = vi.fn();
  const resolveProject = vi.fn()
    .mockResolvedValueOnce({
      cacheId: URL_ALIAS, projectId: PROJECT_A, snapshot: snapshotWith([ASSET_RECORD]),
    })
    .mockResolvedValueOnce({
      cacheId: URL_ALIAS, projectId: PROJECT_B, snapshot: snapshotWith([ASSET_RECORD]),
    });

  await expect(ensureProjectOwnsNativeMedia({
    media: MEDIA_A,
    cacheId: URL_ALIAS,
    expectedProjectId: PROJECT_A,
  }, {
    resolveProject,
    mutate: vi.fn(),
    rememberSession,
  })).rejects.toMatchObject({ code: 'nativeMediaOwnershipFailed' });

  expect(rememberSession).not.toHaveBeenCalled();
});

it('surfaces a project conflict unchanged and remembers nothing', async () => {
  const conflict = Object.assign(new Error('stale project version'), {
    code: 'staleProjectVersion',
  });
  const rememberSession = vi.fn();

  await expect(ensureProjectOwnsNativeMedia({ media: MEDIA_A, cacheId: URL_ALIAS }, {
    resolveProject: async () => ({
      cacheId: URL_ALIAS, projectId: PROJECT_A, snapshot: snapshotWith([]),
    }),
    mutate: async () => { throw conflict; },
    rememberSession,
  })).rejects.toBe(conflict);
  expect(rememberSession).not.toHaveBeenCalled();
});

it.each([
  ['the commit did not attach the asset', {
    mutate: async () => ({ snapshot: snapshotWith([]) }),
  }],
  ['the commit attached a different asset', {
    mutate: async () => ({ snapshot: snapshotWith([{ ...ASSET_RECORD, id: ASSET_B }]) }),
  }],
  ['the commit attached extra media', {
    mutate: async () => ({
      snapshot: snapshotWith([ASSET_RECORD, { ...ASSET_RECORD, id: ASSET_B }]),
    }),
  }],
  ['the alias resolves to nothing', { resolveProject: async () => null }],
  ['the alias resolves without a snapshot', {
    resolveProject: async () => ({ projectId: PROJECT_A }),
  }],
])('never remembers a session when %s', async (_label, overrides) => {
  const rememberSession = vi.fn();
  const deps = {
    resolveProject: async () => ({
      cacheId: URL_ALIAS, projectId: PROJECT_A, snapshot: snapshotWith([]),
    }),
    mutate: async () => ({ snapshot: snapshotWith([ASSET_RECORD]) }),
    rememberSession,
    ...overrides,
  };

  await expect(ensureProjectOwnsNativeMedia(
    { media: MEDIA_A, cacheId: URL_ALIAS },
    deps
  )).rejects.toMatchObject({ code: 'nativeMediaOwnershipFailed' });
  expect(rememberSession).not.toHaveBeenCalled();
});

it('resolves the project a remembered session still legitimately owns', async () => {
  const resolved = { cacheId: URL_ALIAS, projectId: PROJECT_A, snapshot: snapshotWith([ASSET_RECORD]) };
  const resolveProject = vi.fn(async () => resolved);

  await expect(resolveOwnedNativeMediaProject(
    { assetId: ASSET_A, cacheId: URL_ALIAS, projectId: PROJECT_A },
    { resolveProject }
  )).resolves.toBe(resolved);
  // Never `create: true`: a remapped alias must fail closed, not mint a replacement project.
  expect(resolveProject).toHaveBeenCalledExactlyOnceWith(URL_ALIAS, { create: false });
});

it.each([
  ['the alias was deleted', { resolveProject: async () => null }],
  ['the alias was remapped to another project', {
    resolveProject: async () => ({
      cacheId: URL_ALIAS, projectId: PROJECT_B, snapshot: snapshotWith([ASSET_RECORD]),
    }),
  }],
  ['the project no longer lists the asset', {
    resolveProject: async () => ({
      cacheId: URL_ALIAS, projectId: PROJECT_A, snapshot: snapshotWith([]),
    }),
  }],
  ['the lookup fails', {
    resolveProject: async () => { throw new Error('storage unavailable'); },
  }],
])('refuses to resolve an owner when %s', async (_label, overrides) => {
  await expect(resolveOwnedNativeMediaProject(
    { assetId: ASSET_A, cacheId: URL_ALIAS, projectId: PROJECT_A },
    overrides
  )).resolves.toBeNull();
});

it.each([
  ['a malformed session', null],
  ['a non-UUIDv7 asset', { assetId: 'a', cacheId: URL_ALIAS, projectId: PROJECT_A }],
  ['a blank alias', { assetId: ASSET_A, cacheId: '', projectId: PROJECT_A }],
])('refuses to resolve an owner for %s', async (_label, session) => {
  const resolveProject = vi.fn();
  await expect(resolveOwnedNativeMediaProject(session, { resolveProject })).resolves.toBeNull();
  expect(resolveProject).not.toHaveBeenCalled();
});
