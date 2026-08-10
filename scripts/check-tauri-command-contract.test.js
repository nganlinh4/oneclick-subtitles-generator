const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INTENTIONALLY_UNWIRED_COMMANDS,
  analyzeFrontendCommandReachability,
  assertFrontendCommandReachability,
} = require('./check-tauri-command-contract');

const classifiedCommands = [...INTENTIONALLY_UNWIRED_COMMANDS.keys()];

const analysisFor = ({ references = {}, directInvocations = {} } = {}) => ({
  visited: new Set(),
  references: new Map([
    ...classifiedCommands.map((command) => [command, new Set()]),
    ...Object.entries(references).map(([command, locations]) => [command, new Set(locations)]),
  ]),
  directInvocations: new Map(
    Object.entries(directInvocations).map(([command, locations]) => [command, new Set(locations)]),
  ),
});

test('rejects any dormant registered command without an explicit reviewed classification', () => {
  const commands = [...classifiedCommands, 'jobs_list', 'unexpected_dormant_command'];
  const analysis = analysisFor({ references: { jobs_list: ['src/recovery.js'] } });
  analysis.references.set('unexpected_dormant_command', new Set());

  assert.throws(
    () => assertFrontendCommandReachability({ commands, analysis }),
    /unexpected_dormant_command/,
  );
});

test('rejects direct frontend invocations that are absent from the registered host contract', () => {
  const commands = [...classifiedCommands, 'jobs_list'];
  const analysis = analysisFor({
    references: { jobs_list: ['src/recovery.js'] },
    directInvocations: { ghost_command: ['src/hostile.js'] },
  });

  assert.throws(
    () => assertFrontendCommandReachability({ commands, analysis }),
    /unregistered Tauri command: ghost_command/,
  );
});

test('keeps the registered command surface free of reviewed reachability exceptions', () => {
  assert.deepEqual(classifiedCommands, []);
});

test('traces static, re-exported, and lazy production modules but ignores dormant files', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'osg-command-reachability-'));
  try {
    fs.mkdirSync(path.join(fixture, 'src'));
    fs.writeFileSync(path.join(fixture, 'src/index.js'), [
      "import './reachable.js';",
      "export * from './reexport.js';",
      "import('./lazy.js');",
    ].join('\n'));
    fs.writeFileSync(path.join(fixture, 'src/reachable.js'), "invokeDesktop('jobs_list', {});\n");
    fs.writeFileSync(path.join(fixture, 'src/reexport.js'), "export const command = 'job_get';\n");
    fs.writeFileSync(path.join(fixture, 'src/lazy.js'), "invokeCommand('job_cancel', {});\n");
    fs.writeFileSync(path.join(fixture, 'src/dormant.js'), "invokeDesktop('database_health', {});\n");

    const analysis = analyzeFrontendCommandReachability({
      repositoryRoot: fixture,
      commands: ['jobs_list', 'job_get', 'job_cancel', 'database_health'],
    });

    assert.deepEqual([...analysis.references.get('jobs_list')], ['src/reachable.js']);
    assert.deepEqual([...analysis.references.get('job_get')], ['src/reexport.js']);
    assert.deepEqual([...analysis.references.get('job_cancel')], ['src/lazy.js']);
    assert.equal(analysis.references.get('database_health').size, 0);
    assert.deepEqual([...analysis.directInvocations.get('jobs_list')], ['src/reachable.js']);
    assert.deepEqual([...analysis.directInvocations.get('job_cancel')], ['src/lazy.js']);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
