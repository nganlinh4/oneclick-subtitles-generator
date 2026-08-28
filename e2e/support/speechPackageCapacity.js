// Pure mirror of the ONE precondition a narration-model install has to satisfy before the product
// will start it, so a journey can tell "the install refused honestly" apart from "the install is
// broken" without probing a private queue.
//
// crates/osg-engine-packages/src/manager.rs:1620-1632 (`ensure_disk_capacity`) runs inside the
// install worker, BEFORE the first delivery byte is fetched, and fails the operation with
// `PackageError::InsufficientSpace` unless the package store's volume can hold the compressed
// download PLUS the unpacked tree PLUS a fixed reserve. On a host below that line the install job
// starts and dies in the same instant, so the panel's Cancel control -- which the product renders
// only while `status.operation` is populated -- can never be observed. That is the product refusing
// to start a multi-gigabyte download it cannot finish, exactly as it must; it is not a defect, and
// a journey must not wait for a state the product is right to never reach.

import { readFileSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

/** crates/osg-engine-packages/src/manager.rs:40 (`MIN_FREE_RESERVE_BYTES`). */
export const MIN_FREE_RESERVE_BYTES = 256 * 1024 * 1024;

export const SPEECH_DELIVERY_CATALOG = resolve(
  import.meta.dirname, '..', '..', 'crates', 'osg-speech', 'delivery', 'speech-packages.delivery.json',
);

/** crates/osg-engine-packages/src/catalog.rs:646-654 (`current_platform`). */
const DELIVERY_PLATFORMS = Object.freeze({
  'win32:x64': 'windows-x86_64',
  'linux:x64': 'linux-x86_64',
  'darwin:x64': 'macos-x86_64',
  'darwin:arm64': 'macos-aarch64',
});

export const deliveryPlatform = (platform = process.platform, arch = process.arch) => (
  DELIVERY_PLATFORMS[`${platform}:${arch}`] ?? null
);

/**
 * What the running product would require on disk to install one speech backend on this host.
 *
 * `deliveryAvailable: false` mirrors an empty catalog entry, which is a deliberate blocker: the
 * product offers no Install at all there, and a journey must assert that refusal rather than
 * manufacture one.
 */
export const speechPackageInstallRequirement = (backendId, {
  platform = deliveryPlatform(),
  catalogPath = SPEECH_DELIVERY_CATALOG,
} = {}) => {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const backend = platform === null
    ? undefined
    : catalog.platforms?.[platform]?.backends?.find(({ id }) => id === backendId);
  // catalog.rs:235-237: `current()` is `releases.first()`, in catalog order -- not a version sort.
  const release = backend?.releases?.[0] ?? null;
  if (release === null) {
    return Object.freeze({
      platform, backendId, deliveryAvailable: false, version: null,
      downloadBytes: 0, unpackedBytes: 0, requiredBytes: 0,
    });
  }
  return Object.freeze({
    platform,
    backendId,
    deliveryAvailable: true,
    version: release.version,
    downloadBytes: release.sizeBytes,
    unpackedBytes: release.unpackedSizeBytes,
    requiredBytes: release.sizeBytes + release.unpackedSizeBytes + MIN_FREE_RESERVE_BYTES,
  });
};

/**
 * Free bytes on the volume holding `path`, matching what `fs2::available_space` reads natively
 * (the caller-available free space, not the raw filesystem free space).
 */
export const availableStoreBytes = (path) => {
  const { bavail, bsize } = statfsSync(path);
  return bavail * bsize;
};
