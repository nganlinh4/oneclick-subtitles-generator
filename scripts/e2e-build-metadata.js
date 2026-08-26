#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const REQUIRED_GIT_FIELDS = Object.freeze([
  ['hash', ['rev-parse', 'HEAD']],
  ['shortHash', ['rev-parse', '--short', 'HEAD']],
  ['date', ['log', '-1', '--format=%cI']],
  ['timestamp', ['log', '-1', '--format=%ct']],
  ['branch', ['rev-parse', '--abbrev-ref', 'HEAD']],
  ['message', ['log', '-1', '--format=%s']],
  ['authorName', ['log', '-1', '--format=%an']],
  ['authorEmail', ['log', '-1', '--format=%ae']],
]);

const defaultGitRunner = (repositoryRoot, args) => execFileSync('git', args, {
  cwd: repositoryRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
}).trim();

const requiredGitValue = (runGit, repositoryRoot, field, args) => {
  let value;
  try {
    value = runGit(repositoryRoot, args);
  } catch (error) {
    throw new Error(`reproducible E2E metadata requires Git field ${field}`, { cause: error });
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`reproducible E2E metadata requires nonempty Git field ${field}`);
  }
  return value;
};

const formatGitVersionUtc = (dateString, shortHash) => {
  const date = new Date(dateString);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`reproducible E2E metadata has an invalid commit date: ${dateString}`);
  }
  const fields = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
  ];
  return `${fields[0]}.${fields[1]}.${fields[2]}-${fields[3]}${fields[4]}${fields[5]}-${shortHash}`;
};

const collectStrictReproducibleGitInfo = ({ repositoryRoot, runGit = defaultGitRunner }) => {
  if (!path.isAbsolute(repositoryRoot)) {
    throw new Error('repositoryRoot must be absolute');
  }
  const raw = Object.fromEntries(REQUIRED_GIT_FIELDS.map(([field, args]) => (
    [field, requiredGitValue(runGit, repositoryRoot, field, args)]
  )));
  if (!/^[0-9a-f]{40,64}$/u.test(raw.hash)) {
    throw new Error('reproducible E2E metadata requires a full hexadecimal Git hash');
  }
  if (!/^[0-9a-f]{7,64}$/u.test(raw.shortHash) || !raw.hash.startsWith(raw.shortHash)) {
    throw new Error('reproducible E2E metadata has an inconsistent short Git hash');
  }
  if (!/^\d+$/u.test(raw.timestamp)) {
    throw new Error('reproducible E2E metadata requires an integer Git timestamp');
  }
  const timestamp = Number(raw.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('reproducible E2E metadata Git timestamp is out of range');
  }
  const parsedDate = new Date(raw.date);
  if (!Number.isFinite(parsedDate.getTime())) {
    throw new Error('reproducible E2E metadata requires a valid Git commit date');
  }
  return Object.freeze({
    hash: raw.hash,
    shortHash: raw.shortHash,
    date: raw.date,
    timestamp,
    branch: raw.branch,
    message: raw.message,
    author: Object.freeze({
      name: raw.authorName,
      email: raw.authorEmail,
    }),
    // This profile is deliberately nonshipping. It must never describe an E2E binary as a
    // clean release, and it must not read the changing worktree just to produce build bytes.
    isClean: false,
    buildTime: raw.date,
    version: formatGitVersionUtc(raw.date, raw.shortHash),
  });
};

const jsonForJavaScript = (value) => JSON.stringify(value, null, 2)
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');

const renderVersionModule = (versionInfo) => (
  '// Auto-generated immutable E2E version metadata.\n'
  + '// The production src/config/version.js file is not mutated by this build.\n\n'
  + `const versionInfo = Object.freeze(${jsonForJavaScript(versionInfo)});\n\n`
  + 'export default versionInfo;\n'
);

module.exports = {
  collectStrictReproducibleGitInfo,
  defaultGitRunner,
  formatGitVersionUtc,
  renderVersionModule,
};
