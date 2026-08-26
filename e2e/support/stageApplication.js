import { Buffer } from 'node:buffer';
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

import {
  E2E_STAGING_ROOT, assertStagedApplicationBinary, readVerifiedPublishedApplication,
  writeStagedApplicationMarker, writeStagedApplicationParentMarker,
} from './environment.js';

const require = createRequire(import.meta.url);
const { assertWindowsProcessIdentity } = require('../../scripts/windows-process-identity.js');

/**
 * A throwaway copy of the verified immutable application publication, so a journey can damage
 * what it ships.
 *
 * The managed font is now part of the payload, which makes "the shipped bytes are wrong" a real
 * failure mode that no unit test can reach: it lives in the relationship between the resources on
 * disk, the digests the delivery catalog pins, and what the application does when they disagree.
 * Damaging the shared publication directly would break every other journey, so each of these runs
 * against its own copy laid out exactly as an installation is.
 *
 * Deliberately a copy and not a mount or a symlink: the application must resolve its resources by
 * the same `resource_dir()` path it uses in production, with no indirection that could change what
 * is being tested.
 */

const copyVerifiedTree = (source, destination) => {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const input = join(source, entry.name);
    const output = join(destination, entry.name);
    const status = lstatSync(input);
    if (entry.isSymbolicLink() || status.isSymbolicLink()) {
      throw new Error(`The verified E2E publication changed into a link while staging: ${input}`);
    }
    if (entry.isDirectory() && status.isDirectory()) {
      mkdirSync(output, { mode: 0o700 });
      copyVerifiedTree(input, output);
    } else if (entry.isFile() && status.isFile() && status.nlink === 1) {
      copyFileSync(input, output);
    } else {
      throw new Error(`The verified E2E publication changed into an unsafe entry: ${input}`);
    }
  }
};

/** Copy the binary and its resources into a fresh directory, returning that directory. */
export const stageApplication = ({
  applicationLease,
  stagingLease,
  testStagingRoot = null,
} = {}) => {
  let staged = null;
  try {
    let parent;
    if (testStagingRoot !== null) {
      if (!process.env.NODE_TEST_CONTEXT || !isAbsolute(testStagingRoot)) {
        throw new Error('private staged-application roots are test-only');
      }
      parent = resolve(testStagingRoot);
      mkdirSync(parent, { recursive: true });
    } else {
      if (
        applicationLease === null
        || typeof applicationLease !== 'object'
        || stagingLease === null
        || typeof stagingLease !== 'object'
        || resolve(stagingLease.stagingRoot ?? '') !== resolve(E2E_STAGING_ROOT)
      ) {
        throw new Error('staging an application requires live application and staging leases');
      }
      const stagingMarker = JSON.parse(readFileSync(join(E2E_STAGING_ROOT, '.osg-cache-lease'), 'utf8'));
      if (
        stagingMarker.leaseId !== stagingLease.leaseId
        || stagingMarker.processId !== process.pid
        || stagingMarker.laneGroup !== 'staging'
        || stagingMarker.processCreatedUtc !== stagingLease.leaseOwnerProcessCreatedUtc
      ) {
        throw new Error('the staged-application lease is not active for this process');
      }
      try {
        assertWindowsProcessIdentity({
          processId: stagingMarker.processId,
          processCreatedUtc: stagingMarker.processCreatedUtc,
        });
      } catch (error) {
        throw new Error('the staged-application lease owner identity is stale or was reused', {
          cause: error,
        });
      }
      parent = E2E_STAGING_ROOT;
    }
    const publication = readVerifiedPublishedApplication();
    if (
      testStagingRoot === null
      && publication.applicationRoot !== join(
        applicationLease.applicationsCacheRoot,
        'applications',
        publication.applicationHash,
      )
    ) {
      throw new Error('the application lease does not cover the publication being staged');
    }
    staged = mkdtempSync(join(realpathSync.native(parent), 'osg-e2e-app-'));
    writeStagedApplicationParentMarker({ stagedRoot: staged, stagingParent: parent });
    copyVerifiedTree(publication.applicationRoot, staged);
    const afterCopy = readVerifiedPublishedApplication();
    if (
      afterCopy.applicationHash !== publication.applicationHash
      || afterCopy.applicationRoot !== publication.applicationRoot
    ) {
      throw new Error('The current E2E application publication changed while it was being staged');
    }
    writeStagedApplicationMarker({ stagedRoot: staged, publication });
    assertStagedApplicationBinary(join(staged, 'osg-desktop.exe'));
    return staged;
  } catch (error) {
    if (staged !== null) rmSync(staged, { recursive: true, force: true, maxRetries: 5 });
    throw error;
  }
};

/** The staged binary path, for `OSG_E2E_BINARY`. */
export const stagedBinary = (staged) => join(staged, 'osg-desktop.exe');

/** Every managed font resource in a staged copy, named by the digest it claims to be. */
export const stagedFontResources = (staged) => {
  try {
    return readdirSync(join(staged, 'ui-fonts'), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/**
 * Replace one shipped font resource with bytes that do not hash to its name.
 *
 * The original LENGTH is preserved, so only the digest can tell the difference. A check that
 * compared sizes would accept this file, which is exactly the weakness content addressing closes,
 * and a corruption of a different length would not test it.
 */
export const corruptFontResource = (staged, name) => {
  const path = join(staged, 'ui-fonts', name);
  const original = statSync(path).size;
  writeFileSync(path, Buffer.alloc(original, 0x41));
  return original;
};

/** Remove one shipped font resource entirely. */
export const removeFontResource = (staged, name) => {
  rmSync(join(staged, 'ui-fonts', name), { force: true });
};

export const discardStagedApplication = (staged) => {
  if (typeof staged !== 'string' || !isAbsolute(staged)) {
    throw new Error('discarding a staged application requires its exact absolute root');
  }
  const requestedRoot = resolve(staged);
  const authority = assertStagedApplicationBinary(join(requestedRoot, 'osg-desktop.exe'));
  if (authority.root !== requestedRoot) {
    throw new Error('the staged-application deletion capability changed root');
  }
  rmSync(requestedRoot, { recursive: true, force: true, maxRetries: 5 });
};
