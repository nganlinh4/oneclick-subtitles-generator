import { isNativeMediaDescriptor } from './mediaService';
import { isUuidV7 } from './projectSnapshotAdapter';
import { mutateProject } from './projectService';
import { invokeDesktop } from './desktopRuntime';
import {
  adoptExactSubtitleProjectAlias,
  resolveProjectForCache,
} from './subtitleProjectStore';
import { generateUrlBasedCacheId } from '../services/subtitleCache';

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

export const NATIVE_MEDIA_SESSION_KEY = 'current_media_session';

const MAX_CACHE_ID_CHARACTERS = 8_192;
const SESSION_VERSION = 1;
const SESSION_KEYS = Object.freeze(['assetId', 'cacheId', 'projectId', 'v']);
const WORKSPACE_STATE_KEYS = Object.freeze(['initialized', 'schemaVersion', 'workspace']);
const ATTACH_REASON = 'Associate active media with its subtitle project';
let latestWorkspacePublication = 0;
let suppressedBrowserSession = null;

export class NativeMediaOwnershipError extends Error {
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

export const readNativeMediaSession = ({
  readValue = () => localStorage.getItem(NATIVE_MEDIA_SESSION_KEY),
} = {}) => {
  let parsed;
  try {
    const raw = readValue();
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CACHE_ID_CHARACTERS * 2) {
      if (raw === null) suppressedBrowserSession = null;
      return null;
    }
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== SESSION_KEYS.length || keys.some((key) => !SESSION_KEYS.includes(key))) {
    return null;
  }
  if (parsed.v !== SESSION_VERSION
      || !isUuidV7(parsed.assetId)
      || !isUuidV7(parsed.projectId)
      || !isCacheId(parsed.cacheId)) {
    return null;
  }
  const session = Object.freeze({
    assetId: parsed.assetId,
    cacheId: parsed.cacheId,
    projectId: parsed.projectId,
  });
  if (sameSession(session, suppressedBrowserSession)) return null;
  suppressedBrowserSession = null;
  return session;
};

export const writeNativeMediaSession = (session, {
  writeValue = (value) => localStorage.setItem(NATIVE_MEDIA_SESSION_KEY, value),
} = {}) => {
  if (!isUuidV7(session?.assetId) || !isUuidV7(session?.projectId) || !isCacheId(session?.cacheId)) {
    throw ownershipFailure();
  }
  writeValue(JSON.stringify({
    v: SESSION_VERSION,
    assetId: session.assetId,
    cacheId: session.cacheId,
    projectId: session.projectId,
  }));
  suppressedBrowserSession = null;
};

export const forgetNativeMediaSession = ({
  expectedSession = null,
  readValue = () => localStorage.getItem(NATIVE_MEDIA_SESSION_KEY),
  removeValue = () => localStorage.removeItem(NATIVE_MEDIA_SESSION_KEY),
} = {}) => {
  const current = readNativeMediaSession({ readValue });
  if (expectedSession !== null) {
    if (current === null
        || current.assetId !== expectedSession.assetId
        || current.cacheId !== expectedSession.cacheId
        || current.projectId !== expectedSession.projectId) {
      return false;
    }
  }
  try {
    removeValue();
    suppressedBrowserSession = null;
    return true;
  } catch {
    // Native authority may already contain an empty tombstone. Suppress this exact stale mirror
    // for the rest of the WebView lifetime so cleanup failure cannot roll the visible app back.
    suppressedBrowserSession = current;
    return false;
  }
};

/** Persist the exact pointer through the typed native workspace boundary, then update the browser
 * mirror used by synchronous ownership checks in the current WebView. */
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

/** Load the native pointer before any media reconciliation. A legacy browser pointer is migrated
 * only after Rust proves the exact project currently owns that media. */
export const loadDurableNativeMediaSession = async ({
  invokeCommand = invokeDesktop,
  readLegacy = readNativeMediaSession,
  rememberMirror = writeNativeMediaSession,
  forgetLegacy = forgetNativeMediaSession,
  persist = persistNativeMediaSession,
} = {}) => {
  const state = sessionFromWorkspaceState(await invokeCommand('active_workspace_get', {}));
  if (state.session !== null) {
    const session = state.session;
    rememberMirror(session);
    return session;
  }
  if (state.initialized) {
    // A native tombstone means an ordinary user removal already won. Clearing a stale browser
    // mirror here closes the crash window between native clear and localStorage cleanup.
    forgetLegacy();
    return null;
  }
  const legacy = readLegacy();
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
  // Native authority has committed the tombstone. Browser cleanup is conditional so a newer
  // winner published while IPC was in flight cannot be erased, and cleanup failure cannot turn a
  // durable success into a rollback request.
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
  resolveProject = resolveProjectForCache,
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
 */
export const resolveOwnedNativeMediaProject = async (session, {
  resolveProject = resolveProjectForCache,
  adoptProject = adoptExactSubtitleProjectAlias,
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
  if (resolved === null || resolved?.projectId !== session.projectId) return null;
  if (!Array.isArray(resolved.snapshot?.media)
      || !resolved.snapshot.media.some((asset) => asset?.id === session.assetId)) {
    return null;
  }
  return resolved;
};
