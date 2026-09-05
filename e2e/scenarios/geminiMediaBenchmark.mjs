import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createRunRoot, removeRunRoot, runRootAuthorization } from '../support/environment.js';
import { runScenarioAttemptWithEvidence, runScenarioProcesses, withScenarioLeases } from '../support/twoProcessScenario.js';

// Explicit opt-in command: runs billed customer workflows, never part of the default suite.
// References stay in the Node test process; they are never supplied to the app or provider.
const fixtureRoot = resolve('target/subtitle-benchmark/real-video');
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
const catalog = JSON.parse(readFileSync('src/config/geminiModelCatalog.json', 'utf8'));
const [caseFilter = 'all', modelFilter = 'all', modeFilter = 'all'] = process.argv.slice(2);
const fixtures = manifest.cases.filter(item => caseFilter === 'all' || item.id === caseFilter);
const models = catalog.models.filter(item => modelFilter === 'all' || item.id === modelFilter);
const modes = ['video', 'audio'].filter(mode => modeFilter === 'all' || mode === modeFilter);
assert.ok(fixtures.length && models.length && modes.length, 'Unknown benchmark case, model, or mode');
const checked = (name, digest) => {
  assert.equal(name, name.split(/[\\/]/).at(-1), 'Fixture must be a direct child');
  const path = join(fixtureRoot, name);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), digest, `Changed fixture: ${name}`);
  return path;
};

withScenarioLeases(({ inheritedApplication, managedPaths, publication, stagingLease }) => {
  for (const fixture of fixtures) for (const model of models) for (const mode of modes) {
    const root = createRunRoot({ stagingLease });
    const authorization = runRootAuthorization(root);
    const spec = './journeys/geminiMediaBenchmark.journey.js';
    const label = `Gemini media benchmark ${fixture.id} ${model.id} ${mode}`;
    try {
      const succeeded = runScenarioAttemptWithEvidence({ label, publication, root, spec,
        operation: () => {
          const source = checked(fixture.file, fixture.sha256);
          const reference = JSON.parse(readFileSync(checked(fixture.reference, fixture.referenceSha256), 'utf8'));
          const stagedMediaSelection = join(root, 'input', fixture.file);
          copyFileSync(source, stagedMediaSelection);
          writeFileSync(join(root, 'input', 'benchmark.json'), JSON.stringify({
            fixture: fixture.id, model: model.id, mode, reference,
            durationSeconds: fixture.durationSeconds, sourceSha256: fixture.sha256,
          }));
          return runScenarioProcesses({ label, root, phases: ['seed'], spec,
            stagedMediaSelection, inheritedApplication, managedPaths, publication });
        },
      });
      if (!succeeded) process.exitCode = 1;
    } finally {
      removeRunRoot(root, authorization);
      delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    }
  }
});
