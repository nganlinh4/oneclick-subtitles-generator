const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GIT_OBJECT_PATTERN = /^[0-9a-f]{40,64}$/u;

const samePath = (left, right) => (
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right)
);

const readCleanGitSourceProvenance = ({ repositoryRoot, spawn = spawnSync }) => {
  const runGit = (...args) => {
    const result = spawn('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} exited with ${result.status}: ${result.stderr}`);
    }
    return String(result.stdout).trim();
  };
  const topLevel = path.resolve(runGit('rev-parse', '--show-toplevel'));
  if (!samePath(topLevel, repositoryRoot)) {
    throw new Error('E2E build repository root does not match Git top-level');
  }
  const dirty = runGit('status', '--porcelain=v1', '--untracked-files=all');
  if (dirty !== '') {
    throw new Error(`E2E application source tree must be clean before publication:\n${dirty}`);
  }
  const commit = runGit('rev-parse', '--verify', 'HEAD');
  const tree = runGit('rev-parse', '--verify', 'HEAD^{tree}');
  if (!GIT_OBJECT_PATTERN.test(commit) || !GIT_OBJECT_PATTERN.test(tree)) {
    throw new Error('Git returned an invalid E2E source commit or tree identity');
  }
  return Object.freeze({ commit, tree, dirty: false });
};

module.exports = { readCleanGitSourceProvenance };
