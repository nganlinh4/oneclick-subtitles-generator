import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createRunRoot, removeRunRoot, runRootAuthorization } from '../support/environment.js';
import { runScenarioAttemptWithEvidence, runScenarioProcesses, withScenarioLeases } from '../support/twoProcessScenario.js';
import { WORKFLOW_EVIDENCE_ROOT } from '../support/workflowEvidence.js';

// Explicit opt-in command: runs billed customer workflows, never part of the default suite.
// References stay in the Node test process; they are never supplied to the app or provider.
const catalog = JSON.parse(readFileSync('src/config/geminiModelCatalog.json', 'utf8'));
const [caseFilter = 'all', modelFilter = 'all', modeFilter = 'all', minutes = '10',
  preset = 'general', frameRate = '0.25', fixtureSet = 'real-video', exercise = 'success'] = process.argv.slice(2);
assert.ok(['success', 'cancel-retry', 'missing-audio'].includes(exercise), 'Unknown recovery exercise');
assert.ok(['real-video', 'additional-media'].includes(fixtureSet), 'Unknown fixture set');
const fixtureRoot = resolve('target/subtitle-benchmark', fixtureSet);
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'manifest.json'), 'utf8'));
assert.ok(['general', 'extract-text', 'focus-lyrics', 'describe-video', 'translate-directly',
  'chaptering', 'diarize-speakers'].includes(preset), 'Unknown preset');
const fps = Number(frameRate);
assert.ok(Number.isFinite(fps) && fps >= 0.25 && fps <= 5 && Number.isInteger(fps * 4), 'Unsupported UI frame rate');
const requestMinutes = Number(minutes);
assert.ok(Number.isInteger(requestMinutes) && requestMinutes >= 1 && requestMinutes <= 30);
const fixtures = manifest.cases.filter(item => caseFilter === 'all' || item.id === caseFilter);
const models = catalog.models.filter(item => modelFilter === 'all' || item.id === modelFilter);
const modes = ['video', 'audio'].filter(mode => modeFilter === 'all' || mode === modeFilter);
assert.ok(fixtures.length && models.length && modes.length, 'Unknown benchmark case, model, or mode');
const archiveRoot = resolve('target/subtitle-benchmark/ui-runs', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(archiveRoot, { recursive: true });
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
            fixture: fixture.id, model: model.id, mode, reference, requestMinutes, preset, fps, exercise,
            durationSeconds: fixture.durationSeconds, sourceSha256: fixture.sha256,
          }));
          return runScenarioProcesses({ label, root, phases: ['seed'], spec,
            stagedMediaSelection, inheritedApplication, managedPaths, publication });
        },
      });
      // The general harness retains only three recent attempts per workflow. Preserve
      // every matrix cell here before the next attempt can age it out, including failures.
      const attemptId = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
      assert.match(attemptId, /^\d{17}-\d{1,10}-[0-9a-f]{8}$/u);
      cpSync(join(WORKFLOW_EVIDENCE_ROOT, 'gemini-media-benchmark', 'attempts', attemptId),
        join(archiveRoot, `${fixture.id}-${model.id}-${mode}`), { recursive: true, errorOnExist: true, force: false });
      if (!succeeded) process.exitCode = 1;
    } finally {
      removeRunRoot(root, authorization);
      delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    }
  }
});
