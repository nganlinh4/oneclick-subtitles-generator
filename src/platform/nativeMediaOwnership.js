import { isNativeMediaDescriptor } from './mediaService';
import { isUuidV7 } from './projectSnapshotAdapter';
import { mutateProject } from './projectService';
import { invokeDesktop } from './desktopRuntime';
import {
  adoptExactSubtitleProjectAlias,
  resolveProjectForCache,
} from './subtitleProjectStore';
import { generateUrlBasedCacheId } from '../services/subtitleCache';
import { resolveProjectForMedia } from './subtitleDocumentProject';
import { readActiveMedia, updateActiveMedia } from './activeMediaSource';

/**
 * Durable association between the media the app is showing and the subtitle project that owns it.
 *
 * Three identifiers are deliberately kept distinct here, because reusing one in another's role is
 * what previously orphaned URL-keyed subtitles:
 *   - `assetId`  — the opaque native asset (UUIDv7). Identifies the bytes, never the project.
 *   - `cacheId`  — the subtitle project alias: the URL-derived cache ID for downloaded media, or
 *                  the asset ID for locally imported media. Identifies the project.
 *   - `projectId`— the durable project (UUIDv7) the alias currently resolves to.
 *
 * The persisted pointer is a hint only. The desktop host re-verifies (projectId, stateVersion,
 * assetId) before and after it registers playback, so a stale or forged pointer can only produce a
 * refusal, never a wrong or unowned open.
 */

// Older builds mirrored the pointer into WebView storage; it is read once, then removed.
export const LEGACY_SESSION_STORAGE_KEY = 'current_media_session';

const MAX_CACHE_ID_CHARACTERS = 8_192;
const LEGACY_SESSION_VERSION = 1;
const LEGACY_SESSION_KEYS = Object.freeze(['assetId', 'cacheId', 'projectId', 'v']);
const WORKSPACE_STATE_KEYS = Object.freeze(['initialized', 'schemaVersion', 'workspace']);
const ATTACH_REASON = 'Associate active media with its subtitle project';
let latestWorkspacePublication = 0;

class NativeMediaOwnershipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeMediaOwnershipError';
    this.code = code;
  }
}

const ownershipFailure = () => new NativeMediaOwnershipError(
  'nativeMediaOwnershipFailed',
  'The active media could not be bound to its subtitle project'
);

const isCacheId = (value) => (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_CACHE_ID_CHARACTERS
  && !Array.from(value).some(character => /\p{Cc}/u.test(character))
);

const sameSession = (left, right) => (
  left?.assetId === right?.assetId
  && left?.cacheId === right?.cacheId
  && left?.projectId === right?.projectId
);

const sessionFromWorkspace = (workspace) => {
  if (workspace === null) return null;
  if (!workspace || workspace.schemaVersion !== 1
      || !isUuidV7(workspace.mediaId) || !isUuidV7(workspace.projectId)
      || !isCacheId(workspace.cacheId)
      || (workspace.trackId !== null && !isUuidV7(workspace.trackId))
      || !Number.isSafeInteger(workspace.projectStateVersion)
      || workspace.projectStateVersion < 0) {
    throw ownershipFailure();
  }
  return Object.freeze({
    assetId: workspace.mediaId,
    cacheId: workspace.cacheId,
    projectId: workspace.projectId,
  });
};

const sessionFromWorkspaceState = (state) => {
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).length !== WORKSPACE_STATE_KEYS.length
      || Object.keys(state).some(key => !WORKSPACE_STATE_KEYS.includes(key))
      || state.schemaVersion !== 1 || typeof state.initialized !== 'boolean') {
    throw ownershipFailure();
  }
  const session = sessionFromWorkspace(state.workspace);
  if (!state.initialized && session !== null) throw ownershipFailure();
  return Object.freeze({ initialized: state.initialized, session });
};

/**
 * Project media shape accepted by the native project ABI. Shared with the render source path so a
 * descriptor is converted to a durable asset in exactly one way.
 */
export const canonicalAssetFromDescriptor = (descriptor) => {
  if (!isNativeMediaDescriptor(descriptor)) throw ownershipFailure();
  const separator = descriptor.name.lastIndexOf('.');
  if (separator <= 0 || separator === descriptor.name.length - 1) throw ownershipFailure();
  const extension = descriptor.name.slice(separator + 1).toLowerCase();
  const kind = descriptor.type.startsWith('video/') ? 'video'
    : descriptor.type.startsWith('audio/') ? 'audio' : null;
  if (kind === null) throw ownershipFailure();
  return Object.freeze({
    id: descriptor.assetId,
    displayName: descriptor.name,
    extension,
    sizeBytes: descriptor.size,
    kind,
  });
};

const sameAsset = (candidate, asset) => (
  candidate?.id === asset.id
  && candidate.displayName === asset.displayName
  && candidate.extension === asset.extension
  && candidate.sizeBytes === asset.sizeBytes
  && candidate.kind === asset.kind
);

