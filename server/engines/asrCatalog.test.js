const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('./asrCatalog');
const { modelLooksComplete } = require('./installers/asrInstaller');

test('ASR catalog ids, ports, and environment keys are unique', () => {
  assert.equal(new Set(catalog.ids()).size, catalog.ROWS.length);
  assert.equal(new Set(catalog.ROWS.map((row) => row.port)).size, catalog.ROWS.length);
  assert.equal(new Set(catalog.ROWS.map((row) => row.portEnv)).size, catalog.ROWS.length);
});

test('every ASR catalog entry points at a packaged source file and pinned dependencies', () => {
  for (const row of catalog.ROWS) {
    assert.equal(fs.existsSync(catalog.entryFile(row)), true, `${row.id} entry file is missing`);
    assert.equal(path.isAbsolute(catalog.modelDir(row.id)), true);
    assert.match(row.modelScopeRevision, /^[a-f0-9]{40}$/);
    assert.ok(row.minModelBytes > 0);
    for (const dep of row.pyDeps) assert.match(dep, /==/);
  }
});

test('frontend and backend ASR catalogs contain the same engine ids', () => {
  const frontend = fs.readFileSync(path.join(catalog.projectRoot, 'src/services/engines/asrEngines.js'), 'utf8');
  const frontendIds = [...frontend.matchAll(/^\s+id: '([^']+)',/gm)].map((match) => match[1]);
  assert.deepEqual(frontendIds, catalog.ids());
});

test('Electron packaging includes the ASR sidecar source tree', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(catalog.projectRoot, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('asr_services/**/*'));
});

test('port overrides stay consistent across config, health, spawn, and CORS', () => {
  const row = catalog.ROWS[0];
  const previous = process.env[row.portEnv];
  process.env[row.portEnv] = '41339';
  try {
    assert.equal(catalog.portFor(row), 41339);
    assert.equal(catalog.portsConfig()[row.portEnv.replace(/_PORT$/, '')], 41339);
    assert.equal(catalog.engineDefs().find((item) => item.id === row.id).port, 41339);
    const spawn = catalog.spawnEntries()[row.id];
    assert.equal(spawn.port, 41339);
    assert.equal(spawn.extraEnv.ASR_PORT, '41339');
    assert.ok(catalog.corsOrigins().includes('http://127.0.0.1:41339'));
  } finally {
    if (previous === undefined) delete process.env[row.portEnv];
    else process.env[row.portEnv] = previous;
  }
});

test('installed ASR model directories pass the completeness guard when present', () => {
  for (const row of catalog.ROWS) {
    const dir = catalog.modelDir(row.id);
    if (fs.existsSync(dir)) assert.equal(modelLooksComplete(dir, row.minModelBytes), true, row.id);
  }
  const alignerRow = catalog.ROWS.find((row) => row.alignerModelScopeId);
  const aligner = catalog.alignerDir();
  if (alignerRow && fs.existsSync(aligner)) {
    assert.equal(modelLooksComplete(aligner, alignerRow.alignerMinModelBytes), true, 'forced aligner');
  }
});

test('a nonempty but partial model directory is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-asr-partial-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'model.safetensors'), Buffer.alloc(32));
    assert.equal(modelLooksComplete(dir, 1000), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
