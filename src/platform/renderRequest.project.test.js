// Render project resolution: a render binds to the project that owns the active media through the
// active-workspace pointer, and never mints or re-attaches a project for an asset.
import { ensureNativeRenderProject } from './renderRequest';
import {
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from './nativeMediaOwnership';
import { mutateProject } from './projectService';
import { resolveProjectForCache } from './subtitleProjectStore';

vi.mock('@tauri-apps/api/core', () => ({ Channel: class Channel {}, invoke: vi.fn() }));
vi.mock('./desktopRuntime', () => ({
  isDesktopRuntime: () => true,
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));
vi.mock('./nativeMediaOwnership', async (importOriginal) => ({
  ...await importOriginal(),
  readNativeMediaSession: vi.fn(),
  resolveOwnedNativeMediaProject: vi.fn(),
}));
vi.mock('./projectService', async (importOriginal) => ({
  ...await importOriginal(),
  mutateProject: vi.fn(),
}));
vi.mock('./subtitleProjectStore', () => ({ resolveProjectForCache: vi.fn() }));

const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000401';
const OLD_ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000402';
const NEW_ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000403';
const asset = (id) => Object.freeze({
  id,
  displayName: 'source.mp4',
  extension: 'mp4',
  sizeBytes: 1_024,
  kind: 'video',
});
const ownedProject = (media) => ({
  cacheId: 'url-cache',
  projectId: PROJECT_ID,
  snapshot: {
    metadata: { id: PROJECT_ID, name: 'Downloaded media' },
    stateVersion: 6,
    media: [media],
    tracks: [],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  resolveProjectForCache.mockImplementation(async (cacheId) => ({
    cacheId,
    projectId: '01890f39-7b62-7c4e-8c9a-000000000499',
    snapshot: { media: [], tracks: [] },
  }));
});

it('resolves the project that owns the active re-downloaded media through the pointer', async () => {
  const session = { assetId: NEW_ASSET_ID, cacheId: 'url-cache', projectId: PROJECT_ID };
  readNativeMediaSession.mockReturnValue(session);
  resolveOwnedNativeMediaProject.mockResolvedValue(ownedProject(asset(NEW_ASSET_ID)));

  await expect(ensureNativeRenderProject(asset(NEW_ASSET_ID))).resolves.toBe(PROJECT_ID);
  expect(resolveOwnedNativeMediaProject).toHaveBeenCalledExactlyOnceWith(session);
  expect(resolveProjectForCache).not.toHaveBeenCalled();
  expect(mutateProject).not.toHaveBeenCalled();
});

it('refuses an asset the active-workspace pointer does not name instead of minting a project', async () => {
  readNativeMediaSession.mockReturnValue({
    assetId: OLD_ASSET_ID,
    cacheId: 'url-cache',
    projectId: PROJECT_ID,
  });

  await expect(ensureNativeRenderProject(asset(NEW_ASSET_ID))).rejects.toMatchObject({
    code: 'invalidRenderRequest',
    validationPath: 'project.ownership',
  });
  expect(resolveProjectForCache).not.toHaveBeenCalled();
  expect(mutateProject).not.toHaveBeenCalled();
});

it('refuses when no active-workspace pointer exists', async () => {
  readNativeMediaSession.mockReturnValue(null);

  await expect(ensureNativeRenderProject(asset(NEW_ASSET_ID))).rejects.toMatchObject({
    validationPath: 'project.ownership',
  });
  expect(resolveProjectForCache).not.toHaveBeenCalled();
  expect(mutateProject).not.toHaveBeenCalled();
});

it('refuses when the pointer names the asset but its project no longer owns it', async () => {
  readNativeMediaSession.mockReturnValue({
    assetId: NEW_ASSET_ID,
    cacheId: 'url-cache',
    projectId: PROJECT_ID,
  });
  resolveOwnedNativeMediaProject.mockResolvedValue(null);

  await expect(ensureNativeRenderProject(asset(NEW_ASSET_ID))).rejects.toMatchObject({
    validationPath: 'project.ownership',
  });
  expect(resolveProjectForCache).not.toHaveBeenCalled();
});