/**
 * The one canonical alias rule. Downloaded media is keyed by its source URL so its subtitles,
 * rules and history survive re-downloads that mint a new asset; imported media is keyed by its
 * asset, which is the only stable identity a local file has.
 */
export const subtitleAliasForActiveMedia = async ({ assetId, videoUrl = null }) => {
  if (!isUuidV7(assetId)) throw ownershipFailure();
  if (videoUrl === null || videoUrl === undefined || videoUrl === '') return assetId;
  if (typeof videoUrl !== 'string') throw ownershipFailure();
  const cacheId = await generateUrlBasedCacheId(videoUrl);
  if (!isCacheId(cacheId)) throw ownershipFailure();
  return cacheId;
};

const parseLegacySession = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CACHE_ID_CHARACTERS * 2) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== LEGACY_SESSION_KEYS.length
      || keys.some((key) => !LEGACY_SESSION_KEYS.includes(key))
      || parsed.v !== LEGACY_SESSION_VERSION
      || !isUuidV7(parsed.assetId)
      || !isUuidV7(parsed.projectId)
      || !isCacheId(parsed.cacheId)) {
    return null;
  }
  return Object.freeze({
    assetId: parsed.assetId,
    cacheId: parsed.cacheId,
    projectId: parsed.projectId,
  });
};

/** Read and remove the pointer older builds kept in WebView storage. Used once, for migration. */
export const takeLegacyNativeMediaSession = ({ storage = globalThis.localStorage } = {}) => {
  try {
    const session = parseLegacySession(storage?.getItem(LEGACY_SESSION_STORAGE_KEY));
    storage?.removeItem(LEGACY_SESSION_STORAGE_KEY);
    return session;
  } catch {
    return null;
  }
};

/** The in-memory mirror of the native pointer, used by synchronous ownership checks. */
export const readNativeMediaSession = () => readActiveMedia().session;

export const writeNativeMediaSession = (session) => {
  if (!isUuidV7(session?.assetId) || !isUuidV7(session?.projectId) || !isCacheId(session?.cacheId)) {
    throw ownershipFailure();
  }
  updateActiveMedia({
    session: Object.freeze({
      assetId: session.assetId,
      cacheId: session.cacheId,
      projectId: session.projectId,
    }),
  });
};

/** Drop the mirror, but only while it still names `expectedSession` when one is given. */
export const forgetNativeMediaSession = ({ expectedSession = null } = {}) => {
  const current = readNativeMediaSession();
  if (expectedSession !== null && (current === null || !sameSession(current, expectedSession))) {
    return false;
  }
  updateActiveMedia({ session: null });
  return true;
};

/** Persist the exact pointer through the typed native workspace boundary, then update the
 * in-memory mirror used by synchronous ownership checks. */
export const persistNativeMediaSession = async (session, {
  invokeCommand = invokeDesktop,
  rememberMirror = writeNativeMediaSession,
  intentId = null,
} = {}) => {
  if (!isUuidV7(session?.assetId) || !isUuidV7(session?.projectId)
      || !isCacheId(session?.cacheId)) {
    throw ownershipFailure();
  }
  const activeIntent = intentId ?? await invokeCommand('active_workspace_begin', {});
  if (!isUuidV7(activeIntent)) throw ownershipFailure();
  const response = await invokeCommand('active_workspace_set', {
    workspace: {
      cacheId: session.cacheId,
      projectId: session.projectId,
      mediaId: session.assetId,
    },
    intentId: activeIntent,
  });
  const stored = sessionFromWorkspace(response);
  if (!sameSession(stored, session)) throw ownershipFailure();
  rememberMirror(stored);
  return stored;
};

/** Load the native pointer before any media reconciliation. A legacy WebView-storage pointer is
 * migrated only while native authority is uninitialized, and only after Rust proves the exact
 * project currently owns that media; otherwise the stale copy is simply discarded. */
export const loadDurableNativeMediaSession = async ({
  invokeCommand = invokeDesktop,
  takeLegacy = takeLegacyNativeMediaSession,
  rememberMirror = writeNativeMediaSession,
  forgetMirror = forgetNativeMediaSession,
  persist = persistNativeMediaSession,
} = {}) => {
  const state = sessionFromWorkspaceState(await invokeCommand('active_workspace_get', {}));
  const legacy = takeLegacy();
  if (state.session !== null) {
    rememberMirror(state.session);
    return state.session;
  }
  if (state.initialized) {
    // A native tombstone means an ordinary user removal already won.
    forgetMirror();
    return null;
  }
  if (legacy === null) return null;
  return persist(legacy, { invokeCommand, rememberMirror });
};

/** Ordinary media removal clears both authorities conditionally. Factory reset intentionally does
 * not call this function: it withdraws playback but preserves the customer's active workspace. */
