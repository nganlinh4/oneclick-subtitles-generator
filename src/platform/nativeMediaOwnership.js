import { isNativeMediaDescriptor } from './mediaService';
import { isUuidV7 } from './projectSnapshotAdapter';
import { mutateProject } from './projectService';
import { resolveProjectForCache } from './subtitleProjectStore';
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
const ATTACH_REASON = 'Associate active media with its subtitle project';

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
);

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
  return Object.freeze({
    assetId: parsed.assetId,
    cacheId: parsed.cacheId,
    projectId: parsed.projectId,
  });
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
};

export const forgetNativeMediaSession = ({
  removeValue = () => localStorage.removeItem(NATIVE_MEDIA_SESSION_KEY),
} = {}) => {
  try {
    removeValue();
  } catch {
    // A session pointer that cannot be cleared is re-validated on the next read anyway.
  }
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
  rememberSession = writeNativeMediaSession,
} = {}) => {
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

  rememberSession({ assetId: asset.id, cacheId, projectId: authoritative.projectId });
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
} = {}) => {
  if (!isUuidV7(session?.assetId) || !isUuidV7(session?.projectId) || !isCacheId(session?.cacheId)) {
    return null;
  }
  let resolved;
  try {
    resolved = await resolveProject(session.cacheId, { create: false });
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
