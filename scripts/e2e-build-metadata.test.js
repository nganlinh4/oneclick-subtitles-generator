const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  collectStrictReproducibleGitInfo,
  formatGitVersionUtc,
  renderVersionModule,
} = require('./e2e-build-metadata');

const validGitValues = new Map([
  ['rev-parse\0HEAD', '0123456789abcdef0123456789abcdef01234567'],
  ['rev-parse\0--short\0HEAD', '0123456'],
  ['log\0-1\0--format=%cI', '2026-08-25T17:40:24+09:00'],
  ['log\0-1\0--format=%ct', '1787647224'],
  ['rev-parse\0--abbrev-ref\0HEAD', 'rewrite/tauri-rust'],
  ['log\0-1\0--format=%s', 'quotes \' " slash \\ and </script>'],
  ['log\0-1\0--format=%an', 'Author\u2028Name'],
  ['log\0-1\0--format=%ae', 'author@example.test'],
]);

const fakeGit = (_repository, args) => validGitValues.get(args.join('\0'));

test('reproducible metadata fails closed when Git is absent or incomplete', () => {
  assert.throws(() => collectStrictReproducibleGitInfo({
    repositoryRoot: path.resolve('.'),
    runGit: () => { throw new Error('git missing'); },
  }), /requires Git field hash/u);
  assert.throws(() => collectStrictReproducibleGitInfo({
    repositoryRoot: path.resolve('.'),
    runGit: () => '',
  }), /requires nonempty Git field hash/u);
});

test('the default reproducible collector refuses an actual directory without Git', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-e2e-no-git-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => collectStrictReproducibleGitInfo({ repositoryRoot: root }),
    /requires Git field hash/u,
  );
});

test('the entire generated module is byte-identical in UTC and Asia/Seoul', () => {
  const modulePath = path.resolve(__dirname, 'e2e-build-metadata.js');
  const script = `
    const metadata = require(${JSON.stringify(modulePath)});
    const info = {
      hash: '0123456789abcdef0123456789abcdef01234567',
      shortHash: '0123456',
      date: '2026-08-25T17:40:24+09:00',
      timestamp: 1787647224,
      branch: 'rewrite/tauri-rust',
      message: 'timezone proof',
      author: { name: 'Tester', email: 'test@example.test' },
      isClean: false,
      buildTime: '2026-08-25T17:40:24+09:00',
      version: metadata.formatGitVersionUtc('2026-08-25T17:40:24+09:00', '0123456'),
    };
    process.stdout.write(Buffer.from(metadata.renderVersionModule(info)).toString('base64'));
  `;
  const render = (timezone) => execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: timezone },
  });
  assert.equal(render('UTC'), render('Asia/Seoul'));
  assert.equal(formatGitVersionUtc('2026-08-25T17:40:24+09:00', '0123456'), '2026.08.25-084024-0123456');
});

test('metadata serialization preserves hostile Git text as inert JSON data', async () => {
  const info = collectStrictReproducibleGitInfo({
    repositoryRoot: path.resolve('.'),
    runGit: fakeGit,
  });
  const moduleBytes = renderVersionModule(info);
  assert.match(moduleBytes, /\\u2028/u);
  const imported = await import(`data:text/javascript;base64,${Buffer.from(moduleBytes).toString('base64')}`);
  assert.deepEqual(JSON.parse(JSON.stringify(imported.default)), JSON.parse(JSON.stringify(info)));
  assert.equal(imported.default.message, validGitValues.get('log\0-1\0--format=%s'));
});