export const forgetNativeMediaSessionDurably = async ({
  expectedSession = readNativeMediaSession(),
  invokeCommand = invokeDesktop,
  forgetMirror = forgetNativeMediaSession,
} = {}) => {
  let target = expectedSession;
  if (target === null) {
    const state = sessionFromWorkspaceState(await invokeCommand('active_workspace_get', {}));
    target = state.session;
    if (target === null && state.initialized) return true;
  }
  const expected = target === null ? null : {
    cacheId: target.cacheId,
    projectId: target.projectId,
    mediaId: target.assetId,
  };
  const intentId = await invokeCommand('active_workspace_begin', {});
  if (!isUuidV7(intentId)) throw ownershipFailure();
  const cleared = await invokeCommand('active_workspace_clear', { expected, intentId });
  if (cleared !== true) return false;
  // Native authority has committed the tombstone. Mirror cleanup is conditional so a newer
  // winner published while IPC was in flight cannot be erased.
  if (target !== null) forgetMirror({ expectedSession: target });
  return true;
};

/**
 * Attach the active native media to its alias project and remember that association durably.
 *
 * The pointer is written only after the durable commit lands, so it can never claim an ownership
 * the database does not hold. A URL download has already committed the same media through the
 * candidate claim, so this verifies and remembers without a second commit.
 */
export const ensureProjectOwnsNativeMedia = async ({
  media,
  cacheId,
  expectedProjectId = null,
}, {
  resolveProject = resolveProjectForMedia,
  mutate = mutateProject,
  rememberSession = persistNativeMediaSession,
  beginIntent = async () => invokeDesktop('active_workspace_begin', {}),
} = {}) => {
  latestWorkspacePublication += 1;
  const publication = latestWorkspacePublication;
  const nativePublication = rememberSession === persistNativeMediaSession;
  const intentId = nativePublication ? await beginIntent() : null;
  if (nativePublication && !isUuidV7(intentId)) throw ownershipFailure();
  const asset = canonicalAssetFromDescriptor(media);
  if (!isCacheId(cacheId)
      || (expectedProjectId !== null && !isUuidV7(expectedProjectId))) {
    throw ownershipFailure();
  }

  const resolved = await resolveProject(cacheId, { create: true });
  // The first attached media inherits a standalone document's existing identity.
  if (resolveProject === resolveProjectForMedia) cacheId = resolved?.cacheId;
  if (!isUuidV7(resolved?.projectId)
      || (expectedProjectId !== null && resolved.projectId !== expectedProjectId)
      || !Array.isArray(resolved.snapshot?.media)) {
    throw ownershipFailure();
  }

  if (!resolved.snapshot.media.some((candidate) => sameAsset(candidate, asset))) {
    const committed = await mutate(
      resolved.projectId,
      ATTACH_REASON,
      (snapshot) => ({ ...snapshot, media: [asset] }),
      { retryOnConflict: true }
    );
    const committedMedia = committed?.snapshot?.media;
    if (!Array.isArray(committedMedia)
        || committedMedia.length !== 1
        || !sameAsset(committedMedia[0], asset)) {
      throw ownershipFailure();
    }
  }

  // The alias is mutable independently of a project revision. Re-resolve after the durable check
  // so a concurrent remap cannot receive this asset's session pointer or let an old download
  // publish against a newly active project.
  const authoritative = await resolveProject(cacheId, { create: false });
  if (authoritative?.projectId !== resolved.projectId
      || !Array.isArray(authoritative.snapshot?.media)
      || !authoritative.snapshot.media.some((candidate) => sameAsset(candidate, asset))) {
    throw ownershipFailure();
  }

  if (publication !== latestWorkspacePublication) throw ownershipFailure();
  const session = { assetId: asset.id, cacheId, projectId: authoritative.projectId };
  if (intentId === null) await rememberSession(session);
  else await rememberSession(session, { intentId });
  if (publication !== latestWorkspacePublication) throw ownershipFailure();
  return Object.freeze({ assetId: asset.id, cacheId, projectId: authoritative.projectId });
};

/**
 * Resolve the project a remembered session still legitimately points at, or null.
 *
 * `create: false` is essential: a remapped or deleted alias must fail closed rather than mint a
 * replacement project and orphan the real one. Losing the asset from the snapshot — an undo past
 * the attach revision, or a replacement import — also fails closed before any native call.
 *
 * `onStale` runs only when the stores answered and the answer disowns the session (the alias names
 * another project, or that project no longer lists the asset). A failed lookup is not proof, so it
 * returns null without calling it.
 */
export const resolveOwnedNativeMediaProject = async (session, {
  resolveProject = resolveProjectForCache,
  adoptProject = adoptExactSubtitleProjectAlias,
  onStale = () => {},
} = {}) => {
  if (!isUuidV7(session?.assetId) || !isUuidV7(session?.projectId) || !isCacheId(session?.cacheId)) {
    return null;
  }
  let resolved;
  try {
    resolved = await resolveProject(session.cacheId, { create: false });
    if (resolved === null) {
      resolved = await adoptProject(session.cacheId, session.projectId);
    }
  } catch {
    return null;
  }
  if (resolved === null || !Array.isArray(resolved?.snapshot?.media)) return null;
  if (resolved.projectId !== session.projectId
      || !resolved.snapshot.media.some((asset) => asset?.id === session.assetId)) {
    onStale();
    return null;
  }
  return resolved;
};
