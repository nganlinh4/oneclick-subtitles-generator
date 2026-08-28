// Makes e2e/inventory.json mechanically checkable instead of hand-maintained prose. For every
// journey claiming "green" it re-derives the truth from the same evidence store the harness
// writes (evidence/<workflow>/attempts/<attemptId>/manifest.json) and the e2e application store
// (apps/e2e/applications/<applicationHash>/), then reports:
//   - the generated status counts (green/unproven/planned/...), to compare against any
//     hand-maintained tally elsewhere in the repo or in review notes;
//   - every green entry whose claim cannot be bound to (a) an existing, passing attempt and
//     (b) a binary digest that the manifest for that attempt actually recorded.
//
// This script only reads the evidence and application-store directories -- it never writes,
// deletes or prunes anything under either cache, and it never launches the desktop application.
//
// A green journey binds to evidence through three explicit inventory fields:
//   "evidenceWorkflow": the evidence/<workflow> directory name
//   "attemptId":        the attempt directory under evidence/<workflow>/attempts/
//   "binaryDigest":      the exe SHA-256 that attempt's manifest recorded (provenance.binary.sha256)
// A green entry whose "runsAgainst" is "installed-production-binary" is proven on a separate,
// isolated Windows CI runner (see installedGolden's own note); this script has no access to that
// evidence and does not claim to verify it either way.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const INVENTORY_PATH = join(import.meta.dirname, '..', 'inventory.json');

const DEVELOPMENT_CACHE_ROOT = process.env.OSG_DEV_CACHE_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'OSG-Development', 'cache');
const EVIDENCE_ROOT = process.env.OSG_E2E_EVIDENCE_ROOT
  ?? join(DEVELOPMENT_CACHE_ROOT, 'evidence');
const APPLICATIONS_ROOT = process.env.OSG_E2E_APPLICATIONS_ROOT
  ?? join(DEVELOPMENT_CACHE_ROOT, 'apps', 'e2e', 'applications');

const EXTERNAL_EVIDENCE_RUNS_AGAINST = new Set(['installed-production-binary']);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const directoryNames = (root) => {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

/**
 * Every exe SHA-256 currently retained by the e2e application store, read from each publication's
 * own manifest rather than re-hashing a ~28 MB binary per lookup.
 */
const liveApplicationBinaries = () => {
  const digests = new Set();
  for (const applicationHash of directoryNames(APPLICATIONS_ROOT)) {
    const manifestPath = join(APPLICATIONS_ROOT, applicationHash, '.osg-application-manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch {
      continue;
    }
    const entrypoint = manifest.files?.find((file) => file.path === (manifest.entrypoint ?? 'osg-desktop.exe'));
    if (entrypoint?.sha256) digests.add(entrypoint.sha256);
  }
  return digests;
};

/**
 * Binds one green journey entry to real evidence. Returns { ok: true, binaryLive } or
 * { ok: false, reason }. Never throws -- a malformed reference is a binding failure, not a crash.
 */
const bindGreenEntry = (entry, liveBinaries) => {
  if (EXTERNAL_EVIDENCE_RUNS_AGAINST.has(entry.runsAgainst)) {
    return { ok: true, external: true };
  }
  const { attemptId, binaryDigest, evidenceWorkflow, name } = entry;
  if (!evidenceWorkflow || !attemptId || !binaryDigest) {
    return {
      ok: false,
      reason: `"${name}" is green but is missing evidenceWorkflow/attemptId/binaryDigest`,
    };
  }
  const manifestPath = join(EVIDENCE_ROOT, evidenceWorkflow, 'attempts', attemptId, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      reason: `"${name}" names attempt ${evidenceWorkflow}/attempts/${attemptId}, which does not exist`,
    };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return { ok: false, reason: `"${name}" attempt manifest is not valid JSON: ${error.message}` };
  }
  if (manifest.attempt?.outcome !== 'pass') {
    return {
      ok: false,
      reason: `"${name}" attempt ${attemptId} recorded outcome "${manifest.attempt?.outcome}", not "pass"`,
    };
  }
  const recordedBinary = manifest.provenance?.binary?.sha256;
  if (recordedBinary !== binaryDigest) {
    return {
      ok: false,
      reason: `"${name}" claims binaryDigest ${binaryDigest.slice(0, 12)}… but attempt ${attemptId} `
        + `recorded ${String(recordedBinary).slice(0, 12)}…`,
    };
  }
  return { ok: true, binaryLive: liveBinaries.has(binaryDigest) };
};

const main = () => {
  const inventory = readJson(INVENTORY_PATH);
  const liveBinaries = liveApplicationBinaries();

  const counts = {};
  const failures = [];
  const bound = [];
  const external = [];

  for (const entry of inventory.journeys ?? []) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    if (entry.status !== 'green') continue;
    const result = bindGreenEntry(entry, liveBinaries);
    if (!result.ok) {
      failures.push(result.reason);
    } else if (result.external) {
      external.push(entry.name);
    } else {
      bound.push({ name: entry.name, binaryLive: result.binaryLive });
    }
  }

  process.stdout.write('=== e2e/inventory.json verification ===\n\n');
  process.stdout.write(`evidence root:      ${EVIDENCE_ROOT}\n`);
  process.stdout.write(`applications root:  ${APPLICATIONS_ROOT}\n`);
  process.stdout.write(`applications store currently retains ${liveBinaries.size} exe digest(s)\n\n`);

  process.stdout.write('-- generated status counts (compare against any hand-written tally) --\n');
  for (const status of Object.keys(counts).sort()) {
    process.stdout.write(`  ${status.padEnd(12)} ${counts[status]}\n`);
  }
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  process.stdout.write(`  ${'total'.padEnd(12)} ${total}\n\n`);

  process.stdout.write(`-- green entries bound to a passing local attempt: ${bound.length} --\n`);
  for (const { binaryLive, name } of bound) {
    const liveMarker = binaryLive ? 'binary still in applications store' : 'binary since rotated out (historical evidence only)';
    process.stdout.write(`  OK   ${name} (${liveMarker})\n`);
  }
  process.stdout.write('\n');

  if (external.length > 0) {
    process.stdout.write(`-- green entries proven by evidence this script cannot see: ${external.length} --\n`);
    for (const name of external) {
      process.stdout.write(`  --   ${name} (runsAgainst is not e2e-binary; see its own note)\n`);
    }
    process.stdout.write('\n');
  }

  if (failures.length > 0) {
    process.stdout.write(`-- green entries that FAILED binding: ${failures.length} --\n`);
    for (const reason of failures) process.stdout.write(`  FAIL ${reason}\n`);
    process.stdout.write('\n');
    process.stdout.write(`verify-inventory: ${failures.length} green claim(s) could not be bound to evidence.\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write('verify-inventory: every green claim is bound to a passing local attempt.\n');
};

main();
