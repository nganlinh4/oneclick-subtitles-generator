import {
  copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILT_APPLICATION_DIRECTORY } from './environment.js';

/**
 * A throwaway copy of the built application, so a journey can damage what it ships.
 *
 * The managed font is now part of the payload, which makes "the shipped bytes are wrong" a real
 * failure mode that no unit test can reach: it lives in the relationship between the resources on
 * disk, the digests the delivery catalog pins, and what the application does when they disagree.
 * Damaging the build output directly would break every other journey, so each of these runs against
 * its own copy laid out exactly as an installation is.
 *
 * Deliberately a copy and not a mount or a symlink: the application must resolve its resources by
 * the same `resource_dir()` path it uses in production, with no indirection that could change what
 * is being tested.
 */

const RESOURCE_DIRECTORIES = ['ui-fonts', 'workers', 'licenses'];

/** Copy the binary and its resources into a fresh directory, returning that directory. */
export const stageApplication = () => {
  const staged = mkdtempSync(join(tmpdir(), 'osg-e2e-app-'));
  copyFileSync(
    join(BUILT_APPLICATION_DIRECTORY, 'osg-desktop.exe'),
    join(staged, 'osg-desktop.exe'),
  );
  for (const directory of RESOURCE_DIRECTORIES) {
    const source = join(BUILT_APPLICATION_DIRECTORY, directory);
    let entries;
    try {
      entries = readdirSync(source, { withFileTypes: true });
    } catch {
      // Not every layout ships every directory; a missing one is not this helper's business.
      continue;
    }
    mkdirSync(join(staged, directory), { recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) copyFileSync(join(source, entry.name), join(staged, directory, entry.name));
    }
  }
  return staged;
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
  rmSync(staged, { recursive: true, force: true, maxRetries: 5 });
};
